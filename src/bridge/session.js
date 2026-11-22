/*
 * Session Coordinator: holds the Active Session and decides whether a
 * Candidate Session replaces it (GLOSSARY.md, docs/adr/0002). Session
 * Sources hand in candidates; requests carry the Active Session through
 * forUrl() (src/api/credentials.js).
 *
 * A Session is {source, host, cookie, ua}: source 'bridge' (Cookie Bridge)
 * or 'password' (Password Login); a Session saved by an earlier version
 * with source 'browser' (Built-in Browser Login, removed in #22) is still
 * checked and used like the others;
 * cookie is a Cookie header without cf_clearance, which belongs to the
 * Clearance (src/bridge/clearance.js, docs/adr/0003). The saved record adds
 * the last account name; the status of the last Session Check is kept in
 * memory only.
 */
var core = require('../../vendor/movian-cookie-bridge/bridge-core');
var movianSession = require('../../vendor/movian-cookie-bridge/movian-session');
var classify = movianSession.classify;
var challenged = movianSession.challenged;

/*
 * The Session Check page. Not index.php: Cloudflare does not challenge it,
 * so it answers with the logged-in view even without cf_clearance while
 * every forum and search page gets the 403 challenge. f=7 ("Зарубежное
 * кино") is a long-lived forum with a small first page.
 */
var CHECK_FORUM = 7;
var OFFICIAL = core.profile('rutracker').domains;

var SOURCE_TEXT = {
  browser: 'встроенный браузер', //  legacy: a Session saved before #22
  bridge: 'Cookie Bridge',
  password: 'вход по паролю',
};
var STATUS_TEXT = {
  authenticated: 'сайт принимает сессию',
  unchecked: 'проверяется...',
  challenge: 'ограниченный доступ: Cloudflare требует проверку в браузере',
  rejected: 'сайт не принял сессию (истекла или недействительна)',
  network_error: 'не проверена: сетевая ошибка',
  cancelled: 'проверка отменена: сессию забыли или очистили во время проверки, либо начат другой вход',
};

function official(host) {
  for (var i = 0; i < OFFICIAL.length; i++) {
    if (core.domainMatches(host, OFFICIAL[i])) return true;
  }
  return false;
}

//  Why a Candidate cannot be checked at all, or ''. A Cookie Bridge session
//  comes from the user's own browser and only ever goes to the official
//  domains; the others belong to the host they were made on.
function unusable(c) {
  if (!c || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(c.host || '')) return 'host';
  if (c.source === 'bridge' && !official(c.host)) return 'host';
  if (!/(^|;\s*)bb_session=[^;\s]/.test(c.cookie || '')) return 'incomplete';
  return '';
}

//  A Cookie header without its cf_clearance.
function withoutClearance(cookie) {
  return core.parseCookieHeader(cookie).filter(function (c) {
    return c.name !== 'cf_clearance';
  }).map(function (c) {
    return c.name + '=' + c.value;
  }).join('; ');
}

function forumOf(host) {
  return 'https://' + host + '/forum/';
}

exports.create = function (client, parser, clearance) {
  var store = require('movian/store').create('rutracker_session');
  var active = store.session && store.session.cookie ? store.session : null;
  var status = active ? 'unchecked' : 'empty';
  //  Moved on by a Forget or a Clear: a Candidate Check started before
  //  that is cancelled, one started after it is not (submit()).
  var generation = 0;
  //  Started submit() and recheck() calls: a later one cancels an earlier
  //  one still in flight (docs/adr/0002).
  var submits = 0;
  var rechecks = 0;

  function log(msg) {
    console.log('[rutracker_session] ' + msg);
  }

  function afterForget() {
    return !active && store.forgotten === true;
  }

  //  `forgotten` is set only by a user's Forget: it hides the Core Jar's
  //  login until a new Session is Active (credentials.js). It is kept in the
  //  store, so it survives a restart. A Clear does not set it.
  function save(session, forgotten) {
    active = session;
    //  store.js proxies have no delete trap: overwrite instead.
    store.session = session || '';
    store.forgotten = !session && !!forgotten;
  }

  //  The Clearance a request to `url` carries for `session` (null: the
  //  cookie jar): the held one, unless the Candidate brought its own
  //  cf_clearance, which is then the pair the request carried.
  function heldOf(session, url) {
    if (session && withoutClearance(session.cookie) !== session.cookie) return null;
    return clearance ? clearance.forUrl(url) : null;
  }

  //  `session` with the Clearance it travels with to `url`: a Candidate's
  //  own cf_clearance (with its UA) if it came with one, else the one the
  //  Clearance holds.
  function carried(session, url) {
    if (withoutClearance(session.cookie) !== session.cookie) return session;
    var pair = heldOf(session, url);
    if (!pair) return session;
    return {host: session.host, cookie: session.cookie ? session.cookie + '; ' + pair.cookie : pair.cookie, ua: pair.ua};
  }

  function checkUrl(session) {
    return session ? forumOf(session.host) + 'viewforum.php?f=' + CHECK_FORUM : client.url.subforum(CHECK_FORUM);
  }

  //  The Session Check page with `session` and its Clearance alone;
  //  without one, with whatever Movian's cookie jar sends. A Challenge on it
  //  drops the held Clearance the request carried, unless another one was
  //  held meanwhile (clearance.challengedWith), and only while the caller
  //  is still current: a cancelled check drops nothing.
  function checkPage(session, current) {
    var url = checkUrl(session);
    var held = heldOf(session, url);
    var res = session ? client.isolated(url, carried(session, url)) : client.fetch(url);
    if (res && clearance && challenged(res) && current()) clearance.challengedWith(url, held);
    return res;
  }

  function check(session, current) {
    var res = checkPage(session, current);
    //  Not followed: whatever it leads to, it is not the forum page.
    if (res && res.statuscode >= 300 && res.statuscode < 400) return {status: 'rejected', detail: 'redirect'};
    return classify(res, parser.loginName);
  }

  //  The result is for the Session the check started with: a Forget, Clear
  //  or hand-over during the wait makes it stale, and so does a newer
  //  recheck() that started meanwhile, so it is dropped.
  function recheck() {
    if (!active) return {status: 'empty'};
    var checked = active;
    var mine = ++rechecks;
    var current = function () { return active === checked && mine === rechecks; };
    var res = check(checked, current);
    if (!current()) {
      log(checked.source + ': recheck cancelled by a Forget, Clear, hand-over or a newer recheck');
      return {status: 'cancelled'};
    }
    status = res.status;
    if (res.user && res.user !== checked.user) save({source: checked.source, host: checked.host, cookie: checked.cookie, ua: checked.ua, user: res.user});
    log(checked.source + ': status=' + status + (res.user || res.detail ? ' (' + (res.user || res.detail) + ')' : ''));
    return res;
  }

  //  Who runs the start-up Session Check: the deferred timer (startup) or
  //  :start (onOpen), whichever comes first. A check already made is not
  //  repeated by the timer, so a page opened before it ran checks once.
  function startup() {
    if (active && status === 'unchecked') recheck();
  }

  //  :start checks when the status is unchecked, and again after a
  //  network_error (reopening the page retries it); an answered check stays.
  function onOpen() {
    if (active && (status === 'unchecked' || status === 'network_error')) recheck();
  }

  //  The Active Session goes over https only: a Cookie Bridge Session to
  //  the official domains, as it always did, any other to its own host.
  function appliesTo(url) {
    var m = /^https:\/\/([^\/:?#]+)/i.exec(String(url || ''));
    if (!active || !m) return false;
    var host = m[1].toLowerCase();
    return active.source === 'bridge' ? official(host) : host === active.host;
  }

  //  A Session saved before cf_clearance moved to the Clearance (0.9.0 and
  //  the unreleased work after it): hand it over once, unless the Clearance
  //  already holds a newer one.
  if (active && withoutClearance(active.cookie) !== active.cookie) {
    if (clearance && !clearance.forUrl(forumOf(active.host)))
      clearance.offer(forumOf(active.host), active.cookie, active.ua);
    save({source: active.source, host: active.host, cookie: withoutClearance(active.cookie), ua: active.ua, user: active.user});
  }
  if (active) setTimeout(startup, 0);

  return {
    //  The Active Session's {cookie, ua} when `url` is one of its hosts,
    //  else null: elsewhere a request goes as if there were no Session.
    forUrl: function (url) {
      return appliesTo(url) ? {cookie: active.cookie, ua: active.ua} : null;
    },

    //  Checks a Candidate Session with its own cookies and UA only, plus
    //  the held Clearance when it brought no cf_clearance of its own; it
    //  becomes the Active Session, without cf_clearance, when RuTracker
    //  answers authenticated. Returns the Session Check result: {status,
    //  user, detail}. A Source hands its cf_clearance to the Clearance
    //  unless the answer was a challenge or cancelled. A Forget or Clear
    //  while the check was in flight cancels it, and so does a newer
    //  submit() that started meanwhile, whatever its outcome (the later
    //  sign-in wins): {status: 'cancelled'}, nothing saved, and the Active
    //  Session stays as it was before this one (or as Forget or Clear left it).
    //  A Candidate unusable() rejects at once never reaches its check: it
    //  takes no number, so it cancels nothing.
    submit: function (c) {
      var started = generation;
      var why = unusable(c);
      var mine = why ? submits : ++submits;
      var current = function () { return started === generation && mine === submits; };
      var res = why ? {status: 'rejected', detail: why} : check(c, current);
      if (!current()) {
        log('candidate from ' + (c && c.source) + ': cancelled by a Forget, Clear or a newer sign-in');
        return {status: 'cancelled'};
      }
      log('candidate from ' + (c && c.source) + ': status=' + res.status + (res.user || res.detail ? ' (' + (res.user || res.detail) + ')' : ''));
      if (res.status === 'authenticated') {
        save({source: c.source, host: c.host.toLowerCase(), cookie: withoutClearance(c.cookie), ua: c.ua || '', user: res.user});
        status = 'authenticated';
      }
      return res;
    },

    //  A Session that an earlier version already used without this check
    //  (a Cookie Bridge session from before the upgrade): becomes the
    //  Active Session as it is and is checked next. True when the caller
    //  may drop its own copy: taken, or an Active Session already exists.
    adopt: function (c) {
      if (active) return true;
      if (unusable(c)) return false;
      var host = c.host.toLowerCase();
      if (clearance && !clearance.forUrl(forumOf(host))) clearance.offer(forumOf(host), c.cookie, c.ua);
      save({source: c.source, host: host, cookie: withoutClearance(c.cookie), ua: c.ua || '', user: ''});
      status = 'unchecked';
      log(c.source + ': adopted from an earlier version');
      setTimeout(startup, 0);
      return true;
    },

    recheck: recheck,

    onOpen: onOpen,

    //  Forget (the user's, the :forget route only): the Active Session goes,
    //  every Candidate Check in flight is cancelled, and the Core Jar's login
    //  is hidden until a new Session is Active. RuTracker keeps the Session
    //  valid: nothing is posted to it.
    forget: function () {
      if (active) log(active.source + ': forgotten');
      generation++;
      save(null, true);
      status = 'empty';
    },

    //  Drop the Active Session without a Forget (Cookie Bridge's Clear): it
    //  goes, but the Core Jar's login is not hidden.
    drop: function () {
      if (active) log(active.source + ': dropped');
      generation++;
      save(null, false);
      status = 'empty';
    },

    //  True after a Forget, until a new Session is Active: the Core Jar's
    //  RuTracker auth cookies are then not sent (credentials.js).
    hidesJar: afterForget,

    //  True after a Forget, until a new Session is Active: the next Password
    //  Login shows Movian's login dialog even with saved credentials (#22).
    forgotten: afterForget,

    //  Clear (Cookie Bridge): every Candidate Check in flight is cancelled;
    //  the Active Session is left to the caller.
    cancelChecks: function () {
      generation++;
    },

    active: function () {
      return !!active;
    },
    source: function () {
      return active ? active.source : '';
    },
    user: function () {
      return active ? active.user || '' : '';
    },
    status: function () {
      return status;
    },
    //  What a Session Check status means, for messages.
    statusText: function (s) {
      return STATUS_TEXT[s] || s;
    },
    //  One line for the start page; '' without an Active Session.
    text: function () {
      if (!active) return '';
      var head = 'Сессия (' + SOURCE_TEXT[active.source] + ')';
      if (status === 'authenticated') return head + ': вход выполнен как ' + active.user;
      return head + (active.user ? ', ' + active.user : '') + ': ' + (STATUS_TEXT[status] || status);
    },
  };
};

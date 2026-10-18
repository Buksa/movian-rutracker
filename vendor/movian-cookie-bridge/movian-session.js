/*
 * Movian Cookie Bridge - Movian side. ES5 for Movian's Duktape.
 *
 * Vendor the whole folder into a plugin (this file + bridge-core.js) and
 * create one session per site profile. The browser extension, or
 * tools/orca-session-push.js, writes the user's browser session - Cookie
 * header + User-Agent - over STPP into the profile's settings group:
 *
 *   settings.apps.nodes.<settingsGroup>.nodes.browserCookie.value
 *   settings.apps.nodes.<settingsGroup>.nodes.browserUA.value
 *
 * This module owns those two settings and:
 *  - moves the cookie out of the settings tree the moment it arrives: that
 *    tree is readable over unauthenticated STPP (LAN, and web pages through
 *    ws://127.0.0.1 - stpp.c checks no Origin) and is shown on the settings
 *    page. browserCookie keeps a placeholder; the session goes to a plugin
 *    store file (plaintext on disk, like the settings file). A session
 *    left in the tree by an older version is moved on start-up;
 *  - applies the cookies in the plugin's HTTP inspectors, to the profile
 *    domains over https only;
 *  - runs the plugin's session check once per transfer and keeps a status.
 *    A transfer is not a login: only the check says whether the site took it.
 *
 * Cookie values are never logged. Known limit: an STPP client that is
 * already subscribed while a transfer happens sees that one write.
 *
 * The site-specific part stays in the plugin: which page proves a login,
 * and how to read the account name from it (see `check`).
 */
var core = require('./bridge-core');

exports.VERSION = '1.0.0';

var STATUS_TEXT = {
  empty: 'сессия не передана',
  received: 'сессия получена, проверяется...',
  rejected: 'сессия не принята сайтом (истекла или недействительна)',
  challenge: 'требуется проверка Cloudflare в браузере',
  network_error: 'сетевая ошибка при проверке',
};

/*
 * Reads a session check response. `response` is a movian/http response or
 * null (network failure); `loginName(text)` returns the account name when
 * the page is the logged-in view. HTTP 200 alone proves nothing.
 * Cloudflare injects /cdn-cgi/challenge-platform/ into ordinary pages, so a
 * challenge is only the interstitial itself.
 */
exports.classify = function (response, loginName) {
  if (!response) return {status: 'network_error'};
  var text = '';
  try {
    text = String(response);
  }
  catch (err) {
  }
  var user = loginName(text);
  if (user) return {status: 'authenticated', user: user};
  var lc = response.headers_lc || {};
  if (lc['cf-mitigated'] === 'challenge' || /<title>Just a moment\.\.\.<\/title>/.test(text))
    return {status: 'challenge'};
  if (!text || response.statuscode >= 400) return {status: 'network_error', detail: 'HTTP ' + response.statuscode};
  return {status: 'rejected'};
};

/*
 * options:
 *   profile      bridge-core profile id ('rutracker', 'hdrezka', ...)
 *   check        function () -> exports.classify(...) result; fetches a
 *                page with the session applied
 *   hosts        optional list of domains to send the cookies to; default
 *                profile.domains. A profile without domains (HDRezka: any
 *                mirror) sends nothing unless the plugin names its hosts.
 *   group        optional settings group object to add the items to; by
 *                default a new group named after profile.settingsGroup
 *   title, icon, description   for that new settings group
 */
exports.create = function (options) {
  var profile = core.profile(options.profile);
  var id = profile.settingsGroup;
  var hosts = options.hosts || profile.domains || [];
  var store = require('movian/store').create(id);
  var state = {cookie: '', ua: '', status: 'empty', detail: '', user: '', checkPending: false};
  var loaded = false;
  var cookieItem, uaItem;

  function log(msg) {
    console.log('[' + id + '] ' + msg);
  }

  function setStatus(status, detail) {
    state.status = status;
    state.detail = detail || '';
    log('status=' + status + (state.detail ? ' (' + state.detail + ')' : ''));
  }

  function hostAllowed(url) {
    var m = /^https:\/\/([^\/:?#]+)/i.exec(String(url || ''));
    if (!m) return false;
    for (var i = 0; i < hosts.length; i++) {
      if (core.domainMatches(m[1], hosts[i])) return true;
    }
    return false;
  }

  function check() {
    if (!state.cookie) {
      state.user = '';
      setStatus('empty');
      return;
    }
    var res = options.check();
    state.user = res.user || '';
    setStatus(res.status, res.user || res.detail);
  }

  //  One check per transfer: cookie and UA arrive as two STPP SETs.
  function scheduleCheck() {
    if (state.checkPending) return;
    state.checkPending = true;
    setTimeout(function () {
      state.checkPending = false;
      try {
        check();
      }
      catch (err) {
        setStatus('error', String(err));
      }
    }, 300);
  }

  //  browserCookie values: a Cookie header always contains '=', the
  //  placeholder never does, and '' means "clear" (extension button).
  function onCookie(v) {
    if (v.indexOf('=') > 0) {
      var count = core.parseCookieHeader(v).length;
      state.cookie = v;
      store.cookie = v;
      log('cookie updated, entries=' + count);
      cookieItem.value = 'сохранено вне настроек (cookies: ' + count + ')';
      setStatus('received');
      scheduleCheck();
    }
    else if (!v) {
      state.cookie = '';
      state.user = '';
      store.cookie = '';
      setStatus('empty');
    }
  }

  function clear() {
    state.cookie = '';
    state.ua = '';
    state.user = '';
    //  store.js proxies have no delete trap: overwrite instead.
    store.cookie = '';
    cookieItem.value = '';
    uaItem.value = '';
    setStatus('empty', 'cleared');
    try {
      require('native/popup').notify('Сессия Cookie Bridge очищена');
    }
    catch (err) {
    }
  }

  //  `new`: a plain call would re-target the shared settings module, and
  //  later changes to the plugin's other settings would land in this file.
  var settings = require('movian/settings');
  var group = options.group || new settings.globalSettings(id, options.title, options.icon, options.description);
  group.createInfo('bridgeInfo', options.icon, 'Cookie Bridge переносит сессию браузера (Chrome/Brave) в M7.\nCookies не показываются и не остаются в настройках: это учётные данные.\nСессия хранится в файле плагина на диске в открытом виде.');
  cookieItem = group.createString('browserCookie', 'browserCookie (заполняется расширением)', '', function (v) {
    if (loaded) onCookie(v || '');
  });
  uaItem = group.createString('browserUA', 'browserUA (заполняется расширением)', '', function (v) {
    state.ua = v || '';
    if (!loaded) return;
    log('ua updated, len=' + state.ua.length);
    if (state.cookie) {
      setStatus('received');
      scheduleCheck();
    }
  });
  loaded = true;
  if (String(cookieItem.value || '').indexOf('=') > 0) {
    onCookie(String(cookieItem.value));
  }
  else if (store.cookie) {
    state.cookie = store.cookie;
    setStatus('received');
    scheduleCheck();
  }
  group.createAction('bridgeCheck', 'Проверить сессию Cookie Bridge', scheduleCheck);
  group.createAction('bridgeClear', 'Очистить сессию Cookie Bridge', clear);

  return {
    //  For an HTTP inspector callback: adds the session cookies when the
    //  request goes to a profile domain over https.
    applyToRequest: function (ctrl) {
      if (!state.cookie || !ctrl || !hostAllowed(ctrl.url)) return;
      var pairs = core.parseCookieHeader(state.cookie);
      for (var i = 0; i < pairs.length; i++) {
        //  setCookie() merges with the core cookie jar; for the same name
        //  the value set here wins (http_cookie_append()).
        ctrl.setCookie(pairs[i].name, pairs[i].value);
      }
    },
    //  The browser's User-Agent ('' when none was sent). cf_clearance is
    //  bound to it, so inspectors must send exactly this one.
    userAgent: function () {
      return state.ua;
    },
    active: function () {
      return !!state.cookie;
    },
    status: function () {
      return state.status;
    },
    text: function () {
      if (state.status === 'authenticated') return 'Cookie Bridge: авторизован как ' + state.user;
      if (state.status === 'error') return 'Cookie Bridge: ошибка ' + state.detail;
      return 'Cookie Bridge: ' + (STATUS_TEXT[state.status] || state.status);
    },
    check: scheduleCheck,
    clear: clear,
  };
};

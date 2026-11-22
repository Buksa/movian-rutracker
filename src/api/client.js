/*
 * RuTracker HTTP client: URLs, request headers, error handling and the HTTP
 * inspectors. Knows nothing about Movian pages.
 *
 * Never pass `debug: true` to http.request(): FA_DEBUG makes the core trace
 * every request header (Cookie included) and hexdump POST bodies (the login
 * password) into movian.log, which Movian serves on :42000/api/logfile.
 */
var http = require('movian/http');
var io = require('native/io');
var credentials = require('./credentials');
var challenged = require('../../vendor/movian-cookie-bridge/movian-session').challenged;
var DEFAULT_UA = credentials.DEFAULT_UA;

//  Do NOT add 'User-Agent' here. Request-option headers are merged *after*
//  the inspector headers and win (http_header_merge() in fa_http.c), so a UA
//  here would override the bridged browser UA - and Cloudflare's
//  cf_clearance is bound to the UA that earned it. Inspectors set the UA.
var BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*' + '/' + '*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Pragma': 'no-cache',
  'Upgrade-Insecure-Requests': 1,
};

//  A fresh object per request: callers add form headers without touching
//  what the next request sends.
function headers(extra, without) {
  var out = {}, k;
  for (k in BROWSER_HEADERS) if (!without || without.indexOf(k) === -1) out[k] = BROWSER_HEADERS[k];
  for (k in extra || {}) out[k] = extra[k];
  return out;
}

//  The cookies a response sets, as a Cookie header ('' when none). Every
//  Set-Cookie of the answer: headers_lc keeps only the last one. A cookie
//  set to '' or 'deleted' is RuTracker removing it.
function setCookies(res) {
  var list = (res.multiheaders_lc && res.multiheaders_lc['set-cookie']) || [];
  var names = [], values = {};
  for (var i = 0; i < list.length; i++) {
    var pair = String(list[i]).split(';')[0];
    var eq = pair.indexOf('=');
    if (eq < 1) continue;
    var name = pair.slice(0, eq).replace(/^\s+|\s+$/g, '');
    if (!(name in values)) names.push(name);
    values[name] = pair.slice(eq + 1).replace(/^\s+|\s+$/g, '');
  }
  return names.filter(function (n) {
    return values[n] !== '' && values[n] !== 'deleted';
  }).map(function (n) {
    return n + '=' + values[n];
  }).join('; ');
}

//  Inspector patterns are regular expressions; Movian adds the leading '^'
//  (es_http_inspector_create()). PORT_PATH ends a pattern at the host.
var PORT_PATH = '(:[0-9]+)?(/|$)';
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

//  RuTracker answers in windows-1251; trust an explicit charset if any.
function decode(res) {
  var type = res.contenttype || (res.headers_lc && res.headers_lc['content-type']) || '';
  return /charset=/i.test(type) ? res.toString() : res.convertFromEncoding('windows-1251');
}

/*
 * baseUrl: scheme + host of the chosen mirror, without a trailing slash.
 */
exports.create = function (baseUrl, clearance) {
  var forum = baseUrl + '/forum/';
  var baseHostMatch = /^https:\/\/([^\/:]+)$/i.exec(baseUrl);
  var baseHost = baseHostMatch ? baseHostMatch[1].toLowerCase() : '';
  var coordinator = null;
  var refreshClearance = null;
  //  Known RuTracker auth cookies plus names observed in later login answers.
  //  Names only; the Core Jar owns all cookie values.
  var coreJarCookieNames = ['bb_session', 'bb_guid', 'bb_ssl', 'cf_clearance'];

  function rememberCoreJarNames(cookieHeader) {
    var parts = String(cookieHeader || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 1) continue;
      var name = parts[i].slice(0, eq).replace(/^\s+|\s+$/g, '');
      if (name.indexOf('bb_') === 0 && coreJarCookieNames.indexOf(name) === -1)
        coreJarCookieNames.push(name);
    }
  }

  function suppressCoreJar(ctrl) {
    for (var i = 0; i < coreJarCookieNames.length; i++)
      ctrl.setCookie(coreJarCookieNames[i], '');
  }

  function requestHost(url) {
    var m = /^https:\/\/([^\/:?#]+)/i.exec(String(url || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function credentialsFor(url) {
    return credentials.credentialsFor(url, {
      baseHost: baseHost,
      session: coordinator ? coordinator.forUrl(url) : null,
      clearance: clearance ? clearance.forUrl(url) : null,
      clearanceHeld: !!clearance && clearance.active(),
      forgotten: !!coordinator && coordinator.hidesJar(),
    });
  }

  //  A Cloudflare Challenge met a request to `url` that carried `carried`
  //  (the held Clearance it went out with, or null): see challengedWith().
  function refused(url, carried) {
    if (clearance) clearance.challengedWith(url, carried);
  }

  //  Response object, or null when the network failed.
  function request(url, options) {
    //  noAuth requests carry their own explicit Cookie instead.
    if (!options.noAuth && credentialsFor(url).persisted) options.persistedCookies = true;
    try {
      return http.request(url, options);
    }
    catch (err) {
      console.log('RuTracker request failed: ' + url.split('?')[0]);
      return null;
    }
  }

  /*
   * A request that carries one Session ({cookie, ua}) and nothing else:
   * noAuth skips every HTTP inspector, ours with the Active Session
   * included (http_req_do in fa_http.c), so this request sets its own
   * User-Agent; the explicit Cookie header replaces the one the core built
   * from its cookie jar (http_header_merge). Only the request is isolated:
   * a Set-Cookie in the answer still lands in that jar. Redirects are not
   * followed. options: method, postdata, headers.
   * Raw response or null.
   */
  function isolated(url, session, options) {
    options = options || {};
    var extra = {}, k;
    for (k in options.headers || {}) extra[k] = options.headers[k];
    extra['Cookie'] = session.cookie;
    extra['User-Agent'] = session.ua || DEFAULT_UA;
    if (!extra['Referer']) extra['Referer'] = url.replace(/^(https?:\/\/[^\/]+\/).*$/, '$1');
    var opts = {noAuth: true, noFollow: true, verifySSL: true, noFail: true, headers: headers(extra)};
    if (options.method) opts.method = options.method;
    if (options.postdata) opts.postdata = options.postdata;
    return request(url, opts);
  }

  return {
    baseUrl: baseUrl,
    //  'rutracker.org' for https://rutracker.org; '' for a plain http one.
    host: baseHost,
    forum: forum,
    defaultUA: DEFAULT_UA,

    url: {
      index: forum + 'index.php',
      bookmarks: forum + 'bookmarks.php',
      topic: function (id) { return forum + 'viewtopic.php?t=' + id; },
      subforum: function (id) { return forum + 'viewforum.php?f=' + id; },
      search: function (query, forumId) {
        return forum + 'tracker.php?nm=' + encodeURIComponent(query) + (forumId ? '&f=' + forumId : '') + '&o=10';
      },
      //  Pager links and post links are relative to /forum/.
      resolve: function (href) { return href.indexOf(forum) === -1 ? forum + href : href; },
    },

    isolated: isolated,

    //  Names of RuTracker's session cookies (bb_*), without the Clearance.

    //  Raw response, or null when the network failed.
    fetch: function (url) {
      return request(url, {noFail: true, headers: headers()});
    },
    //  {text, refreshed}. Refresh only after an actual Cloudflare challenge,
    //  then retry this exact URL once. The caller owns the browser
    //  interaction; noRefresh (the global searcher) never opens it.
    //  `refreshed` is per call: Movian runs other pages while this one waits.
    //  A Challenge that meets the held Clearance drops it (clearance.challengedWith),
    //  whether a window is opened or not.
    page: function (url, noRefresh) {
      //  The pair a request goes out with is read just before it.
      function fetchPage() {
        var carried = clearance ? clearance.forUrl(url) : null;
        var res = request(url, {noFail: true, headers: headers()});
        return res ? {res: res, text: decode(res), carried: carried} : null;
      }
      var refreshed = false;
      var result = fetchPage();
      var challenge = !!result && challenged(result.res, result.text);
      if (challenge) {
        if (noRefresh || !refreshClearance) refused(url, result.carried);
        //  The callback makes the drop decision itself when it returns false.
        else if (refreshClearance(url, result.carried)) {
          refreshed = true;
          result = fetchPage();
          challenge = !!result && challenged(result.res, result.text);
          if (challenge) refused(url, result.carried);
        }
      }
      //  network: no response at all (text is then ''); challenge: the
      //  answer is still Cloudflare's challenge; httpError: another HTTP
      //  error status (0 when none).
      var httpError = result && !challenge && result.res.statuscode >= 400 ? result.res.statuscode : 0;
      return {text: result ? result.text : '', refreshed: refreshed, network: !result, challenge: challenge, httpError: httpError};
    },
    setClearanceRefresh: function (fn) {
      refreshClearance = fn;
    },
    //  Password Login uses an isolated request: neither the Active Session
    //  nor Core Jar cookies are sent. The optional clearance pair is the
    //  only Cookie header; response Set-Cookie still reaches the Core Jar.
    login: function (fields) {
      var clearancePair = clearance && clearance.forUrl(forum + 'login.php');
      var res = isolated(forum + 'login.php', clearancePair || {cookie: '', ua: DEFAULT_UA}, {
        method: 'POST',
        postdata: fields,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': baseUrl,
          'Referer': forum + 'login.php',
        },
      });
      if (!res) return null;
      var cookie = setCookies(res);
      var text = decode(res);
      rememberCoreJarNames(cookie);
      var met = challenged(res, text);
      if (met) refused(forum + 'login.php', clearancePair || null);
      return {
        status: res.statuscode,
        text: text,
        challenge: met,
        cookie: cookie,
        //  The {cookie, ua} the form went out with, or null.
        clearance: clearancePair || null,
      };
    },

    //  {bytes} of a .torrent, or {error}. Without a valid login dl.php
    //  answers with a web page, which must not be handed on as a torrent.
    torrent: function (url) {
      var carried = clearance ? clearance.forUrl(url) : null;
      var res = request(url, {
        noFail: true,
        args: {dummy: ''},
        headers: headers(null, ['Cache-Control', 'Pragma']),
      });
      if (!res) return {error: 'network'};
      if (challenged(res, decode(res))) refused(url, carried);
      var type = (res.headers_lc && res.headers_lc['content-type']) || '';
      if (res.statuscode !== 200 || !res.bytes || !(/bittorrent/i.test(type) || res.bytes[0] === 100 /* 'd' */))
        return {error: 'not_a_torrent'};
      return {bytes: res.bytes};
    },

    /*
     * Registers the inspectors for RuTracker requests, including those Movian
     * makes itself (direct torrent links). Only the longest matching
     * inspector pattern runs for a request (es_http_inspect()), so all
     * per-request work goes through these: the chosen mirror, and both
     * official domains whatever the mirror (links and redirects may cross
     * between them). Patterns end at the host, so no other host and no
     * URL that merely mentions one matches. `session` is the Session
     * Coordinator; credentials.js decides what each request carries.
     */
    inspect: function (session) {
      coordinator = session;
      function apply(ctrl, referer) {
        var c = credentialsFor(ctrl.url);
        ctrl.setHeader('Referer', referer);
        ctrl.setHeader('User-Agent', c.ua);
        if (c.blankJar) suppressCoreJar(ctrl);
        else if (c.blankClearance) ctrl.setCookie('cf_clearance', '');
        for (var i = 0; i < c.cookies.length; i++) {
          //  setCookie() hides a jar cookie of the same name; jar cookies of
          //  other names are still sent (http_cookie_append()).
          ctrl.setCookie(c.cookies[i].name, c.cookies[i].value);
        }
        return 0;
      }
      io.httpInspectorCreate(escapeRe(baseUrl) + PORT_PATH, function (ctrl) {
        return apply(ctrl, baseUrl + '/');
      });
      ['rutracker.org', 'rutracker.net'].forEach(function (domain) {
        //  Match lookalikes too: the Go Core Jar has suffix-only domain
        //  matching, so the callback must suppress it for non-official hosts.
        var pattern = 'https?://[^/:?#]*' + escapeRe(domain) + '[^/:?#]*' + PORT_PATH;
        io.httpInspectorCreate(pattern, function (ctrl) {
          var host = requestHost(ctrl.url);
          if (host !== domain && host.slice(-(domain.length + 1)) !== '.' + domain) {
            ctrl.setHeader('User-Agent', DEFAULT_UA);
            suppressCoreJar(ctrl);
            return 0;
          }
          if (ctrl.url.indexOf(baseUrl + '/') === 0 || ctrl.url === baseUrl) return apply(ctrl, baseUrl + '/');
          apply(ctrl, 'http://' + domain + '/');
          ctrl.setHeader('Accept-Language', 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7');
          return 0;
        });
      });
    },
  };
};

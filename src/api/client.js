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

//  Used when no browser session (with its own User-Agent) is bridged.
var DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

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

//  RuTracker answers in windows-1251; trust an explicit charset if any.
function decode(res) {
  var type = res.contenttype || (res.headers_lc && res.headers_lc['content-type']) || '';
  return /charset=/i.test(type) ? res.toString() : res.convertFromEncoding('windows-1251');
}

/*
 * baseUrl: scheme + host of the chosen mirror, without a trailing slash.
 */
exports.create = function (baseUrl) {
  var forum = baseUrl + '/forum/';

  //  Response object, or null when the network failed.
  function request(url, options) {
    try {
      return http.request(url, options);
    }
    catch (err) {
      console.log('RuTracker request failed: ' + url.split('?')[0]);
      return null;
    }
  }

  return {
    baseUrl: baseUrl,
    forum: forum,
    defaultUA: DEFAULT_UA,

    url: {
      index: forum + 'index.php',
      login: forum + 'login.php',
      bookmarks: forum + 'bookmarks.php',
      topic: function (id) { return forum + 'viewtopic.php?t=' + id; },
      subforum: function (id) { return forum + 'viewforum.php?f=' + id; },
      search: function (query, forumId) {
        return forum + 'tracker.php?nm=' + encodeURIComponent(query) + (forumId ? '&f=' + forumId : '') + '&o=10';
      },
      //  Pager links and post links are relative to /forum/.
      resolve: function (href) { return href.indexOf(forum) === -1 ? forum + href : href; },
    },

    //  Raw response (status, headers) or null; for callers that classify it.
    fetch: function (url) {
      return request(url, {noFail: true, headers: headers()});
    },

    //  Decoded page text, '' when the request failed.
    page: function (url) {
      var res = request(url, {noFail: true, headers: headers()});
      return res ? decode(res) : '';
    },

    //  Legacy login form. Returns the decoded answer, or '' on failure.
    login: function (fields) {
      var res = request(forum + 'login.php', {
        noFail: true,
        noFollow: true,
        method: 'POST',
        postdata: fields,
        headers: headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': baseUrl,
          'Referer': forum + 'login.php',
        }),
      });
      return res ? decode(res) : '';
    },

    logout: function () {
      request(forum + 'login.php', {
        noFail: true,
        noFollow: true,
        postdata: {'logout': 1},
        headers: headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': forum + 'index.php',
        }, ['Cache-Control', 'Pragma']),
      });
    },

    //  {bytes} of a .torrent, or {error}. Without a valid login dl.php
    //  answers with a web page, which must not be handed on as a torrent.
    torrent: function (url) {
      var res = request(url, {
        noFail: true,
        args: {dummy: ''},
        headers: headers(null, ['Cache-Control', 'Pragma']),
      });
      if (!res) return {error: 'network'};
      var type = (res.headers_lc && res.headers_lc['content-type']) || '';
      if (res.statuscode !== 200 || !res.bytes || !(/bittorrent/i.test(type) || res.bytes[0] === 100 /* 'd' */))
        return {error: 'not_a_torrent'};
      return {bytes: res.bytes};
    },

    /*
     * Registers the inspectors for RuTracker requests, including those Movian
     * makes itself (direct torrent links). Only the longest matching
     * inspector pattern runs for a request (es_http_inspect()), so all
     * per-request work goes through these two. `session` supplies the
     * bridged browser session: applyToRequest(ctrl), userAgent().
     */
    inspect: function (session) {
      io.httpInspectorCreate(baseUrl + '.*', function (ctrl) {
        ctrl.setHeader('Referer', baseUrl + '/');
        ctrl.setHeader('User-Agent', session.userAgent() || DEFAULT_UA);
        session.applyToRequest(ctrl);
      });
      io.httpInspectorCreate('http.*rutracker.org.*', function (ctrl) {
        ctrl.setHeader('User-Agent', session.userAgent() || DEFAULT_UA);
        session.applyToRequest(ctrl);
        ctrl.setHeader('Referer', 'http://rutracker.org/');
        ctrl.setHeader('Accept-Language', 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7');
        return 0;
      });
    },
  };
};

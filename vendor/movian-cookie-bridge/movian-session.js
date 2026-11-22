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
 * This module owns those two settings and hands each cookie + User-Agent
 * pair to the plugin (onSession), which keeps, checks and applies the
 * session. It takes the cookie out of the settings tree the moment it
 * arrives: that tree is readable over unauthenticated STPP (LAN, and web
 * pages through ws://127.0.0.1 - stpp.c checks no Origin) and is shown on
 * the settings page, so both items keep a placeholder. A session an
 * earlier version left in the tree or its store goes to the plugin once.
 *
 * Cookie values are never logged. Known limit: an STPP client that is
 * already subscribed while a transfer happens sees that one write.
 */
var core = require('./bridge-core');

exports.VERSION = '2.0.0';

/*
 * True when `response` (a movian/http response) is Cloudflare's challenge
 * itself, by its header or by the interstitial's title; `text` is its body
 * when the caller already decoded it. Cloudflare injects
 * /cdn-cgi/challenge-platform/ into ordinary pages, which is no challenge.
 */
function challenged(response, text) {
  var lc = response.headers_lc || {};
  return lc['cf-mitigated'] === 'challenge' || /<title>Just a moment\.\.\.<\/title>/.test(text === undefined ? String(response) : text);
}
exports.challenged = challenged;

/*
 * Reads a session check response. `response` is a movian/http response or
 * null (network failure); `loginName(text)` returns the account name when
 * the page is the logged-in view. HTTP 200 alone proves nothing.
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
  if (challenged(response, text)) return {status: 'challenge'};
  if (!text || response.statuscode >= 400) return {status: 'network_error', detail: 'HTTP ' + response.statuscode};
  return {status: 'rejected'};
};

/*
 * options:
 *   profile      bridge-core profile id ('rutracker', 'hdrezka', ...)
 *   onSession    function (cookieHeader, ua, stored) -> true when the
 *                plugin took the session. Called with each cookie +
 *                User-Agent pair that arrived in one transfer; an empty
 *                pair for "Clear session"; and once, with stored = true, a
 *                session an earlier version stored, whose copy is then
 *                dropped. Required: the module keeps no session itself.
 *   check        optional function () for the "check session" action
 *   group        optional settings group object to add the items to; by
 *                default a new group named after profile.settingsGroup
 *   title, icon, description   for that new settings group
 */
exports.create = function (options) {
  var handOver = options.onSession;
  if (typeof handOver !== 'function') throw new Error('movian-session: onSession is required');
  var profile = core.profile(options.profile);
  var id = profile.settingsGroup;
  var store = require('movian/store').create(id);
  var loaded = false;
  var cookieItem, uaItem;
  var pair = {cookie: null, ua: null, gen: 0};

  function log(msg) {
    console.log('[' + id + '] ' + msg);
  }

  //  The extension writes the cookie and the UA as two STPP SETs. They are
  //  one pair when the second arrives within PAIR_MS of the first, in
  //  either order; a half left alone that long is dropped, so a cookie
  //  never travels with the UA of another transfer. Each half is replaced
  //  by a placeholder as it arrives, so sending it again, after a pair or a
  //  dropped half, is a change that Movian reports.
  var PAIR_MS = 3000;
  function offerHalf() {
    if (pair.cookie === null || pair.ua === null) {
      var gen = pair.gen;
      setTimeout(function () {
        if (pair.gen !== gen) return;
        log('incomplete transfer (' + (pair.cookie === null ? 'no cookie' : 'no UA') + '), ignored');
        pair = {cookie: null, ua: null, gen: gen + 1};
      }, PAIR_MS);
      return;
    }
    var cookie = pair.cookie, ua = pair.ua, gen = pair.gen + 1;
    pair = {cookie: null, ua: null, gen: gen};
    //  Out of the settings callback: the plugin checks the session online.
    //  A "Clear" (or a newer transfer) before then moves gen on: drop this one.
    setTimeout(function () {
      if (pair.gen !== gen) return;
      handOver(cookie, ua, false);
    }, 0);
  }

  function dropHalves() {
    pair = {cookie: null, ua: null, gen: pair.gen + 1};
  }

  //  browserCookie values: a Cookie header always contains '=', the
  //  placeholder never does, and '' means "clear" (extension button).
  function onCookie(v) {
    if (v.indexOf('=') > 0) {
      var count = core.parseCookieHeader(v).length;
      pair.cookie = v;
      log('cookie received, entries=' + count);
      cookieItem.value = 'сохранено вне настроек (cookies: ' + count + ')';
      offerHalf();
    }
    else if (!v) {
      dropHalves();
      handOver('', '', false);
    }
  }

  function clear() {
    //  The item writes below are not a transfer.
    loaded = false;
    cookieItem.value = '';
    uaItem.value = '';
    loaded = true;
    dropHalves();
    handOver('', '', false);
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
    //  '' is the placeholder being reset or the second half of "Clear
    //  session", which the cookie already announced.
    if (!loaded || !v || v.indexOf('сохранено вне настроек') === 0) return;
    pair.ua = v;
    log('ua received, len=' + v.length);
    uaItem.value = 'сохранено вне настроек (длина: ' + v.length + ')';
    offerHalf();
  });
  //  A session stored by an earlier version (in the store, or in the 0.8.0
  //  settings item) goes to the plugin once.
  var stored = String(cookieItem.value || '').indexOf('=') > 0 ? String(cookieItem.value) : String(store.cookie || '');
  if (stored && handOver(stored, String(uaItem.value || ''), true)) {
    //  store.js proxies have no delete trap: overwrite instead.
    store.cookie = '';
    cookieItem.value = '';
    uaItem.value = '';
  }
  loaded = true;
  group.createAction('bridgeCheck', 'Проверить сессию Cookie Bridge', function () {
    if (options.check) options.check();
  });
  group.createAction('bridgeClear', 'Очистить сессию Cookie Bridge', clear);
};

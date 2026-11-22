/*
 * Clearance (GLOSSARY.md): cf_clearance and the User-Agent that earned it,
 * for one exact https host: an official one or the chosen domain's. This module owns all of it: the pair
 * and its expiry, getting one in Movian Go's browser window, keeping it
 * across restarts and forgetting it everywhere. Kept as the record Core
 * holds where Movian Go has one for the browser's cookie (Core sends it
 * itself on `persistedCookies` requests); otherwise, a Cookie Bridge one
 * or on M7, in the plugin's store (plaintext on disk, like the Session).
 * The only copy: a Session holds no cf_clearance (docs/adr/0003).
 *
 * The window is Movian Go's native/popup: webpopup() + webcookies() (CEF on
 * desktop, a clearance-only WebView on Android). M7 has neither.
 */
var core = require('../../vendor/movian-cookie-bridge/bridge-core');
var DOMAINS = core.profile('rutracker').domains;

/*
 * baseUrl: the chosen domain (scheme + host); without it, or for a plain
 * http one, there is no browser window and no Core record.
 */
exports.create = function (baseUrl) {
  var pair = null;
  var popup = require('native/popup');
  var forum = /^https:\/\/[^\/:?#]+$/i.test(baseUrl || '') ? baseUrl + '/forum/' : '';
  //  A custom https mirror gets its Clearance too.
  var hosts = forum ? DOMAINS.concat(forum.slice(8, -7).toLowerCase()) : DOMAINS;

  function hostOf(url) {
    var m = /^https:\/\/([^\/:?#]+)(?:[/?#]|$)/i.exec(String(url || ''));
    var host = m ? m[1].toLowerCase() : '';
    for (var i = 0; i < hosts.length; i++) if (host === hosts[i]) return host;
    return '';
  }
  var unsupported = false;
  //  The plugin store adapter, for any domain: a Cookie Bridge clearance is
  //  for an official https host even when an http one is chosen. None
  //  without a site (module tests).
  var store = baseUrl ? require('movian/store').create('rutracker_clearance') : null;

  function expired(candidate) {
    return candidate && candidate.expires !== undefined && candidate.expires !== null &&
      Number(candidate.expires) <= Math.floor(new Date().getTime() / 1000);
  }

  function current() {
    if (expired(pair)) drop();
    return pair;
  }

  function forUrl(url) {
    if (!current() || hostOf(url) !== pair.host) return null;
    var out = {cookie: 'cf_clearance=' + pair.value, ua: pair.ua};
    if (pair.persisted) out.persisted = true;
    return out;
  }

  function offer(url, cookieHeader, ua, expires, persisted) {
    var host = hostOf(url), value = '';
    var cookies = core.parseCookieHeader(cookieHeader);
    for (var i = 0; i < cookies.length; i++)
      if (cookies[i].name === 'cf_clearance') value = cookies[i].value;
    ua = String(ua || '');
    if (!host || !value || value === 'deleted' || !ua) return false;
    if (expires !== undefined && expires !== null) {
      expires = Number(expires);
      if (!isFinite(expires) || expires <= Math.floor(new Date().getTime() / 1000)) {
        current();
        return false;
      }
    }
    pair = {host: host, value: value, ua: ua, persisted: !!persisted};
    if (expires !== undefined && expires !== null) pair.expires = expires;
    keep();
    //  An older Core record would be restored first on the next start.
    if (!pair.persisted) deletePersisted();
    return true;
  }

  function deletePersisted() {
    if (!forum || typeof popup.deletePersistedWebCookie !== 'function') return;
    try {
      popup.deletePersistedWebCookie(forum, 'cf_clearance');
    }
    catch (e) {}
  }

  //  The plugin store holds the pair unless Core does.
  function keep() {
    if (!store) return;
    //  store.js proxies have no delete trap: overwrite instead.
    store.pair = pair && !pair.persisted ? {host: pair.host, value: pair.value, ua: pair.ua, expires: pair.expires} : '';
  }

  function drop() {
    pair = null;
    keep();
  }

  //  "Forget": drop it here, the record Core keeps for us and the
  //  cf_clearance in the browser store, or the next refresh() silently
  //  reuses it. RuTracker's cf_clearance is domain=.rutracker.org; path=/,
  //  which covers the forum URL.
  function forget() {
    drop();
    if (!forum) return;
    if (typeof popup.deletecookies === 'function') {
      try {
        popup.deletecookies(forum, ['cf_clearance']);
      }
      catch (e) {}
    }
    deletePersisted();
  }

  function restore(url, value, ua, expires) {
    return offer(url, 'cf_clearance=' + String(value || ''), ua, expires, true);
  }

  function restorePersisted() {
    var saved;
    if (!forum || typeof popup.getPersistedWebCookie !== 'function') return;
    try {
      saved = popup.getPersistedWebCookie(forum, 'cf_clearance');
      if (saved && saved.value && saved.ua && saved.expires !== undefined)
        restore(forum, saved.value, saved.ua, saved.expires);
    }
    catch (e) {}
  }

  //  Opens the window until it holds a cf_clearance (force: until the user
  //  closes it, and the value must not be `reject`, by default the one the
  //  browser held before). {status}: 'ok' | 'unsupported' | 'neterror' |
  //  'cancelled' | 'empty' | 'persistfailed'.
  function acquire(title, force, reject) {
    if (current() && !force) return {status: 'ok'};
    if (unsupported || !forum || typeof popup.webcookies !== 'function') return {status: 'unsupported'};
    var r, previous, previousUA;
    if (force) {
      try {
        var previousJar = popup.webcookies(forum);
        previous = previousJar && previousJar.cf_clearance;
        previousUA = popup.webuseragent();
        if (reject) {
          previous = reject;
          previousUA = undefined;
        }
      }
      catch (e) {
        return {status: 'neterror'};
      }
    }
    try {
      r = popup.webpopup(forum + 'login.php', title, '', force ? {} : {
        waitForCookie: {url: forum, name: 'cf_clearance'}
      });
    }
    catch (e) {
      return {status: 'neterror'};
    }
    if (r.result === 'unsupported') {
      unsupported = true;
      return {status: 'unsupported'};
    }
    if (r.result === 'neterror') return {status: 'neterror'};
    try {
      var jar = popup.webcookies(forum);
      var value = jar && jar.cf_clearance;
      var ua = popup.webuseragent();
      if (force && previous && value === previous && (reject || ua === previousUA))
        return {status: 'empty'};
      var saved = null;
      var persistenceAvailable = typeof popup.persistWebCookie === 'function';
      if (persistenceAvailable) {
        try {
          saved = popup.persistWebCookie(forum, 'cf_clearance');
        }
        catch (e) {
          saved = null;
        }
      }
      if (saved && saved.value && saved.ua && saved.expires !== undefined) {
        if (!restore(forum, saved.value, saved.ua, saved.expires))
          return {status: r.result === 'userclose' ? 'cancelled' : 'empty'};
      }
      else if (!value) {
        return {status: r.result === 'userclose' ? 'cancelled' : 'empty'};
      }
      else if (persistenceAvailable) {
        return {status: 'persistfailed'};
      }
      else if (!offer(forum, 'cf_clearance=' + value, ua)) {
        return {status: r.result === 'userclose' ? 'cancelled' : 'empty'};
      }
    }
    catch (e) {
      return {status: 'empty'};
    }
    return {status: 'ok'};
  }

  restorePersisted();
  if (!pair && store && store.pair && store.pair.value)
    offer('https://' + store.pair.host + '/forum/', 'cf_clearance=' + store.pair.value, store.pair.ua, store.pair.expires);

  return {
    //  A browser's cookie header (Cookie Bridge): only its cf_clearance is
    //  kept, in memory.
    offer: offer,
    //  A record Core holds (persisted or restored): Core sends it itself on
    //  requests that ask for `persistedCookies`, so the inspector must not.
    restore: restore,
    //  {cookie, ua} for `url`, persisted: true when Core holds the record
    //  and sends it itself on persistedCookies requests; null otherwise.
    forUrl: forUrl,
    active: function () {
      return !!current();
    },
    //  Whether refresh() can open a window here (Movian Go, https domain).
    available: function () {
      return !!forum && typeof popup.webcookies === 'function';
    },
    //  {title, force, reject}: see acquire().
    refresh: function (options) {
      return acquire(options.title, !!options.force, options.reject);
    },
    forget: forget,
    //  The one decision on a Cloudflare Challenge that met a request to
    //  `url` carrying `carried` (the {cookie, ua} forUrl() gave for it, or
    //  null when it carried none). A Clearance is its cookie with its
    //  User-Agent, so the held pair is the carried one only when both match.
    //  The held pair is forgotten only in that case. Any other pair held now
    //  stays, because the challenge did not refuse it: another page replaced
    //  it while this request waited, or the request carried a Candidate's own
    //  cf_clearance, or none. {fresher, dropped}: fresher is true when the
    //  held pair is not the one this request carried (it may be a newer one,
    //  or the request carried none); dropped is the pair forgotten here, or null.
    challengedWith: function (url, carried) {
      var now = forUrl(url);
      var same = !!now && !!carried && now.cookie === carried.cookie && now.ua === carried.ua;
      if (now && !same) return {fresher: true, dropped: null};
      if (now) forget();
      return {fresher: false, dropped: now || null};
    },
    //  Cookie Bridge's "Clear session": here, in the plugin store and the
    //  Core record, which would come back on the next start.
    clear: function () {
      drop();
      deletePersisted();
    },
  };
};

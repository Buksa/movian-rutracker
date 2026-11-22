/*
 * RuTracker's side of the Movian Cookie Bridge. The generic work (settings,
 * transfer) is in vendor/movian-cookie-bridge; domains are the 'rutracker'
 * profile in bridge-core.js. A transfer may offer cf_clearance and its
 * User-Agent to the experimental helper, which retains only that pair.
 * Full sessions still go to the Session Coordinator for verification.
 */
var core = require('../../vendor/movian-cookie-bridge/bridge-core');
var bridge = require('../../vendor/movian-cookie-bridge/movian-session');
var PROFILE = core.profile('rutracker');

//  The browser's cookies are checked on the chosen domain when it is an
//  official one, else on the profile's default domain: they never go to a
//  custom mirror.
function checkHost(baseUrl) {
  var m = /^https:\/\/([^\/:]+)$/i.exec(baseUrl);
  for (var i = 0; m && i < PROFILE.domains.length; i++) {
    if (core.domainMatches(m[1], PROFILE.domains[i])) return m[1].toLowerCase();
  }
  return PROFILE.defaultDomain;
}

function notify(text) {
  try {
    require('native/popup').notify(text, 5);
  }
  catch (err) {
  }
}

exports.create = function (title, logo, client, session, clearance) {
  var host = checkHost(client.baseUrl);
  return bridge.create({
    profile: 'rutracker',
    title: title + ' - Cookie Bridge',
    icon: logo,
    description: 'Сессия из браузера для обхода Cloudflare',
    check: session.recheck,
    //  A transfer starts when it arrives: a Forget or Clear before its
    //  deferred hand-over cancels it.
    onTransfer: session.ticket,
    onSession: function (cookie, ua, stored, ticket) {
      var c = {source: 'bridge', host: host, cookie: cookie, ua: ua};
      if (stored) return session.adopt(c);
      if (!cookie) {
        clearance.clear();
        session.cancelChecks();
        if (session.source() === 'bridge') session.drop();
        return true;
      }
      var res = session.submit(c, ticket);
      if (res.status === 'cancelled') {
        notify('Cookie Bridge: проверка отменена, сессию забыли или очистили во время проверки, либо начат другой вход');
        return true;
      }
      //  Cloudflare took the browser's cf_clearance, or it was not asked.
      var gotClearance = res.status !== 'challenge' && clearance.offer('https://' + host + '/forum/', cookie, ua);
      if (res.status === 'rejected' && res.detail === 'incomplete' && gotClearance) {
        notify('Cloudflare clearance получена; теперь войдите по паролю');
        return true;
      }
      notify(res.status === 'authenticated' ? 'Cookie Bridge: вход выполнен как ' + res.user :
        'Cookie Bridge: сессия не прошла проверку (' + session.statusText(res.status) + '), прежняя сессия не изменилась');
      return true;
    },
  });
};

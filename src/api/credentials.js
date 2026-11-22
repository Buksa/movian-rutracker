/*
 * What a RuTracker request carries: the User-Agent, the cookies the plugin
 * adds, whether the Core Jar's auth cookies are hidden, and whether Core
 * sends its own clearance record. The one place that decides it, for the
 * HTTP inspectors and for request() (client.js), which only apply the
 * answer. noAuth (isolated) requests carry their own explicit Cookie and
 * never come here.
 */
var core = require('../../vendor/movian-cookie-bridge/bridge-core');

//  Used when neither a Clearance nor a Session names one.
var DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
var OFFICIAL = ['rutracker.org', 'rutracker.net'];

function hostOf(url) {
  var m = /^https:\/\/([^\/:?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

//  An official domain or one of its subdomains; not a lookalike such as
//  evilrutracker.org or rutracker.org.evil.example.
function official(host) {
  for (var i = 0; i < OFFICIAL.length; i++) {
    var d = OFFICIAL[i];
    if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
  }
  return false;
}

exports.DEFAULT_UA = DEFAULT_UA;

/*
 * url: the request URL. state:
 *   baseHost       host of the chosen https domain ('' for a plain http one)
 *   session        the Active Session's {cookie, ua} when url is one of its
 *                  hosts; null otherwise. It holds no cf_clearance.
 *   clearance      the Clearance for url: {cookie, ua, persisted}; null
 *   clearanceHeld  a clearance is held, for url's host or another
 *   forgotten      a Forget left no Active Session: the Core Jar's auth
 *                  cookies stay hidden until a new Session is Active (#3)
 * Returns {ua, cookies: [{name, value}], blankJar, blankClearance,
 * persisted}: blankJar hides all the Core Jar's auth cookies (the Clearance
 * the request carries is still sent: it is in cookies); blankClearance hides
 * only its cf_clearance, when the plugin sends no Clearance of its own for
 * this request and Core does not send its record (persisted: true asks Core
 * to send that record, persistedCookies, which the plugin then does not
 * add). These are the decisions on the Core Jar; the HTTP inspectors only
 * apply them.
 */
exports.credentialsFor = function (url, state) {
  var session = state.session, clearance = state.clearance;
  var persisted = !!clearance && !!clearance.persisted;
  var host = hostOf(url);
  //  Without an Active Session after a Forget, the jar's login is not used.
  var hidden = !session && !!state.forgotten;
  if (!host || (host !== state.baseHost && !official(host)) ||
      (!session && (host !== state.baseHost || (state.clearanceHeld && !clearance))))
    return {ua: DEFAULT_UA, cookies: [], blankJar: true, blankClearance: false, persisted: persisted};
  var cookies = core.parseCookieHeader(session ? session.cookie : '');
  if (clearance && !clearance.persisted) cookies = cookies.concat(core.parseCookieHeader(clearance.cookie));
  var sendsClearance = cookies.some(function (c) { return c.name === 'cf_clearance'; });
  return {
    //  cf_clearance is bound to the User-Agent that earned it.
    ua: (clearance ? clearance.ua : session ? session.ua : '') || DEFAULT_UA,
    cookies: cookies,
    blankJar: hidden,
    //  The jar's copy belongs to the Clearance module, not to this request.
    blankClearance: !hidden && !persisted && !sendsClearance,
    persisted: persisted,
  };
};

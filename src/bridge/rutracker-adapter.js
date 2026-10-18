/*
 * RuTracker's side of the Movian Cookie Bridge. The generic work (settings,
 * storage, cookie scope, statuses) is in vendor/movian-cookie-bridge; the
 * domains are the 'rutracker' profile in bridge-core.js. What is RuTracker
 * specific is how to tell that the site accepted the session: a forum page
 * shows the logged-in account.
 *
 * Not index.php: Cloudflare does not challenge it, so it answers with the
 * logged-in view even without cf_clearance while every forum and search
 * page gets the 403 challenge. f=7 ("Зарубежное кино") is a long-lived
 * forum with a small first page.
 */
var CHECK_FORUM = 7;
var bridge = require('../../vendor/movian-cookie-bridge/movian-session');

exports.create = function (title, logo, client, parser) {
  return bridge.create({
    profile: 'rutracker',
    title: title + ' - Cookie Bridge',
    icon: logo,
    description: 'Сессия из браузера для обхода Cloudflare',
    check: function () {
      return bridge.classify(client.fetch(client.url.subforum(CHECK_FORUM)), parser.loginName);
    },
  });
};

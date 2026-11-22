/**
 *  RuTracker.org plugin for M7 (Movian)
 *
 *  Copyright (C) 2014-2026 Wain (fix by kovalDN)
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
// ver. 0.9.0 (upstream base: 0.7.7 by Wain / fix by kovalDN)
//
//  Entry point: wires the layers together. Each module says what it owns:
//    src/ui/settings.js   settings page        src/ui/routes.js    pages
//    src/business/*       catalog, Password Login
//    src/api/*            HTTP, HTML parsing
//    src/bridge/*         Session Coordinator and the Session Sources
//                         (Cookie Bridge generic part: vendor/movian-cookie-bridge)
var plugin = JSON.parse(Plugin.manifest);
var PREFIX = plugin.id;
var TTL = plugin.title;
var LOGO = Plugin.path + plugin.icon;

require('movian/service').create(TTL, PREFIX + ':start', 'video', true, LOGO);
var config = require('./src/ui/settings').register(plugin, LOGO);
var parser = require('./src/api/parser');
var clearance = require('./src/bridge/clearance').create(config.domain);
var client = require('./src/api/client').create(config.domain, clearance);

//  Full browser sessions go through the coordinator. The experimental
//  clearance-only pair is attached separately and is never stored there.
var session = require('./src/bridge/session').create(client, parser, clearance);
//  Clearance Refresh after a page met a Challenge carrying `carried`.
client.setClearanceRefresh(function (url, carried) {
  //  The drop decision is the Clearance's, shared with every other request
  //  that meets a Challenge. It returns early when the held pair is not
  //  the one this request carried (another page replaced it meanwhile).
  var got = clearance.challengedWith(url, carried);
  if (got.fresher) return true;
  //  The dropped pair went everywhere, the browser's copy included, so the
  //  window cannot hand the same one back.
  var now = got.dropped;
  if (clearance.refresh({
    title: 'Cloudflare: дождитесь получения clearance и закройте окно',
    force: !!now,
    reject: now ? now.cookie.replace(/^cf_clearance=/, '') : '',
  }).status !== 'ok') return false;
  //  The Active Session's last check may have met the old one.
  if (session.active()) setTimeout(session.recheck, 0);
  return true;
});
client.inspect(session);

//  Cookie Bridge: the extension writes over STPP into the group
//  'rutracker_bridge'. It dates from the id 'RuTracker.org', whose dot made
//  the plugin's own group unaddressable (STPP splits paths on '.'); it stays
//  so that every extension version keeps working.
require('./src/bridge/rutracker-adapter').create(TTL, LOGO, client, session, clearance);
require('./src/ui/routes').register({
  id: PREFIX,
  title: TTL,
  path: Plugin.path,
  logo: LOGO,
  config: config,
  catalog: require('./src/business/catalog').create(client, parser),
  auth: require('./src/business/auth').create(client, parser, session),
  client: client,
  session: session,
  clearance: clearance,
});

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
//    src/business/*       catalog, legacy auth src/api/*           HTTP, HTML parsing
//    src/bridge/*         Cookie Bridge (generic part: vendor/movian-cookie-bridge)
var plugin = JSON.parse(Plugin.manifest);
var PREFIX = plugin.id;
var TTL = plugin.title;
var LOGO = Plugin.path + plugin.icon;

require('movian/service').create(TTL, PREFIX + ':start', 'video', true, LOGO);
var config = require('./src/ui/settings').register(plugin, LOGO);
var parser = require('./src/api/parser');
var client = require('./src/api/client').create(config.domain);

//  Browser session (Cookie Bridge): the extension writes it over STPP into
//  the group 'rutracker_bridge'. It dates from the id 'RuTracker.org', whose
//  dot made the plugin's own group unaddressable (STPP splits paths on '.');
//  it stays so that every extension version keeps working.
var bridge = require('./src/bridge/rutracker-adapter').create(TTL, LOGO, client, parser);
client.inspect(bridge);
require('./src/ui/routes').register({
  id: PREFIX,
  title: TTL,
  path: Plugin.path,
  logo: LOGO,
  config: config,
  catalog: require('./src/business/catalog').create(client, parser),
  auth: require('./src/business/auth').create(client, parser),
  client: client,
  bridge: bridge,
});

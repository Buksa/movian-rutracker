/*
 * The plugin's own settings group ("RuTracker.org"). register() returns a
 * plain config object that the setting callbacks keep current; the rest of
 * the plugin reads settings only from there.
 */
var settings = require('movian/settings');

var MIRRORS = [
  'http://rutracker.org', 'https://rutracker.org',
  'http://rutracker-org.appspot.com', 'https://rutracker-org.appspot.com',
  'http://rutracker.lib', 'https://rutracker.lib',
  'http://rutracker.i2p', 'https://rutracker.i2p',
  'http://rutracker.net', 'https://rutracker.net',
];

//  "https://host" without a trailing slash. The old public plugin with the
//  same id ("rutracker", Buksa/movian-rutracker) stored a bare host here.
function baseUrl(v) {
  v = String(v || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
  return /^https?:\/\//i.test(v) ? v : 'https://' + v;
}

exports.register = function (plugin, logo) {
  var config = {};
  function printDebug(message) {
    if (config.debug) console.error(message);
  }

  //  `new`: a plain call would turn the shared settings module itself into
  //  this group (settings.js keeps the group on `this`).
  var group = new settings.globalSettings(plugin.id, plugin.title, logo, plugin.synopsis);
  group.createInfo('info', logo, 'Plugin developed by ' + plugin.author + ', \n' + plugin.id + ', \n' + 'ver. ' + plugin.version + ' \n');
  group.createDivider('Настройки:');
  group.createBool('tosaccepted', 'Принятие условий использования (при открытии плагина)', false, function (v) {config.tosaccepted = v});
  group.createBool('debug', 'Отладка (debug)', false, function (v) {config.debug = v});
  group.createString('domain0', 'Домен (базовый URL без завершающего "/" в конце)', 'https://rutracker.org', function (v) {config.domain0 = v});
  //  Read once at start-up: a new domain applies after the plugin reloads.
  group.createMultiOpt('domain', 'Выбор домена', [[config.domain0, config.domain0, true]].concat(MIRRORS.map(function (u) {
    return [u, u];
  })), function (v) {
    printDebug('Установите домен на ' + v);
    config.domain = baseUrl(v);
  });
  group.createMultiOpt('list', 'Отображение списка', [
    ['directory', 'Общим списком'],
    ['video', 'Списком с данными', true],
  ], function (v) {
    printDebug('Установите список на ' + v);
    config.list = v;
  });
  group.createBool('msearch', 'Поиск в плагине из Movian *', true, function (v) {config.msearch = v});
  group.createBool('isearch', 'Поиск в плагине из меню *', false, function (v) {config.isearch = v});
  group.createBool('startAuth', 'Авторизация при старте', 0, function (v) {config.startAuth = v});
  return config;
};

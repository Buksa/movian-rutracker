#!/usr/bin/env node
/*
 * Prints the sign-in state of a live profile, names and lengths only (never
 * a value): the Session store, the Clearance pair, Movian's cookie jar and
 * Core record, the keyring entry and the browser's cookies.
 *
 *   node tools/live/state.js [<LIVE_DIR>]      default: $LIVE_DIR
 *
 * Movian writes settings/httpcookies a few seconds after a change; read it
 * again before concluding a cookie is still there. The user name is shown
 * by its length, like every other value.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

var dir = process.argv[2] || process.env.LIVE_DIR;
if (!dir) {
    console.error('usage: state.js <LIVE_DIR>');
    process.exit(1);
}
var p = path.join(dir, 'persistent');

function json(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return undefined; }
}
function names(cookieHeader) {
    return String(cookieHeader || '').split(';').map(function (part) {
        var eq = part.indexOf('=');
        return eq > 0 ? part.slice(0, eq).trim() + '(' + (part.length - eq - 1) + ')' : '';
    }).filter(Boolean).join(' ');
}

var store = path.join(p, 'plugins', 'rutracker@local', 'store');
var s = json(path.join(store, 'rutracker_session'));
var forgotten = '  forgotten=' + (!!s && s.forgotten === true);
if (!s || typeof s !== 'object') console.log('session:    no store');
else if (!s.session || typeof s.session !== 'object') console.log('session:    none' + forgotten);
else console.log('session:    source=' + s.session.source + ' host=' + s.session.host +
    ' user(' + String(s.session.user || '').length + ') cookies=' + names(s.session.cookie) +
    ' ua(' + String(s.session.ua || '').length + ')' + forgotten);

var c = json(path.join(store, 'rutracker_clearance'));
var pair = c && typeof c === 'object' && c.pair && typeof c.pair === 'object' ? c.pair : null;
console.log('clearance:  ' + (pair ? 'host=' + pair.host + ' value(' + String(pair.value).length + ') ua(' +
    String(pair.ua || '').length + ') expires=' + pair.expires : 'none (plugin store)'));

var jar = json(path.join(p, 'settings', 'httpcookies'));
if (!Array.isArray(jar)) jar = [];
console.log('core jar:   ' + (jar.map(function (x) {
    return x.name + '(' + String(x.value).length + ')@' + x.domain + x.path + (x.imported ? ' [Core record]' : '');
}).join('  ') || 'empty'));

var k = json(path.join(p, 'settings', 'keyring'));
var entry = k && typeof k === 'object' && k['plugin-rutracker@local'];
if (!entry || typeof entry !== 'object') entry = null;
console.log('keyring:    ' + (entry ? Object.keys(entry).map(function (n) {
    return n + '(' + String(entry[n]).length + ')';
}).join(' ') : 'none'));

var db = path.join(p, 'webkit', 'Default', 'Cookies');
if (fs.existsSync(db)) {
    try {
        //  SQLite's online backup of the live database (read-only, WAL
        //  included) into memory: one consistent snapshot, no copy on disk.
        var rows = execFileSync('python3', ['-c',
            'import sqlite3,sys\n' +
            'src=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\n' +
            'c=sqlite3.connect(":memory:")\nsrc.backup(c)\nsrc.close()\n' +
            'print("  ".join("%s(%d)@%s%s" % r for r in c.execute("select name, length(encrypted_value)+length(value), host_key, path from cookies where host_key like \'%rutracker%\' order by name")))',
            db], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
        console.log('browser:    ' + (rows || 'no RuTracker cookies'));
    }
    catch (e) {
        console.log('browser:    unreadable (' + e.message.split('\n')[0] + ')');
    }
}
else console.log('browser:    no cookie database');

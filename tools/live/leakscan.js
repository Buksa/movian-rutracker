#!/usr/bin/env node
/*
 * Looks for the live RuTracker cookie values of the Orca browser in files and
 * prints each file with the cookie NAMES found in it, never a value. Exits 1
 * when a value turns up anywhere but the plugin store (store/rutracker_bridge),
 * which is where the bridge is meant to keep it.
 *
 *   node tools/live/leakscan.js [--db <Cookies>] <dir|file>...
 *
 * Typical targets: the start.sh profile ($LIVE_DIR), Movian's own logs.
 * Values shorter than 8 characters (bb_ssl=1) are skipped: they would match
 * everywhere.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var orca = require('../../m7-cookie-bridge/tools/orca-session-push.js');

var STORE = /(^|\/)store\/rutracker_bridge$/;

function walk(p, out) {
    var st;
    try { st = fs.statSync(p); } catch (e) { return out; }
    if (st.isDirectory()) fs.readdirSync(p).forEach(function (n) { walk(path.join(p, n), out); });
    else out.push(p);
    return out;
}

function main(argv) {
    var db = '';
    var roots = [];
    for (var i = 0; i < argv.length; i++) {
        if (argv[i] === '--db') db = argv[++i] || '';
        else roots.push(argv[i]);
    }
    if (!roots.length) {
        console.error('usage: leakscan.js [--db <Cookies>] <dir|file>...');
        return 2;
    }
    var found = orca.collectCookies({ db: db }, 'rutracker.org');
    var secrets = (found ? found.cookies : []).filter(function (c) { return c.value.length >= 8; });
    if (!secrets.length) {
        console.error('no RuTracker session in the Orca cookie DB: nothing to look for');
        return 2;
    }
    var leaks = 0;
    roots.forEach(function (root) {
        walk(root, []).forEach(function (f) {
            var text;
            try { text = fs.readFileSync(f).toString('latin1'); } catch (e) { return; }
            var names = secrets.filter(function (c) { return text.indexOf(c.value) !== -1; })
                .map(function (c) { return c.name; });
            if (!names.length) return;
            var rel = path.relative(root, f) || path.basename(f);
            var expected = STORE.test(f);
            if (!expected) leaks++;
            console.log((expected ? 'store ' : 'LEAK  ') + rel + ': ' + names.join(','));
        });
    });
    console.log('looked for ' + secrets.length + ' values (' + secrets.map(function (c) { return c.name; }).join(',') +
        ') in ' + roots.length + ' path(s): ' + (leaks ? leaks + ' leak(s)' : 'no leaks'));
    return leaks ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));

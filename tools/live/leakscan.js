#!/usr/bin/env node
/*
 * Looks for RuTracker cookie values in files and prints each file with the
 * cookie NAMES found in it, never a value. Exits 1 when a value turns up
 * anywhere but the Session Coordinator's store (store/rutracker_session),
 * which is where the plugin keeps the Active Session.
 *
 *   node tools/live/leakscan.js [--db <Cookies> | --values <file> | --store <file>] <dir|file>...
 *
 * The values are the live ones of the Orca browser's cookie DB; with
 * --values, synthetic ones: a file of name=value lines (a run seeded with
 * made-up secrets needs no real session); with --store, the Active Session
 * of the run itself, read from the coordinator's store file and kept in
 * memory only (scan before mgo-stop.sh --wipe). Typical targets: profile and
 * cache of the run, Movian's own logs. Values shorter than 8 characters
 * (bb_ssl=1) are skipped: they would match everywhere.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var orca = require('../../m7-cookie-bridge/tools/orca-session-push.js');

var STORE = /(^|\/)store\/rutracker_session$/;

/* name=value lines; blank lines and # comments are skipped. */
function readValues(file) {
    return fs.readFileSync(file, 'utf8').split('\n').map(function (l) { return l.trim(); })
        .filter(function (l) { return l && l[0] !== '#' && l.indexOf('=') > 0; })
        .map(function (l) { return { name: l.slice(0, l.indexOf('=')), value: l.slice(l.indexOf('=') + 1) }; });
}

/* The cookies of the Active Session in a coordinator store file
 * ({"session": {"cookie": "a=1; b=2", ...}}). */
function readStore(file) {
    var rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')).session; } catch (e) { return []; }
    return String(rec && rec.cookie || '').split(';').map(function (p) { return p.trim(); })
        .filter(function (p) { return p.indexOf('=') > 0; })
        .map(function (p) { return { name: p.slice(0, p.indexOf('=')), value: p.slice(p.indexOf('=') + 1) }; });
}

function walk(p, out) {
    var st;
    try { st = fs.statSync(p); } catch (e) { return out; }
    if (st.isDirectory()) fs.readdirSync(p).forEach(function (n) { walk(path.join(p, n), out); });
    else out.push(p);
    return out;
}

function main(argv) {
    var db = '', values = '', store = '';
    var roots = [];
    for (var i = 0; i < argv.length; i++) {
        if (argv[i] === '--db') db = argv[++i] || '';
        else if (argv[i] === '--values') values = argv[++i] || '';
        else if (argv[i] === '--store') store = argv[++i] || '';
        else roots.push(argv[i]);
    }
    if (!roots.length) {
        console.error('usage: leakscan.js [--db <Cookies> | --values <file>] <dir|file>...');
        return 2;
    }
    var found = values ? { cookies: readValues(values) } : store ? { cookies: readStore(store) } :
        orca.collectCookies({ db: db }, 'rutracker.org');
    var secrets = (found ? found.cookies : []).filter(function (c) { return c.value.length >= 8; });
    if (!secrets.length) {
        console.error('no RuTracker cookie values to look for (' + (values || store || 'the Orca cookie DB') + ')');
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

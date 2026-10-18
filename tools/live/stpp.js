#!/usr/bin/env node
/*
 * Drives the Movian started by tools/live/start.sh over its HTTP API and STPP.
 *
 *   node tools/live/stpp.js open <route>            navigate (GET /api/open)
 *   node tools/live/stpp.js page [max]              print the current page:
 *                                                   type | title | url
 *   node tools/live/stpp.js set <prop.path> <value> write one property (STPP SET);
 *                                                   value is JSON, else a string
 *
 * The port comes from $PORT, else from $LIVE_DIR/port written by start.sh.
 * A browser session is pushed with m7-cookie-bridge/tools/orca-session-push.js
 * --stpp ws://127.0.0.1:<port>/api/stpp (add --ua "<the browser's UA>" when
 * no Orca browser tab is open to ask). Accepting the terms on a fresh
 * profile (the popup blocks the plugin otherwise):
 *   node tools/live/stpp.js set settings.apps.nodes.rutracker.nodes.tosaccepted.value true
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');

function port() {
    if (process.env.PORT) return process.env.PORT;
    var dir = process.env.LIVE_DIR || path.join(process.env.TMPDIR || os.tmpdir(), 'rutracker-live');
    return fs.readFileSync(path.join(dir, 'port'), 'utf8').trim();
}

/* An STPP frame, or null. Movian sends child vectors without their closing
 * bracket ("[5,100,0,[1]", Buksa/movian#295); such a frame is read with the
 * bracket added back. */
function parseFrame(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        try { return JSON.parse(text + ']'); } catch (e2) { return null; }
    }
}

function connect(onOpen) {
    var ws = new WebSocket('ws://127.0.0.1:' + port() + '/api/stpp');
    ws.onopen = function () {
        ws.send(JSON.stringify([0, 1, 0])); /* HELLO */
        onOpen(ws);
    };
    ws.onerror = function () {
        console.error('cannot connect to Movian on port ' + port());
        process.exit(1);
    };
    return ws;
}

function set(propPath, raw) {
    var value;
    try { value = JSON.parse(raw); } catch (e) { value = raw; }
    connect(function (ws) {
        ws.send(JSON.stringify([3, 0, propPath, value])); /* SET */
        setTimeout(function () { ws.close(); process.exit(0); }, 400);
    });
}

function open(route) {
    fetch('http://127.0.0.1:' + port() + '/api/open?url=' + encodeURIComponent(route))
        .then(function (res) { console.log('open ' + route + ' -> HTTP ' + res.status); })
        .catch(function (e) { console.error(e.message); process.exit(1); });
}

function page(max) {
    var next = 100;
    var subs = {};
    var page = {};
    var order = [];
    var items = {};
    function sub(ws, propref, prop, cb) {
        var id = next++;
        subs[id] = cb;
        ws.send(JSON.stringify([1, id, propref, prop])); /* SUBSCRIBE */
    }
    var ws = connect(function (ws) {
        var base = 'navigators.current.currentpage.model.';
        ['metadata.title', 'loading', 'error'].forEach(function (f) {
            sub(ws, 0, base + f, function (v) { page[f] = v; });
        });
        sub(ws, 0, base + 'nodes', function (msg) {
            if (!msg || msg[0] !== 5) return; /* ADDNODES */
            msg[3].forEach(function (id) {
                order.push(id);
                items[id] = {};
                ['type', 'metadata.title', 'url'].forEach(function (f) {
                    sub(ws, id, f, function (v) { items[id][f] = v; });
                });
            });
        });
    });
    ws.onmessage = function (e) {
        var m = parseFrame(String(e.data));
        if (!m || !subs[m[1]]) return;
        subs[m[1]](m[0] === 4 ? m[2] : m); /* NOTIFY carries the value */
    };
    setTimeout(function () {
        console.log('title: ' + JSON.stringify(page['metadata.title']) + '  loading=' + page.loading +
            '  error=' + JSON.stringify(page.error) + '  items=' + order.length);
        order.slice(0, max).forEach(function (id) {
            var i = items[id];
            var title = String(i['metadata.title']).replace(/<[^>]+>/g, '');
            console.log('  ' + String(i.type).padEnd(10) + '| ' + title.slice(0, 70) + ' | ' + String(i.url).slice(0, 70));
        });
        ws.close();
        process.exit(0);
    }, 2500);
}

function main() {
    var cmd = process.argv[2];
    if (cmd === 'open' && process.argv[3]) return open(process.argv[3]);
    if (cmd === 'page') return page(parseInt(process.argv[3] || '20', 10));
    if (cmd === 'set' && process.argv[3] && process.argv[4] !== undefined) return set(process.argv[3], process.argv[4]);
    console.error('usage: stpp.js open <route> | page [max] | set <prop.path> <value>');
    process.exit(2);
}

if (require.main === module) {
    main();
}

module.exports = { parseFrame: parseFrame };

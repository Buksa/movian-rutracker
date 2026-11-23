#!/usr/bin/env node
/*
 * Drives the Movian started by tools/live/start.sh over its HTTP API and STPP.
 *
 *   node tools/live/stpp.js open <route>            navigate (GET /api/open)
 *   node tools/live/stpp.js page [max] [--open <route>]
 *                                                   print the current page: its route,
 *                                                   title, loading, error, then
 *                                                   type | title | url per item.
 *                                                   --open first opens the route and
 *                                                   waits until the page it replaced has
 *                                                   loaded (loading is 0) or failed;
 *                                                   it exits 1 after STPP_WAIT_MS (15000)
 *                                                   and prints what it has
 *   node tools/live/stpp.js set <prop.path> <value> write one property (STPP SET);
 *                                                   value is JSON, else a string
 *   node tools/live/stpp.js select <prop.path> <option id>
 *                                                   select a multiopt's option (STPP SELECT,
 *                                                   a binary frame). The option is found by its
 *                                                   title, which must equal its id: true for the
 *                                                   domain setting, not for `list` (Russian
 *                                                   titles; STPP sends no option names). Prints
 *                                                   "already selected" when the value is the id;
 *                                                   otherwise waits STPP_WAIT_MS from connect for
 *                                                   the value to become the id, else exits 1.
 *                                                   Blocked: Movian Go's mgpp_binary.go:305
 *                                                   selects a child "" instead of the option
 *                                                   until Buksa/movian-go#34 is fixed; change
 *                                                   a multiopt through the settings UI meanwhile
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

/* Movian Go's STPP has SELECT only as a binary frame: [8, propRef as uint32 LE]
 * (internal/api/mgpp/mgpp_binary.go:288). Its JSON side announces an option by ref
 * alone (ADDNODES, mgpp_subjson.go:15) and never sends the option's name, so the
 * option is found by its title and the title must equal the id: that holds for the
 * domain setting, not for `list`, whose titles are Russian. The value Movian sends
 * back is compared with the id. The whole wait ends STPP_WAIT_MS after connect. */
function select(propPath, optionId) {
    var next = 100;
    var subs = {};
    var titles = {};  /* ref -> title */
    var found = null; /* ref of the option titled optionId */
    var current;      /* the multiopt value, as Movian last sent it */
    var sent = false;
    var waitMs = parseInt(process.env.STPP_WAIT_MS || '15000', 10);
    var ws;
    function sub(ws, propref, path, cb) {
        var id = next++;
        subs[id] = cb;
        ws.send(JSON.stringify([1, id, propref, path])); /* SUBSCRIBE */
    }
    function done(code, msg) {
        console[code ? 'error' : 'log'](msg);
        ws.close();
        process.exit(code);
    }
    /* Once the option and the value are known: an option already selected sends nothing. */
    function step() {
        if (found === null || current === undefined || sent) return;
        if (current === optionId) done(0, 'already selected ' + optionId);
        sent = true;
        var frame = Buffer.alloc(5);
        frame[0] = 8; /* SELECT */
        frame.writeUInt32LE(found, 1);
        ws.send(frame);
    }
    ws = connect(function (ws) {
        sub(ws, 0, propPath + '.value', function (v) {
            current = v;
            if (sent && v === optionId) done(0, 'changed to ' + optionId);
            step();
        });
        sub(ws, 0, propPath + '.options', function (msg) {
            if (!msg || msg[0] !== 5 || !Array.isArray(msg[3])) return; /* ADDNODES */
            msg[3].forEach(function (ref) {
                sub(ws, ref, 'title', function (title) {
                    titles[ref] = title;
                    if (title === optionId && found === null) {
                        found = ref;
                        step();
                    }
                });
            });
        });
        setTimeout(function () {
            if (found === null) {
                done(1, 'no option titled ' + JSON.stringify(optionId) + ' under ' + propPath + '.options; have ' +
                    JSON.stringify(Object.keys(titles).map(function (ref) { return titles[ref]; })));
            } else if (!sent) {
                done(1, 'no value from ' + propPath + '.value');
            } else {
                done(1, propPath + '.value is ' + JSON.stringify(current) + ' after SELECT, not ' + JSON.stringify(optionId));
            }
        }, waitMs);
    });
    ws.onmessage = function (e) {
        var m = parseFrame(String(e.data));
        if (!m || !subs[m[1]]) return;
        subs[m[1]](m[0] === 4 ? m[2] : m); /* NOTIFY carries the value */
    };
}

function openRoute(route) {
    return fetch('http://127.0.0.1:' + port() + '/api/open?url=' + encodeURIComponent(route));
}

function open(route) {
    openRoute(route)
        .then(function (res) { console.log('open ' + route + ' -> HTTP ' + res.status); })
        .catch(function (e) { console.error(e.message); process.exit(1); });
}

/* route: null prints the current page after a fixed settle. A route is opened
 * and the wait ends on the first of: loading is 0, an error, or the timeout,
 * counting only values sent after the first url notification that follows
 * /api/open. Items of the old page are dropped at that notification. */
function page(max, route) {
    var next = 100;
    var subs = {};
    var page = {};
    var order = [];
    var items = {};
    var opened = false;
    var replaced = false;
    var settling = false;
    var settleTimer = null;
    var waitMs = parseInt(process.env.STPP_WAIT_MS || '15000', 10);
    var ws;
    function sub(ws, propref, prop, cb) {
        var id = next++;
        subs[id] = cb;
        ws.send(JSON.stringify([1, id, propref, prop])); /* SUBSCRIBE */
    }
    function show(code) {
        /* a value Movian did not resend since the route changed is unknown: print null */
        var known = function (v) { return v === undefined ? null : v; };
        console.log('route: ' + JSON.stringify(known(page.url)) + '  title: ' + JSON.stringify(known(page['metadata.title'])) +
            '  loading=' + known(page.loading) + '  error=' + JSON.stringify(known(page.error)) + '  items=' + order.length);
        order.slice(0, max).forEach(function (id) {
            var i = items[id];
            var title = String(i['metadata.title']).replace(/<[^>]+>/g, '');
            console.log('  ' + String(i.type).padEnd(10) + '| ' + title.slice(0, 70) + ' | ' + String(i.url).slice(0, 70));
        });
        ws.close();
        process.exit(code);
    }
    function check() {
        if (!opened) {
            if (page.url === undefined) return; /* the first route value, before /api/open */
            opened = true;
            openRoute(route).then(function (res) {
                if (!res.ok) { console.error('open ' + route + ' -> HTTP ' + res.status); process.exit(1); }
            }).catch(function (e) { console.error(e.message); process.exit(1); });
            return;
        }
        if (!replaced) return;
        /* shortcut: Movian sends the error just after loading 0 (navigator.c:990), so wait 100 ms
         * for it; a page whose error comes later than that prints error=null. A url change within
         * the 100 ms cancels the timer (the plugin redirects after loading false, routes.js paged()). */
        if ((page.loading === 0 || page.error) && !settling) {
            settling = true;
            settleTimer = setTimeout(function () {
                settling = false;
                if (page.loading === 0 || page.error) show(0);
            }, 100);
        }
    }
    ws = connect(function (ws) {
        var base = 'navigators.current.currentpage.';
        sub(ws, 0, base + 'url', function (v) {
            if (opened) {
                /* Any url after /api/open means the page is being replaced, also for the same
                 * route and for null (Movian Go sends null first). The old page's loading,
                 * error and items must not end the wait. */
                replaced = true;
                clearTimeout(settleTimer);
                settling = false;
                page.loading = page.error = undefined;
                order = [];
            }
            page.url = v;
            if (route !== null) check();
        });
        ['metadata.title', 'loading', 'error'].forEach(function (f) {
            sub(ws, 0, base + 'model.' + f, function (v) { page[f] = v; if (route !== null) check(); });
        });
        sub(ws, 0, base + 'model.nodes', function (msg) {
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
    if (route === null) {
        setTimeout(function () { show(0); }, 2500);
    } else {
        setTimeout(function () {
            console.error('timeout: the page did not load within ' + waitMs + ' ms');
            show(1);
        }, waitMs);
    }
}

function usage() {
    console.error('usage: stpp.js open <route> | page [max] [--open <route>] | set <prop.path> <value> | select <prop.path> <option id>');
    process.exit(2);
}

function main() {
    var cmd = process.argv[2];
    var args = process.argv.slice(3);
    if (cmd === 'open' && args[0]) return open(args[0]);
    if (cmd === 'set' && args[0] && args[1] !== undefined) return set(args[0], args[1]);
    if (cmd === 'select' && args[0] && args[1] !== undefined) return select(args[0], args[1]);
    if (cmd !== 'page') return usage();
    var max = 20;
    var route = null;
    for (var i = 0; i < args.length; i++) {
        if (args[i] === '--open' && args[i + 1] !== undefined) route = args[++i];
        else if (/^\d+$/.test(args[i])) max = parseInt(args[i], 10);
        else return usage();
    }
    page(max, route);
}

if (require.main === module) {
    main();
}

module.exports = { parseFrame: parseFrame };

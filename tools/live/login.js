#!/usr/bin/env node
/*
 * Answers Movian's open login dialog (the auth popup) without the mouse:
 * writes username, password and "Remember me" over STPP, then sends the
 * Enter action, which the dialog's text fields turn into "Ok".
 *
 *   node tools/live/login.js [--remember] <credentials.env>
 *
 * credentials.env holds RUTRACKER_TEST_USER= and RUTRACKER_TEST_PASSWORD=
 * lines (mode 0600, outside the repository). The values never reach the
 * command line or the output. "Remember me" is off unless --remember, so
 * Movian keeps no password in the profile. Open the dialog first (a route
 * that needs a sign-in); the port comes from $PORT, else 42000.
 *
 * Exit 0 means the dialog took the answer and closed, not that the sign-in
 * succeeded: read the plugin log ("candidate from password: status=") or
 * tools/live/state.js for that. Exit 1: no auth dialog, or it stayed open.
 */
'use strict';

var fs = require('fs');

var port = process.env.PORT || '42000';
var args = process.argv.slice(2);
var remember = args.indexOf('--remember') !== -1;
var file = args.filter(function (a) { return a !== '--remember'; })[0];

function fail(msg) {
    console.error(msg);
    process.exit(1);
}

function credentials(path) {
    var out = {};
    String(fs.readFileSync(path, 'utf8')).split('\n').forEach(function (line) {
        var eq = line.indexOf('=');
        if (eq < 1) return;
        var value = line.slice(eq + 1).replace(/\r$/, '');
        //  KEY="value" or KEY='value' as a shell would write it.
        var q = /^(["'])(.*)\1$/.exec(value);
        out[line.slice(0, eq).trim()] = q ? q[2] : value;
    });
    if (!out.RUTRACKER_TEST_USER || !out.RUTRACKER_TEST_PASSWORD) fail('credentials file lacks RUTRACKER_TEST_USER or RUTRACKER_TEST_PASSWORD');
    return out;
}

/* An STPP frame, or null; Movian may drop a closing bracket (see stpp.js). */
function parseFrame(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        try { return JSON.parse(text + ']'); } catch (e2) { return null; }
    }
}

function main() {
    if (!file) fail('usage: login.js [--remember] <credentials.env>');
    var c = credentials(file);
    var ws = new WebSocket('ws://127.0.0.1:' + port + '/api/stpp');
    var timer = setTimeout(function () { fail('no login dialog open'); }, 5000);
    ws.onerror = function () { fail('cannot connect to Movian on port ' + port); };
    var auth = null;
    var types = 200;
    ws.onopen = function () {
        ws.send(JSON.stringify([0, 1, 0]));                 /* HELLO */
        ws.send(JSON.stringify([1, 100, 0, 'popups']));     /* SUBSCRIBE */
    };
    //  Done when no auth popup is left. Polled over HTTP Control: the STPP
    //  subscription sends no reliable delete for a closed popup.
    function closed(deadline) {
        var base = 'http://127.0.0.1:' + port + '/api/prop/global/popups/*';
        Promise.all([0, 1, 2, 3].map(function (i) {
            return fetch(base + i + '/type').then(function (res) { return res.ok ? res.text() : ''; });
        })).then(function (types) {
            if (!types.some(function (t) { return / is a auth\s*$/.test(t); })) {
                console.log('login dialog answered and closed (remember=' + remember + ')');
                ws.close();
                process.exit(0);
            }
            if (Date.now() > deadline) fail('the login dialog is still open');
            setTimeout(function () { closed(deadline); }, 500);
        }).catch(function (err) { fail(err.message); });
    }
    function answer(id) {
        auth = id;
        clearTimeout(timer);
        ws.send(JSON.stringify([3, id, 'username', c.RUTRACKER_TEST_USER]));
        ws.send(JSON.stringify([3, id, 'password', c.RUTRACKER_TEST_PASSWORD]));
        ws.send(JSON.stringify([3, id, 'rememberMe', remember ? 1 : 0]));
        //  The action goes to the UI as a keypress; the focused text field of
        //  the dialog turns it into "Ok". Done when the dialog goes away.
        setTimeout(function () {
            fetch('http://127.0.0.1:' + port + '/api/input/action/Enter').then(function (res) {
                if (res.status !== 200) fail('Enter -> HTTP ' + res.status);
                closed(Date.now() + 10000);
            }).catch(function (err) { fail(err.message); });
        }, 300);
    }
    ws.onmessage = function (e) {
        var m = parseFrame(String(e.data));
        if (!m) return;
        //  A new popup: ask for its type. Only an auth popup is answered; a
        //  SET needs its propref ("popups.*0" would create a new child).
        if (m[0] === 5 && m[1] === 100 && auth === null) {
            m[3].forEach(function (id) {
                var sub = types++;
                ws.send(JSON.stringify([1, sub, id, 'type']));   /* SUBSCRIBE */
                pending[sub] = id;
            });
        }
        else if (m[0] === 4 && pending[m[1]] !== undefined && auth === null && m[2] === 'auth') answer(pending[m[1]]);
    };
    var pending = {};
}

main();

/*
 * tools/live stop scripts: they stop only what their start script started.
 * Linux only (ps --ppid, /proc), like the scripts themselves.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { test, testAsync, section, finish } = require('./harness/tap');

const ROOT = path.resolve(__dirname, '..');

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

section('tools/live');

test('mgo-stop.sh leaves a foreign process that reused the recorded PID, children included', function () {
    /* Codex on PR #10: the children were collected before the PID was
     * checked, so a stranger's children were killed and the script said ok. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-kit-'));
    fs.writeFileSync(path.join(dir, '.rutracker-mgo-live'), '');
    const parent = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    try {
        spawnSync('sleep', ['0.3']);
        const child = +String(spawnSync('ps', ['-o', 'pid=', '--ppid', String(parent.pid)]).stdout).trim();
        assert.ok(child > 0, 'the foreign parent has a child');
        fs.writeFileSync(path.join(dir, 'pid'), String(parent.pid));
        spawnSync('sh', [path.join(ROOT, 'tools/live/mgo-stop.sh'), '--keep'], { env: Object.assign({}, process.env, { LIVE_DIR: dir }) });
        assert.ok(alive(parent.pid), 'the foreign parent');
        assert.ok(alive(child), 'the foreign child');
        process.kill(child);
    }
    finally {
        parent.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* stpp.js page against a fake Movian. The frames follow Movian's stpp.c and
 * Movian Go's mgpp_subjson.go; Movian's ADDNODES lacks its last bracket
 * (Buksa/movian#295). Live facts (Movian Go, CEF build, 2026-11-21): loading
 * is a number, null while a page is replaced; the initial values are null;
 * the route can change again after /api/open (a login redirect) and loading
 * then never reaches 0. */
const crypto = require('crypto');
const http = require('http');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const STPP_JS = path.join(ROOT, 'tools', 'live', 'stpp.js');
const BASE = 'navigators.current.currentpage.';

/* Pages by route. delay: ms until the page is filled. stuck: loading stays
 * null (Movian Go's login redirect). hang: loading stays 1. */
const PAGES = {
    'fake://old': { title: 'Old page', items: [['video', '<b>Old</b> A', 'fake://a'], ['dir', 'Old B', 'fake://b']] },
    'fake://new': { delay: 200, title: 'New page', items: [['dir', '<i>New</i> one', 'fake://n']] },
    'fake://broken': { title: 'Broken', error: 'Not found', items: [] },
    'fake://login': { delay: 50, stuck: true, title: 'Login', items: [] },
    'fake://hang': { hang: true, items: [] },
    /* the plugin sends loading false, then redirects (routes.js paged(), captcha flow) */
    'fake://guest': { title: 'Guest', items: [], redirect: 'fake://login', redirectDelay: 5 },
    'fake://guest-ok': { title: 'Guest', items: [], redirect: 'fake://new', redirectDelay: 5 }
};

function frameOf(text) {
    const body = Buffer.from(text);
    const head = body.length < 126
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    return Buffer.concat([head, body]);
}

/* One client frame (masked), or null while the buffer is short. */
function readFrame(buf) {
    if (buf.length < 2) return null;
    let len = buf[1] & 127;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    if (buf.length < off + 4 + len) return null;
    const key = buf.subarray(off, off + 4);
    const data = Buffer.alloc(len);
    for (let i = 0; i < len; i++) data[i] = buf[off + 4 + i] ^ key[i % 4];
    return { opcode: buf[0] & 15, text: data.toString('utf8'), size: off + 4 + len };
}

function fakeMovian() {
    const subs = [];
    const props = {};
    const received = [];
    let nextId = 1000;
    const cur = { url: null, title: null, loading: null, error: null, nodes: [] };

    function fill(page) {
        cur.title = page.title;
        cur.nodes = page.items.map(function (it) {
            const id = nextId++;
            props[id] = { type: it[0], 'metadata.title': it[1], url: it[2] };
            return id;
        });
    }
    cur.url = 'fake://old';
    fill(PAGES['fake://old']);
    cur.loading = 0;
    cur.error = null;

    function valueOf(sub) {
        if (sub.propref !== 0) {
            const p = props[sub.propref];
            return p ? p[sub.path] : null;
        }
        switch (sub.path) {
            case BASE + 'url': return cur.url;
            case BASE + 'model.metadata.title': return cur.title;
            case BASE + 'model.loading': return cur.loading;
            case BASE + 'model.error': return cur.error;
            case BASE + 'model.nodes': return cur.nodes.slice();
        }
        return null;
    }

    /* Sends a subscription's value when it changed. Nodes go as ADDNODES. */
    function emit(sub) {
        const value = valueOf(sub);
        const json = JSON.stringify(value);
        if (sub.last === json) return;
        sub.last = json;
        if (sub.propref === 0 && sub.path === BASE + 'model.nodes') {
            sub.ws.write(frameOf('[5,' + sub.id + ',0,' + json));  /* no closing bracket */
        } else {
            sub.ws.write(frameOf('[4,' + sub.id + ',' + json + ']'));
        }
    }

    function refresh() { subs.forEach(emit); }

    function show(route) {
        const page = PAGES[route] || { items: [] };
        /* Live (Movian Go, signed in, 2026-11-21): url null, title null, loading null, then
         * the new url, loading 1. Also for the same route again. */
        cur.url = null;
        cur.title = null;
        cur.loading = null;
        cur.error = null;
        cur.nodes = [];
        refresh();
        cur.url = route;
        cur.loading = page.stuck ? null : 1;
        refresh();
        if (page.hang) return;
        setTimeout(function () {
            fill(page);
            refresh();                 /* the items go before loading 0 */
            if (!page.stuck) cur.loading = 0;
            cur.error = page.error || null;
            refresh();                 /* navigator.c:990: loading 0, then the error */
            if (page.redirect) setTimeout(function () { show(page.redirect); }, page.redirectDelay);
        }, page.delay || 0);
    }

    const server = http.createServer(function (req, res) {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname === '/api/open') {
            show(u.searchParams.get('url'));
            res.end('ok');
            return;
        }
        res.statusCode = 404;
        res.end();
    });

    server.on('upgrade', function (req, socket) {
        if (req.url !== '/api/stpp') { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        let buf = Buffer.alloc(0);
        socket.on('error', function () {});
        socket.on('data', function (chunk) {
            buf = Buffer.concat([buf, chunk]);
            for (let f = readFrame(buf); f; f = readFrame(buf)) {
                buf = buf.subarray(f.size);
                if (f.opcode === 8) { socket.end(); return; }
                if (f.opcode !== 1) continue;
                const m = JSON.parse(f.text);
                received.push(m);
                if (m[0] === 1) {          /* SUBSCRIBE [1,id,propref,path] */
                    const sub = { ws: socket, id: m[1], propref: m[2], path: m[3], last: undefined };
                    subs.push(sub);
                    emit(sub);
                }
            }
        });
    });

    return new Promise(function (resolve) {
        server.listen(0, '127.0.0.1', function () {
            resolve({
                port: server.address().port,
                received: received,
                close: function () { server.closeAllConnections(); server.close(); }
            });
        });
    });
}

function runStpp(port, args, env) {
    return new Promise(function (resolve) {
        const child = spawn(process.execPath, [STPP_JS].concat(args), {
            env: Object.assign({}, process.env, { PORT: String(port) }, env || {})
        });
        let out = '';
        let err = '';
        child.stdout.on('data', function (d) { out += d; });
        child.stderr.on('data', function (d) { err += d; });
        child.on('close', function (code) { resolve({ code: code, out: out, err: err }); });
    });
}

function lines(out) {
    return out.split('\n').filter(Boolean);
}

section('tools/sync-public.sh');

/* Only in a checkout of this repository: the mirror and the copy the script
 * tests have no sync script or no .git. */
const SYNCABLE = fs.existsSync(path.join(ROOT, '.git')) && fs.existsSync(path.join(ROOT, 'tools/sync-public.sh'));

test('--check fails when the copy list lacks a file the tests read, and leaves the mirror alone (#49)', function () {
    /* Retro 2026-11-22: since #38 tests/run.js reads docs/agents/live-e2e.md,
     * which the copy list lacked; only the real run's last step noticed. */
    if (!SYNCABLE) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-public-'));
    /* A commit hook runs this with GIT_DIR, GIT_INDEX_FILE and the like set
     * for this repository: the clone's git must not see them. */
    const env = {};
    Object.keys(process.env).forEach(function (k) { if (k.indexOf('GIT_') !== 0) env[k] = process.env[k]; });
    const git = function (cwd, args) {
        const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null'].concat(args), { cwd: cwd, env: env, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, args.join(' ') + ': ' + res.stderr);
    };
    try {
        const repo = path.join(dir, 'repo');
        const pub = path.join(dir, 'pub');
        git(dir, ['clone', '-q', ROOT, repo]);
        const script = path.join(repo, 'tools/sync-public.sh');
        /* The working copy of the script: the one under test, committed or not. */
        fs.writeFileSync(script, fs.readFileSync(path.join(ROOT, 'tools/sync-public.sh'), 'utf8').replace('\ndocs/agents/live-e2e.md ', '\n'));
        git(repo, ['commit', '-q', '-am', 'the copy list lacks a file the tests read']);
        fs.mkdirSync(pub);
        git(pub, ['init', '-q']);
        git(pub, ['remote', 'add', 'origin', 'https://github.com/Buksa/movian-rutracker.git']);
        const res = spawnSync('sh', [script, pub, '--check'], { env: env, encoding: 'utf8' });
        assert.notStrictEqual(res.status, 0, 'the check passed');
        assert.ok(/missing from CODE/.test(res.stderr), res.stderr);
        assert.deepStrictEqual(fs.readdirSync(pub), ['.git'], 'the mirror was touched');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

section('tools/live/stpp.js');

(async function () {
    await testAsync('stpp.js page prints route, title, loading, error and items, markup stripped', async function () {
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page']);
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://old"  title: "Old page"  loading=0  error=null  items=2',
                '  video     | Old A | fake://a',
                '  dir       | Old B | fake://b'
            ]);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page [max] prints at most max items', async function () {
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '1']);
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://old"  title: "Old page"  loading=0  error=null  items=2',
                '  video     | Old A | fake://a'
            ]);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page --open prints the new page, not the old one', async function () {
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '--open', 'fake://new']);
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://new"  title: "New page"  loading=0  error=null  items=1',
                '  dir       | New one | fake://n'
            ]);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page --open ends when the current route is reopened (url null, then the same url)', async function () {
        /* Movian Go live (2026-11-21): reopening rutracker:start ended in a timeout. */
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '--open', 'fake://old'], { STPP_WAIT_MS: '3000' });
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://old"  title: "Old page"  loading=0  error=null  items=2',
                '  video     | Old A | fake://a',
                '  dir       | Old B | fake://b'
            ]);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page --open returns the error of a page that failed to load', async function () {
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '--open', 'fake://broken']);
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://broken"  title: "Broken"  loading=0  error="Not found"  items=0'
            ]);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page --open does not wait for a final route that never reaches loading 0', async function () {
        /* Movian Go's login redirect: url changes, loading stays null, no 0. */
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '--open', 'fake://login'], { STPP_WAIT_MS: '1000' });
            assert.strictEqual(r.code, 1, 'a timeout exits non-zero');
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://login"  title: "Login"  loading=null  error=null  items=0'
            ]);
            assert.match(r.err, /timeout/);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page --open does not end on loading 0 when a redirect follows it', async function () {
        /* routes.js paged(): loading false, then redirectTo login (Clearance refreshed, guest page back) */
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '--open', 'fake://guest'], { STPP_WAIT_MS: '1000' });
            assert.strictEqual(r.code, 1, 'the login page is not the answer: the wait times out');
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://login"  title: "Login"  loading=null  error=null  items=0'
            ]);
            assert.match(r.err, /timeout/);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page --open prints the redirect target when that one loads', async function () {
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '--open', 'fake://guest-ok']);
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://new"  title: "New page"  loading=0  error=null  items=1',
                '  dir       | New one | fake://n'
            ]);
        } finally { m.close(); }
    });

    await testAsync('stpp.js page --open times out and prints what it has while loading stays 1', async function () {
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['page', '--open', 'fake://hang'], { STPP_WAIT_MS: '1000' });
            assert.strictEqual(r.code, 1, 'a timeout exits non-zero');
            assert.deepStrictEqual(lines(r.out), [
                'route: "fake://hang"  title: null  loading=1  error=null  items=0'
            ]);
            assert.match(r.err, /timeout/);
        } finally { m.close(); }
    });

    await testAsync('stpp.js set writes [3,0,path,value] to Movian', async function () {
        const m = await fakeMovian();
        try {
            const r = await runStpp(m.port, ['set', 'settings.a.b', 'true']);
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(m.received.filter(function (f) { return f[0] === 3; }),
                [[3, 0, 'settings.a.b', true]]);
        } finally { m.close(); }
    });

    finish();
})();

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
    return { opcode: buf[0] & 15, text: data.toString('utf8'), data: data, size: off + 4 + len };
}

/* multi: propPath -> option titles of a multiopt (the first is selected). opts.ignoreSelect: a
 * SELECT frame changes nothing; opts.selectDelay: ms before the value follows a SELECT. */
function fakeMovian(multi, opts) {
    opts = opts || {};
    const subs = [];
    const props = {};
    const received = [];
    const binary = [];
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

    /* A multiopt: its options are children of propPath.options, and its value follows a SELECT. */
    const optRefs = {};
    const values = {};
    Object.keys(multi || {}).forEach(function (p) {
        optRefs[p] = multi[p].map(function (title) {
            const id = nextId++;
            props[id] = { title: title };
            return id;
        });
        values[p + '.value'] = multi[p][0];
    });

    function valueOf(sub) {
        if (sub.propref !== 0) {
            const p = props[sub.propref];
            return p ? p[sub.path] : null;
        }
        if (sub.path in values) return values[sub.path];
        if (sub.path.slice(-8) === '.options') return opts.badNodes ? null : (optRefs[sub.path.slice(0, -8)] || null);
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
        if (sub.propref === 0 && (sub.path === BASE + 'model.nodes' || sub.path.slice(-8) === '.options')) {
            sub.ws.write(frameOf('[5,' + sub.id + ',0,' + json));  /* no closing bracket */
        } else {
            sub.ws.write(frameOf('[4,' + sub.id + ',' + json + ']'));
        }
    }

    function refresh() { subs.forEach(emit); }

    /* SELECT [8, propRef]: the option becomes its multiopt's value, as the callback sets it. */
    function select(ref) {
        Object.keys(optRefs).forEach(function (p) {
            if (optRefs[p].indexOf(ref) < 0 || opts.ignoreSelect) return;
            function apply() {
                values[p + '.value'] = props[ref].title;
                subs.filter(function (s) { return s.propref === 0 && s.path === p + '.value'; }).forEach(emit);
            }
            if (opts.selectDelay) setTimeout(apply, opts.selectDelay); else apply();
        });
    }

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
                if (f.opcode === 2) {
                    binary.push(Array.from(f.data));
                    if (f.data[0] === 8) select(f.data.readUInt32LE(1));
                    continue;
                }
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
                binary: binary,
                optionRef: function (p, title) { return optRefs[p][multi[p].indexOf(title)]; },
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

test('a sync fails when the mirror check fails though its tests pass, and keeps the sync base', function () {
    /* Retro 2026-11-22: the sync ran only the tests in the mirror, so a config
     * CODE lacked (.shellcheckrc) failed ShellCheck there unnoticed. A stub mise
     * fails `run check`; the copied tests themselves pass. */
    if (!SYNCABLE) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-public-'));
    const env = {};
    Object.keys(process.env).forEach(function (k) { if (k.indexOf('GIT_') !== 0) env[k] = process.env[k]; });
    const git = function (cwd, args) {
        const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null'].concat(args), { cwd: cwd, env: env, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, args.join(' ') + ': ' + res.stderr);
    };
    try {
        const repo = path.join(dir, 'repo');
        const pub = path.join(dir, 'pub');
        const bin = path.join(dir, 'bin');
        git(dir, ['clone', '-q', ROOT, repo]);
        const script = path.join(repo, 'tools/sync-public.sh');
        fs.writeFileSync(script, fs.readFileSync(path.join(ROOT, 'tools/sync-public.sh'), 'utf8'));
        git(repo, ['commit', '-q', '--allow-empty', '-am', 'the sync script under test']);
        fs.mkdirSync(pub);
        git(pub, ['init', '-q']);
        git(pub, ['remote', 'add', 'origin', 'https://github.com/Buksa/movian-rutracker.git']);
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'mise'), '#!/bin/sh\n[ "$1 $2" = "run check" ] || exit 0\necho "✗ shellcheck – ERROR"\nexit 1\n', { mode: 0o755 });
        const res = spawnSync('sh', [script, pub], { env: Object.assign({}, env, { PATH: bin + path.delimiter + env.PATH }), encoding: 'utf8' });
        assert.strictEqual(res.status, 1, res.stdout + res.stderr);
        assert.ok(/mise run check fails in the mirror/.test(res.stderr) && /✗ shellcheck/.test(res.stderr), res.stderr);
        assert.ok(!fs.existsSync(path.join(repo, '.codex/public-sync-base')), 'the sync base moved on a failed check');
        const log = /full log: (\S+)\)/.exec(res.stderr);
        if (log) fs.rmSync(log[1], { force: true });
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

    const DOMAIN = 'settings.a.domain';
    const TITLES = { [DOMAIN]: ['https://a.example', 'https://b.example'] };

    await testAsync('stpp.js select sends the option ref as a SELECT frame and exits 0 when the value follows', async function () {
        const m = await fakeMovian(TITLES);
        try {
            const r = await runStpp(m.port, ['select', DOMAIN, 'https://b.example']);
            assert.strictEqual(r.code, 0, r.err);
            /* 1003 (0x3eb) is the second option: [8, propRef as uint32 LE] */
            assert.strictEqual(m.optionRef(DOMAIN, 'https://b.example'), 1003);
            assert.deepStrictEqual(m.binary, [[8, 0xeb, 0x03, 0, 0]]);
            assert.ok(m.received.some(function (f) { return f[0] === 1 && f[2] === 0 && f[3] === DOMAIN + '.options'; }), 'no subscription to the options');
        } finally { m.close(); }
    });

    await testAsync('stpp.js select exits 1 and names the titles it found when no option has that title', async function () {
        const m = await fakeMovian(TITLES);
        try {
            const r = await runStpp(m.port, ['select', DOMAIN, 'https://c.example'], { STPP_WAIT_MS: '1000' });
            assert.strictEqual(r.code, 1);
            assert.ok(/no option titled "https:\/\/c.example"/.test(r.err), r.err);
            assert.ok(/https:\/\/a.example/.test(r.err), r.err);
            assert.deepStrictEqual(m.binary, []);
        } finally { m.close(); }
    });

    await testAsync('stpp.js select exits 1 when the value does not change after SELECT', async function () {
        const m = await fakeMovian(TITLES, { ignoreSelect: true });
        try {
            const r = await runStpp(m.port, ['select', DOMAIN, 'https://b.example']);
            assert.strictEqual(r.code, 1);
            assert.strictEqual(m.binary.length, 1);
            assert.ok(/after SELECT, not "https:\/\/b.example"/.test(r.err), r.err);
        } finally { m.close(); }
    });

    await testAsync('stpp.js select reports "already selected" and sends no SELECT when the value already is the id', async function () {
        const m = await fakeMovian(TITLES);
        try {
            const r = await runStpp(m.port, ['select', DOMAIN, 'https://a.example']);
            assert.strictEqual(r.code, 0, r.err);
            assert.ok(/^already selected https:\/\/a.example/.test(r.out), r.out);
            assert.deepStrictEqual(m.binary, []);
        } finally { m.close(); }
    });

    await testAsync('stpp.js select waits for a late value up to STPP_WAIT_MS, not a fixed 400 ms', async function () {
        const m = await fakeMovian(TITLES, { selectDelay: 700 });
        try {
            const r = await runStpp(m.port, ['select', DOMAIN, 'https://b.example'], { STPP_WAIT_MS: '3000' });
            assert.strictEqual(r.code, 0, r.err);
            assert.ok(/^changed to https:\/\/b.example/.test(r.out), r.out);
            assert.strictEqual(m.binary.length, 1);
        } finally { m.close(); }
    });

    await testAsync('stpp.js select does not crash on an ADDNODES whose child vector is not an array', async function () {
        const m = await fakeMovian(TITLES, { badNodes: true });
        try {
            const r = await runStpp(m.port, ['select', DOMAIN, 'https://b.example'], { STPP_WAIT_MS: '500' });
            assert.strictEqual(r.code, 1);
            assert.ok(/no option titled/.test(r.err), r.err);
        } finally { m.close(); }
    });

    await testAsync('stpp.js select counts STPP_WAIT_MS from connect and exits 1 when the value came after it', async function () {
        const m = await fakeMovian(TITLES, { selectDelay: 700 });
        try {
            const r = await runStpp(m.port, ['select', DOMAIN, 'https://b.example'], { STPP_WAIT_MS: '500' });
            assert.strictEqual(r.code, 1);
            assert.ok(/after SELECT, not "https:\/\/b.example"/.test(r.err), r.err);
        } finally { m.close(); }
    });

    section('tools/live/android.sh');

    /* adb on PATH logs its arguments and answers what the script parses. Forwards live in
     * kit.fwd as "SERIAL LOCAL REMOTE" lines: a plain forward rebinds a local port (as adb
     * does), --no-rebind refuses one that is taken. */
    function androidKit(hash) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-kit-'));
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'adb'), [
            '#!/bin/sh',
            'echo "$*" >> "$ADB_LOG"',
            'S=$2',
            'F=$ADB_FWD',
            'case "$3" in',
            '  forward)',
            '    if [ "$4" = --list ]; then [ -n "$ADB_LIST_FAIL" ] && exit 17; cat "$F" 2>/dev/null; exit 0; fi',
            '    if [ "$4" = --remove ]; then awk -v s="$S" -v l="$5" \'!($1 == s && $2 == l)\' "$F" > "$F.n" 2>/dev/null; mv -f "$F.n" "$F"; exit 0; fi',
            '    if [ "$4" = --no-rebind ]; then',
            '      if awk -v l="$5" \'$2 == l { t = 1 } END { exit !t }\' "$F" 2>/dev/null; then echo "cannot bind $5" >&2; exit 1; fi',
            '      echo "$S $5 $6" >> "$F"; exit 0',
            '    fi',
            '    awk -v l="$4" \'$2 != l\' "$F" 2>/dev/null > "$F.n"; echo "$S $4 $5" >> "$F.n"; mv -f "$F.n" "$F"; exit 0 ;;',
            '  pull) printf "log\\n" > "$5/$(basename "$4")" && chmod 644 "$5/$(basename "$4")" ;;',
            '  shell)',
            '    if [ -n "$ADB_DEV" ]; then c=$(printf "%s" "$4" | sed "s#/data/local/tmp#$ADB_DEV#g")',
            /* ADB_TAIL: the phone logcat is a tail copy, which takes --retry -f <file> */
            '      [ -n "$ADB_TAIL" ] && c=$(printf "%s" "$c" | sed "s#-v time -f \\\\([^ ]*\\\\) -r 20000 -n 2#--retry -f \\\\1#")',
            '      sh -c "$c"; exit $?; fi',
            '    case "$*" in',
            '      *run-as*) [ -n "$ADB_RUNAS_FAIL" ] && exit 1; echo "$ADB_HASH  files/mrp/installed/rutracker@local.zip" ;;',
            '      *setsid*) echo "STARTED 99" ;;',
            '    esac ;;',
            'esac',
            'exit 0'
        ].join('\n') + '\n', { mode: 0o755 });
        const zip = path.join(dir, 'plugin.zip');
        fs.writeFileSync(zip, 'zip bytes');
        return { dir: dir, bin: bin, zip: zip, log: path.join(dir, 'adb.log'), fwd: path.join(dir, 'fwd'),
            live: path.join(dir, 'live'), dev: path.join(dir, 'dev'), hash: hash };
    }

    function runAndroid(kit, args, env) {
        return new Promise(function (resolve) {
            const child = spawn('sh', [path.join(ROOT, 'tools/live/android.sh')].concat(args), {
                env: Object.assign({}, process.env, {
                    PATH: kit.bin + path.delimiter + process.env.PATH,
                    ADB_LOG: kit.log, ADB_FWD: kit.fwd, ADB_HASH: kit.hash, LIVE_DIR: kit.live
                }, env || {})
            });
            let out = '';
            let err = '';
            child.stdout.on('data', function (d) { out += d; });
            child.stderr.on('data', function (d) { err += d; });
            child.on('close', function (code) { resolve({ code: code, out: out, err: err }); });
        });
    }

    /* HTTP Control behind the forward: records what the install posts. */
    function controlServer() {
        const posts = [];
        const server = http.createServer(function (req, res) {
            const chunks = [];
            req.on('data', function (c) { chunks.push(c); });
            req.on('end', function () {
                posts.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() });
                res.end('ok');
            });
        });
        return new Promise(function (resolve) {
            server.listen(0, '127.0.0.1', function () {
                resolve({ port: server.address().port, posts: posts, close: function () { server.close(); } });
            });
        });
    }

    const SERIAL = 'PHONE1';
    const ZIP_HASH = crypto.createHash('sha256').update('zip bytes').digest('hex');

    await testAsync('android.sh install posts the ZIP and passes when the phone holds the same sha256', async function () {
        const kit = androidKit(ZIP_HASH);
        const ctl = await controlServer();
        try {
            const r = await runAndroid(kit, [SERIAL, 'install', kit.zip], { PORT: String(ctl.port) });
            assert.strictEqual(r.code, 0, r.err);
            assert.deepStrictEqual(ctl.posts, [{ method: 'POST', url: '/api/plugin/install', type: 'application/zip', body: 'zip bytes' }]);
            const log = fs.readFileSync(kit.log, 'utf8');
            assert.ok(log.indexOf('-s ' + SERIAL + ' forward --no-rebind tcp:' + ctl.port + ' tcp:42000') >= 0, log);
            assert.ok(log.indexOf('run-as com.moviango.mediaplayer sha256sum files/mrp/installed/rutracker@local.zip') >= 0, log);
        } finally { ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh install fails when the phone holds another sha256', async function () {
        const kit = androidKit('0'.repeat(64));
        const ctl = await controlServer();
        try {
            const r = await runAndroid(kit, [SERIAL, 'install', kit.zip], { PORT: String(ctl.port) });
            assert.strictEqual(r.code, 1);
            assert.ok(/differs on the phone/.test(r.err), r.err);
        } finally { ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh stop removes the forward that install added, and only once', async function () {
        const kit = androidKit(ZIP_HASH);
        const ctl = await controlServer();
        try {
            const port = { PORT: String(ctl.port) };
            assert.strictEqual((await runAndroid(kit, [SERIAL, 'install', kit.zip], port)).code, 0);
            assert.strictEqual((await runAndroid(kit, [SERIAL, 'stop'], port)).code, 0);
            assert.strictEqual((await runAndroid(kit, [SERIAL, 'stop'], port)).code, 0);
            const removes = fs.readFileSync(kit.log, 'utf8').split('\n').filter(function (l) { return /forward --remove/.test(l); });
            assert.deepStrictEqual(removes, ['-s ' + SERIAL + ' forward --remove tcp:' + ctl.port]);
            assert.strictEqual(fs.readFileSync(kit.fwd, 'utf8'), '');
        } finally { ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh install refuses a local port another serial holds, and touches nothing', async function () {
        const kit = androidKit(ZIP_HASH);
        const ctl = await controlServer();
        try {
            fs.writeFileSync(kit.fwd, 'OTHER tcp:' + ctl.port + ' tcp:9999\n');
            const r = await runAndroid(kit, [SERIAL, 'install', kit.zip], { PORT: String(ctl.port) });
            assert.strictEqual(r.code, 1);
            assert.ok(/already forwarded/.test(r.err), r.err);
            assert.strictEqual(fs.readFileSync(kit.fwd, 'utf8'), 'OTHER tcp:' + ctl.port + ' tcp:9999\n');
            assert.deepStrictEqual(ctl.posts, [], 'the ZIP was posted');
        } finally { ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh stop leaves a forward whose mapping changed since install', async function () {
        const kit = androidKit(ZIP_HASH);
        const ctl = await controlServer();
        try {
            const port = { PORT: String(ctl.port) };
            assert.strictEqual((await runAndroid(kit, [SERIAL, 'install', kit.zip], port)).code, 0);
            /* someone else now holds the same local port on this serial */
            fs.writeFileSync(kit.fwd, SERIAL + ' tcp:' + ctl.port + ' tcp:9999\n');
            const r = await runAndroid(kit, [SERIAL, 'stop'], port);
            assert.strictEqual(r.code, 0, r.err);
            assert.ok(/left alone/.test(r.out), r.out);
            assert.strictEqual(fs.readFileSync(kit.fwd, 'utf8'), SERIAL + ' tcp:' + ctl.port + ' tcp:9999\n');
            const log = fs.readFileSync(kit.log, 'utf8');
            assert.ok(log.indexOf('forward --remove') < 0, log);
        } finally { ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh install refuses an empty phone hash and an adb run-as that fails', async function () {
        const kit = androidKit('');
        const ctl = await controlServer();
        try {
            const r = await runAndroid(kit, [SERIAL, 'install', kit.zip], { PORT: String(ctl.port) });
            assert.strictEqual(r.code, 1);
            assert.ok(/differs on the phone/.test(r.err), r.err);
        } finally { ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
        const kit2 = androidKit(ZIP_HASH);
        const ctl2 = await controlServer();
        try {
            const r = await runAndroid(kit2, [SERIAL, 'install', kit2.zip], { PORT: String(ctl2.port), ADB_RUNAS_FAIL: '1' });
            assert.strictEqual(r.code, 1);
            assert.ok(/run-as/.test(r.err), r.err);
        } finally { ctl2.close(); fs.rmSync(kit2.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh install hashes the ZIP before it posts, and posts nothing when it cannot', async function () {
        const kit = androidKit(ZIP_HASH);
        const ctl = await controlServer();
        try {
            fs.chmodSync(kit.zip, 0o000);
            const r = await runAndroid(kit, [SERIAL, 'install', kit.zip], { PORT: String(ctl.port) });
            if (process.getuid && process.getuid() === 0) return;   /* root reads any file */
            assert.strictEqual(r.code, 1);
            assert.ok(/cannot read/.test(r.err), r.err);
            assert.deepStrictEqual(ctl.posts, []);
        } finally { fs.chmodSync(kit.zip, 0o600); ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-pull copies the phone log and its rotated copy as 0600 files', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        try {
            dev.mark(999999, '1');
            const dest = path.join(kit.dir, 'pulled');
            const r = await runAndroid(kit, [SERIAL, 'log-pull', dest], { ADB_DEV: kit.dev });
            assert.strictEqual(r.code, 0, r.err);
            ['rutracker-live.1.log', 'rutracker-live.1.log.1'].forEach(function (name) {
                const file = path.join(dest, name);
                assert.ok(r.out.indexOf(file) >= 0, r.out);
                assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, name);
            });
        } finally { fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-start runs the phone logcat under umask 077 in the same adb command', async function () {
        const kit = androidKit(ZIP_HASH);
        try {
            const r = await runAndroid(kit, [SERIAL, 'log-start']);
            assert.strictEqual(r.code, 0, r.err);
            const line = fs.readFileSync(kit.log, 'utf8').split('\n').filter(function (l) { return /setsid/.test(l); })[0];
            assert.ok(line, 'no logcat command was sent');
            assert.ok(line.indexOf('umask 077;') >= 0 && line.indexOf('umask 077;') < line.indexOf('setsid nohup logcat'), line);
        } finally { fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    /* The phone side runs locally: adb shell is sh -c with /data/local/tmp moved to kit.dev. A
     * "logcat" is a copy of tail, so its exe is named logcat and -f follows the file. */
    function devKit(kit) {
        fs.mkdirSync(kit.dev);
        const log = path.join(kit.dev, 'rutracker-live.1.log');
        fs.writeFileSync(log, 'line\n');
        fs.writeFileSync(log + '.1', 'older\n');
        const pid = path.join(kit.dev, 'rutracker-live.pid');
        /* the marker log-start writes: pid, start time (stat field 22), file */
        function mark(p, start, file) {
            fs.writeFileSync(pid, p + ' ' + (start === undefined ? startOf(p) : start) + ' ' + (file || log) + '\n');
        }
        return { log: log, pid: pid, mark: mark };
    }

    function startOf(pid) {
        const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }

    function fakeLogcat(kit, logFile, ignoreTerm) {
        const exe = path.join(kit.bin, 'logcat');
        fs.copyFileSync(spawnSync('sh', ['-c', 'command -v tail'], { encoding: 'utf8' }).stdout.trim(), exe);
        fs.chmodSync(exe, 0o755);
        return ignoreTerm
            ? spawn('sh', ['-c', 'trap "" TERM; exec "$0" -f "$1"', exe, logFile], { stdio: 'ignore' })
            : spawn(exe, ['-f', logFile], { stdio: 'ignore' });
    }

    /* Polls until pid runs as logcat, so the device check sees the exec'd process. */
    async function waitLogcat(pid) {
        for (let i = 0; i < 100; i++) {
            try { if (fs.readlinkSync('/proc/' + pid + '/exe').endsWith('/logcat')) return; } catch (e) { /* not yet */ }
            await new Promise(function (r) { setTimeout(r, 20); });
        }
        throw new Error('pid ' + pid + ' never ran as logcat');
    }

    /* The exit may have come before this call, while the script ran. */
    function exited(child) {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        return new Promise(function (resolve) { child.on('exit', resolve); });
    }

    await testAsync('android.sh log-stop stops a logcat whose pid, exe and -f file are ours, then deletes its files', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        const child = fakeLogcat(kit, dev.log);
        try {
            await waitLogcat(child.pid);
            dev.mark(child.pid);
            const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev });
            assert.strictEqual(r.code, 0, r.err);
            await exited(child);
            assert.deepStrictEqual(fs.readdirSync(kit.dev), [], 'the marker or the logs were left');
            const log = fs.readFileSync(kit.log, 'utf8');
            assert.ok(!/pkill/.test(log), log);
        } finally { child.kill('SIGKILL'); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-stop keeps the marker and the files when the logcat does not stop', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        const child = fakeLogcat(kit, dev.log, true);
        try {
            await waitLogcat(child.pid);
            dev.mark(child.pid);
            const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev });
            assert.notStrictEqual(r.code, 0);
            assert.ok(/did not stop/.test(r.err), r.err);
            assert.ok(fs.existsSync(dev.pid) && fs.existsSync(dev.log) && fs.existsSync(dev.log + '.1'));
        } finally { child.kill('SIGKILL'); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-stop leaves a live process that is not our logcat, though it has our -f file', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        const other = spawn('tail', ['-f', dev.log], { stdio: 'ignore' });   /* -f is ours, exe is not logcat */
        try {
            dev.mark(other.pid);
            const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev });
            assert.notStrictEqual(r.code, 0);
            assert.ok(/is not our logcat/.test(r.err), r.err);
            assert.ok(fs.existsSync(dev.pid) && fs.existsSync(dev.log));
            assert.ok(fs.existsSync('/proc/' + other.pid), 'the process was not ours, yet it was killed');
        } finally { other.kill('SIGKILL'); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-stop without a marker deletes nothing', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev });
        assert.strictEqual(r.code, 0, r.err);
        assert.ok(/nothing deleted/.test(r.out), r.out);
        assert.ok(fs.existsSync(dev.log) && fs.existsSync(dev.log + '.1'));
        fs.rmSync(kit.dir, { recursive: true, force: true });
    });

    await testAsync('android.sh log-start refuses while our logcat runs and starts nothing', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        const child = fakeLogcat(kit, dev.log);
        try {
            await waitLogcat(child.pid);
            dev.mark(child.pid);
            const r = await runAndroid(kit, [SERIAL, 'log-start'], { ADB_DEV: kit.dev });
            assert.notStrictEqual(r.code, 0);
            assert.ok(/still runs/.test(r.err), r.err);
            assert.strictEqual(fs.readFileSync(dev.pid, 'utf8'), child.pid + ' ' + startOf(child.pid) + ' ' + dev.log + '\n');
            assert.ok(fs.existsSync('/proc/' + child.pid), 'our logcat was stopped');
        } finally { child.kill('SIGKILL'); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh stop keeps the marker and the forward when adb forward --list fails', async function () {
        const kit = androidKit(ZIP_HASH);
        const ctl = await controlServer();
        try {
            const port = { PORT: String(ctl.port) };
            assert.strictEqual((await runAndroid(kit, [SERIAL, 'install', kit.zip], port)).code, 0);
            const r = await runAndroid(kit, [SERIAL, 'stop'], Object.assign({ ADB_LIST_FAIL: '1' }, port));
            assert.strictEqual(r.code, 1, r.out);
            assert.ok(/marker is kept/.test(r.err), r.err);
            /* with the list back, stop still finds the forward as ours and removes it */
            assert.strictEqual((await runAndroid(kit, [SERIAL, 'stop'], port)).code, 0);
            assert.strictEqual(fs.readFileSync(kit.fwd, 'utf8'), '');
        } finally { ctl.close(); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-start refuses a marker whose logcat is gone and deletes nothing', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        try {
            dev.mark(999999, '1');
            const before = fs.readFileSync(dev.pid, 'utf8');
            const r = await runAndroid(kit, [SERIAL, 'log-start'], { ADB_DEV: kit.dev });
            assert.strictEqual(r.code, 1, r.out);
            assert.ok(/marker is left/.test(r.err), r.err);
            assert.ok(fs.existsSync(dev.log) && fs.existsSync(dev.log + '.1'), 'the last run log was deleted');
            assert.strictEqual(fs.readFileSync(dev.pid, 'utf8'), before);
        } finally { fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-stop leaves a logcat that reuses the marker pid, with our -f file', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        const child = fakeLogcat(kit, dev.log);
        try {
            await waitLogcat(child.pid);
            dev.mark(child.pid, String(Number(startOf(child.pid)) - 1));   /* our run had this pid earlier */
            const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev });
            assert.strictEqual(r.code, 0, r.err);
            await new Promise(function (res) { setTimeout(res, 500); });   /* a signal sent would have landed */
            assert.ok(child.exitCode === null && child.signalCode === null,
                'a process that only reuses the pid was stopped');
        } finally { child.kill('SIGKILL'); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-stop leaves a marker that names a file not of ours', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        try {
            const other = path.join(kit.dir, 'precious.txt');
            fs.writeFileSync(other, 'keep\n');
            dev.mark(999999, '1', other);
            const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev });
            assert.strictEqual(r.code, 1, r.out);
            assert.ok(/not name a log of ours/.test(r.err), r.err);
            assert.ok(fs.existsSync(other) && fs.existsSync(dev.pid));
        } finally { fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    /* Every process a test left that names kit.dev on its command line. */
    function killDev(kit) {
        fs.readdirSync('/proc').filter(function (d) { return /^\d+$/.test(d); }).forEach(function (d) {
            try {
                if (fs.readFileSync('/proc/' + d + '/cmdline', 'utf8').indexOf(kit.dev) >= 0) process.kill(Number(d), 'SIGKILL');
            } catch (e) { /* gone or not ours to read */ }
        });
    }

    await testAsync('android.sh log-start claims the marker first, so a second one at the same time refuses', async function () {
        const kit = androidKit(ZIP_HASH);
        fs.mkdirSync(kit.dev);
        fs.copyFileSync(spawnSync('sh', ['-c', 'command -v tail'], { encoding: 'utf8' }).stdout.trim(), path.join(kit.bin, 'logcat'));
        fs.chmodSync(path.join(kit.bin, 'logcat'), 0o755);
        try {
            const env = { ADB_DEV: kit.dev, ADB_TAIL: '1' };
            const first = runAndroid(kit, [SERIAL, 'log-start'], env);
            await new Promise(function (res) { setTimeout(res, 300); });   /* inside the first one's sleep 1 */
            const second = await runAndroid(kit, [SERIAL, 'log-start'], env);
            const one = await first;
            assert.strictEqual(one.code, 0, one.err);
            assert.strictEqual(second.code, 1, second.out);
            assert.ok(/starting|still runs/.test(second.err), second.err);
            const logs = fs.readdirSync(kit.dev).filter(function (f) { return /\.log$/.test(f); });
            assert.ok(logs.length <= 1, 'two runs: ' + logs.join(' '));
        } finally { killDev(kit); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-stop keeps everything when it cannot read the start time of a live pid', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        const child = fakeLogcat(kit, dev.log);
        const realCat = spawnSync('sh', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim();
        fs.writeFileSync(path.join(kit.bin, 'cat'), '#!/bin/sh\n[ "$1" = "/proc/$ADB_STAT_FAIL/stat" ] && exit 1\nexec ' + realCat + ' "$@"\n', { mode: 0o755 });
        try {
            await waitLogcat(child.pid);
            dev.mark(child.pid);
            const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev, ADB_STAT_FAIL: String(child.pid) });
            assert.strictEqual(r.code, 1, r.out);
            assert.ok(fs.existsSync(dev.pid) && fs.existsSync(dev.log) && fs.existsSync(dev.log + '.1'), 'the run was cleaned while its logcat lives');
            await new Promise(function (res) { setTimeout(res, 300); });
            assert.ok(child.exitCode === null && child.signalCode === null, 'the logcat was signalled');
        } finally { child.kill('SIGKILL'); fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-stop refuses a marker path that splits or climbs out of its run name', async function () {
        const kit = androidKit(ZIP_HASH);
        const dev = devKit(kit);
        try {
            const other = path.join(kit.dir, 'precious');
            fs.writeFileSync(other, 'keep\n');
            const tricks = [
                path.join(kit.dev, 'rutracker-live.') + ' ' + other + ' .log',   /* rm would split it on the spaces */
                path.join(kit.dev, 'rutracker-live.1') + '/../../precious.log'
            ];
            for (const file of tricks) {
                dev.mark(999999, '1', file);
                const r = await runAndroid(kit, [SERIAL, 'log-stop'], { ADB_DEV: kit.dev });
                assert.strictEqual(r.code, 1, file + ': ' + r.out);
                assert.ok(/not name a log of ours/.test(r.err), r.err);
                assert.ok(fs.existsSync(other) && fs.existsSync(dev.pid), file);
            }
        } finally { fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    await testAsync('android.sh log-start stops its own child and drops its file when it is not our logcat', async function () {
        const kit = androidKit(ZIP_HASH);
        fs.mkdirSync(kit.dev);
        /* a "logcat" that execs sleep: its exe is not logcat, so the start check fails */
        fs.writeFileSync(path.join(kit.bin, 'logcat'), '#!/bin/sh\necho $$ > "$ADB_DEV/child.pid"\nexec sleep 30\n', { mode: 0o755 });
        let child = 0;
        try {
            const r = await runAndroid(kit, [SERIAL, 'log-start'], { ADB_DEV: kit.dev });
            assert.strictEqual(r.code, 1, r.out);
            assert.ok(/did not start/.test(r.err), r.err);
            child = Number(fs.readFileSync(path.join(kit.dev, 'child.pid'), 'utf8'));
            await new Promise(function (res) { setTimeout(res, 300); });
            let state = 'gone';
            try { const st = fs.readFileSync('/proc/' + child + '/stat', 'utf8'); state = st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3); } catch (e) { /* reaped */ }
            assert.ok(state === 'gone' || state === 'Z', 'the child still runs: state ' + state);
            assert.deepStrictEqual(fs.readdirSync(kit.dev).filter(function (f) { return f !== 'child.pid'; }), [], 'a marker or a log was left');
        } finally { if (child) { try { process.kill(child, 'SIGKILL'); } catch (e) { /* gone */ } } fs.rmSync(kit.dir, { recursive: true, force: true }); }
    });

    finish();
})();

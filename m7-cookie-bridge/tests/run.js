#!/usr/bin/env node
/*
 * Tests for the Movian Cookie Bridge: core, extension, Orca tool.
 *
 * Runs with plain Node (no dependencies):
 *     node m7-cookie-bridge/tests/run.js
 *
 * Coverage:
 *   - lib/bridge-core.js pure logic (formatting, allow-listing, isolation)
 *   - static checks on the extension sources (permissions, CSP, loopback,
 *     no cookie values in storage); the plugin has its own behavioural
 *     suite in ../../tests/ (node tests/run.js runs both)
 *   - functional checks on tools/orca-session-push.js against a synthetic
 *     Chromium cookie DB (selection, redaction, loopback refusal)
 *
 * These checks do not replace a live run with Movian and a real browser.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = require(path.join(__dirname, '..', 'extension', 'lib', 'bridge-core.js'));

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ok  ' + name);
    } catch (err) {
        failures.push({ name: name, err: err });
        console.log('FAIL  ' + name + '\n      ' + (err && err.message));
    }
}

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ------------------------------------------------------------------ */
console.log('# bridge-core: normalisation');

test('normalizeDomain strips scheme, path, www and lowercases', function () {
    assert.strictEqual(CORE.normalizeDomain('https://www.HDRezka.me/series'), 'hdrezka.me');
    assert.strictEqual(CORE.normalizeDomain('  http://rutracker.org/forum/  '), 'rutracker.org');
});

test('normalizeDomain falls back to profile default', function () {
    assert.strictEqual(CORE.normalizeDomain('', 'rutracker.org'), 'rutracker.org');
    assert.strictEqual(CORE.normalizeDomain(null, 'hdrezka.me'), 'hdrezka.me');
});

test('normalizeHost/normalizePort', function () {
    assert.strictEqual(CORE.normalizeHost('ws://127.0.0.1:42000/api/stpp'), '127.0.0.1');
    assert.strictEqual(CORE.normalizeHost(''), '127.0.0.1');
    assert.strictEqual(CORE.normalizePort('42 000x'), '42000');
    assert.strictEqual(CORE.normalizePort(''), '42000');
});

test('isLoopbackHost only accepts same-device targets Movian listens on', function () {
    ['127.0.0.1', 'localhost'].forEach(function (h) {
        assert.strictEqual(CORE.isLoopbackHost(h), true, h);
    });
    /* IPv6 loopback is refused: Movian's HTTP server opens an AF_INET socket
     * only (asyncio_tcp_bind_socket), so [::1] can never reach it - and the
     * extension CSP/URL building would not handle a bare ::1 (Codex review). */
    ['::1', '[::1]', '192.168.1.10', '10.0.0.5', 'movian.lan', 'example.com'].forEach(function (h) {
        assert.strictEqual(CORE.isLoopbackHost(h), false, h);
    });
});

test('LAN destinations need the explicit opt-in; public ones are never allowed', function () {
    ['192.168.1.10', '10.0.0.5', '172.16.0.1', '172.31.255.1', '169.254.83.107', 'tvbox', 'box.local', 'media.lan']
        .forEach(function (h) {
            assert.strictEqual(CORE.isLanHost(h), true, h);
            assert.strictEqual(CORE.movianHostAllowed(h, false), false, h + ' without opt-in');
            assert.strictEqual(CORE.movianHostAllowed(h, true), true, h + ' with opt-in');
        });
    ['8.8.8.8', '172.32.0.1', '11.0.0.1', 'example.com', 'movian.example.org', '[fe80::1]']
        .forEach(function (h) {
            assert.strictEqual(CORE.movianHostAllowed(h, true), false, h + ' is not local');
        });
    ['127.0.0.1', 'localhost'].forEach(function (h) {
        assert.strictEqual(CORE.movianHostAllowed(h, false), true, h);
    });
    ['::1', '[::1]'].forEach(function (h) {
        assert.strictEqual(CORE.movianHostAllowed(h, true), false, h + ': Movian has no IPv6 listener');
    });
});

test('domainMatches handles subdomains but not lookalikes', function () {
    assert.strictEqual(CORE.domainMatches('rutracker.org', 'rutracker.org'), true);
    assert.strictEqual(CORE.domainMatches('www.rutracker.org', 'rutracker.org'), true);
    assert.strictEqual(CORE.domainMatches('evil-rutracker.org', 'rutracker.org'), false);
    assert.strictEqual(CORE.domainMatches('rutracker.org.evil.com', 'rutracker.org'), false);
});

/* ------------------------------------------------------------------ */
console.log('# bridge-core: cookie formatting');

test('buildCookieHeader sorts by name and joins with "; "', function () {
    const header = CORE.buildCookieHeader([
        { name: 'bb_session', value: 'b' },
        { name: 'bb_data', value: 'a' },
        { name: 'x', value: '' }
    ]);
    assert.strictEqual(header, 'bb_data=a; bb_session=b; x=');
});

test('buildCookieHeader skips malformed entries', function () {
    const header = CORE.buildCookieHeader([null, {}, { name: '' }, { name: 'ok', value: 1 }]);
    assert.strictEqual(header, 'ok=1');
});

test('mergeCookieLists unites the unpartitioned and partitioned namespaces', function () {
    const merged = CORE.mergeCookieLists(
        [{ name: 'bb_session', value: 's' }, { name: 'bb_ssl', value: '1' }],
        [{ name: 'cf_clearance', value: 'c' }]
    );
    assert.deepStrictEqual(merged.map(function (c) { return c.name; }),
        ['bb_session', 'bb_ssl', 'cf_clearance']);
    assert.strictEqual(CORE.buildCookieHeader(merged),
        'bb_session=s; bb_ssl=1; cf_clearance=c');
});

test('mergeCookieLists lets a partitioned cookie win a name clash', function () {
    const merged = CORE.mergeCookieLists(
        [{ name: 'cf_clearance', value: 'stale' }],
        [{ name: 'cf_clearance', value: 'fresh' }]
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].value, 'fresh');
});

test('mergeCookieLists tolerates missing or invalid input', function () {
    assert.deepStrictEqual(CORE.mergeCookieLists(null, undefined), []);
    assert.deepStrictEqual(CORE.mergeCookieLists([null, {}, { name: '' }], null), []);
    assert.deepStrictEqual(CORE.mergeCookieLists(undefined, [{ name: 'x', value: '1' }])
        .map(function (c) { return c.name; }), ['x']);
});

test('mergeCookieLists keeps the longest path on a same-namespace clash', function () {
    const merged = CORE.mergeCookieLists([
        { name: 'bb_session', value: 'root', path: '/' },
        { name: 'bb_session', value: 'forum', path: '/forum/' },
        { name: 'bb_session', value: 'root2', path: '/' }
    ], []);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].value, 'forum');
});

test('parseCookieHeader returns pairs and skips malformed parts', function () {
    assert.deepStrictEqual(CORE.parseCookieHeader(' a=1; junk; =x; b = 2 ;c='),
        [{ name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'c', value: '' }]);
    assert.deepStrictEqual(CORE.parseCookieHeader(null), []);
});

test('parseCookieNames never returns values', function () {
    const names = CORE.parseCookieNames('bb_data=a; bb_session=b; junk; empty=');
    assert.deepStrictEqual(names, ['bb_data', 'bb_session', 'empty']);
    assert.strictEqual(names.join('').indexOf('='), -1);
});

test('describeTransfer exposes counts only', function () {
    const d = CORE.describeTransfer('rutracker', [{ name: 'a', value: 'SECRET' }], 'ua');
    assert.strictEqual(d.cookieCount, 1);
    assert.strictEqual(d.uaLength, 2);
    assert.strictEqual(JSON.stringify(d).indexOf('SECRET'), -1);
});

/* ------------------------------------------------------------------ */
console.log('# bridge-core: profile isolation and STPP paths');

test('HDRezka and RuTracker profiles are isolated', function () {
    const a = CORE.profile('hdrezka');
    const b = CORE.profile('rutracker');
    assert.strictEqual(a.cookiePath, 'settings.apps.nodes.HDRezka.nodes.browserCookie.value');
    assert.strictEqual(b.cookiePath, 'settings.apps.nodes.rutracker_bridge.nodes.browserCookie.value');
    assert.strictEqual(a.uaPath, 'settings.apps.nodes.HDRezka.nodes.browserUA.value');
    assert.strictEqual(b.uaPath, 'settings.apps.nodes.rutracker_bridge.nodes.browserUA.value');
    assert.notStrictEqual(a.cookiePath, b.cookiePath);
    assert.notStrictEqual(a.uaPath, b.uaPath);
});

test('every STPP path segment is dot-free except as separator', function () {
    ['hdrezka', 'rutracker'].forEach(function (id) {
        const p = CORE.profile(id);
        [p.cookiePath, p.uaPath].forEach(function (pp) {
            pp.split('.').forEach(function (seg) {
                assert.ok(seg.length > 0, 'empty segment in ' + pp);
                assert.strictEqual(seg.indexOf('.'), -1, 'segment with dot in ' + pp);
            });
        });
    });
});

test('plugin group id "RuTracker.org" is never used as an STPP path', function () {
    ['hdrezka', 'rutracker'].forEach(function (id) {
        const p = CORE.profile(id);
        assert.strictEqual(p.cookiePath.indexOf('RuTracker.org.'), -1);
    });
});

test('RuTracker exports cookies of its official domains only; HDRezka of any', function () {
    assert.strictEqual(CORE.domainAllowed('rutracker', 'rutracker.org'), true);
    assert.strictEqual(CORE.domainAllowed('rutracker', 'https://www.rutracker.net/forum/'), true);
    ['google.com', 'rutracker.org.evil.com', 'rutracker-org.appspot.com', 'rutracker.lib']
        .forEach(function (d) { assert.strictEqual(CORE.domainAllowed('rutracker', d), false, d); });
    assert.strictEqual(CORE.domainAllowed('hdrezka', 'rezka.ag'), true);
});

test('siteOrigins asks for exactly one site and its subdomains', function () {
    /* Found live: without the http:// origin chrome.cookies.getAll() drops
     * every cookie lacking the Secure flag (bb_guid, bb_ssl, bb_t). */
    assert.deepStrictEqual(CORE.siteOrigins('https://www.Rezka.ag/x'),
        ['https://rezka.ag/*', 'https://*.rezka.ag/*', 'http://rezka.ag/*', 'http://*.rezka.ag/*']);
});

test('a profile is one config entry: paths derive from its settings group', function () {
    CORE.PROFILE_ORDER.forEach(function (id) {
        const p = CORE.profile(id);
        assert.strictEqual(p.cookiePath, 'settings.apps.nodes.' + p.settingsGroup + '.nodes.browserCookie.value');
        assert.strictEqual(p.uaPath, 'settings.apps.nodes.' + p.settingsGroup + '.nodes.browserUA.value');
        assert.strictEqual(p.settingsGroup.indexOf('.'), -1, 'STPP splits paths on dots');
    });
});

test('Movian plugins vendor the core byte-for-byte', function () {
    assert.strictEqual(read('vendor/movian-cookie-bridge/bridge-core.js'),
        read('m7-cookie-bridge/extension/lib/bridge-core.js'),
        'copy m7-cookie-bridge/extension/lib/bridge-core.js to vendor/movian-cookie-bridge/');
});

test('stppSetMessages emits [SET, 0, path, value] for the profile', function () {
    const msgs = CORE.stppSetMessages('rutracker', 'a=1; b=2', 'UA');
    assert.deepStrictEqual(msgs, [
        [3, 0, CORE.profile('rutracker').cookiePath, 'a=1; b=2'],
        [3, 0, CORE.profile('rutracker').uaPath, 'UA']
    ]);
});

/* ------------------------------------------------------------------ */
console.log('# extension: static checks');

const background = read('m7-cookie-bridge/extension/background.js');
const popupJs = read('m7-cookie-bridge/extension/popup.js');
const manifest = JSON.parse(read('m7-cookie-bridge/extension/manifest.json'));

test('popup builds its profile list from the core', function () {
    assert.ok(/PROFILE_ORDER\.forEach/.test(popupJs));
    assert.strictEqual(/<option value=/.test(read('m7-cookie-bridge/extension/popup.html')), false);
});

test('background redacts secret headers', function () {
    assert.ok(/SECRET_HEADERS/.test(background));
    assert.ok(/\[present\]/.test(background));
});

test('background never persists a Cookie header value', function () {
    assert.strictEqual(/chrome\.storage\.local\.set\(\{[^}]*cookieHeader/.test(background), false);
});

test('popup never stores the cookie header', function () {
    assert.strictEqual(/chromeSet\([^)]*cookieHeader/.test(popupJs), false);
});

test('popup writes only counts into status text', function () {
    assert.ok(/cookieCount: /.test(read('m7-cookie-bridge/extension/lib/bridge-core.js')));
    assert.strictEqual(/Cookies: '\s*\+\s*state\.cookieHeader/.test(popupJs), false);
});

test('popup queries cookies by domain, not by URL', function () {
    /* getAll({url}) returns only cookies that would be sent to that URL, and
     * that is path-aware: RuTracker's session cookie sits on path=/forum/ and
     * is dropped when asking for https://rutracker.org/. */
    assert.strictEqual(/chromeGetCookies\(\{\s*url\s*:/.test(popupJs), false,
        'popup still queries cookies by URL and will drop path-scoped cookies');
    assert.ok(/chromeGetCookies\(\{\s*domain\s*:\s*domain\s*\}\)/.test(popupJs),
        'popup must query cookies by domain');
});

test('popup queries the partitioned (CHIPS) cookie namespace too', function () {
    /* Cloudflare marks cf_clearance as partitioned; getAll() returns only the
     * unpartitioned set unless a partitionKey is passed. */
    assert.ok(/partitionKey:\s*\{\s*topLevelSite:\s*site\s*\}/.test(popupJs),
        'popup must request the partitioned namespace');
    assert.ok(/mergeCookieLists\(/.test(popupJs), 'popup must merge both namespaces');
});

test('manifest pre-grants every fixed profile domain (both schemes) and loopback', function () {
    /* http:// too: chrome.cookies hides non-Secure cookies without it. */
    CORE.PROFILE_ORDER.forEach(function (id) {
        const p = CORE.profile(id);
        (p.domains || [p.defaultDomain]).forEach(function (d) {
            CORE.siteOrigins(d).forEach(function (o) {
                assert.ok(manifest.host_permissions.indexOf(o) !== -1, 'missing ' + o);
            });
        });
    });
    assert.ok(manifest.host_permissions.indexOf('http://127.0.0.1/*') !== -1);
    assert.ok(manifest.permissions.indexOf('cookies') !== -1);
});

test('manifest asks for every site only as an optional, user-granted permission', function () {
    ['http://*/*', 'https://*/*', '<all_urls>'].forEach(function (p) {
        assert.strictEqual(manifest.host_permissions.indexOf(p), -1, 'install-time ' + p);
    });
    assert.ok(manifest.optional_host_permissions.indexOf('https://*/*') !== -1);
    assert.strictEqual(manifest.permissions.indexOf('tabs'), -1, 'tabs is not needed for tabs.create');
});

test('extension pages connect to Movian over http/ws only', function () {
    /* CSP cannot express "private networks"; the host policy is enforced in
     * code by BridgeCore.movianHostAllowed (tests above and below). */
    const csp = manifest.content_security_policy.extension_pages;
    const connect = /connect-src ([^;]*)/.exec(csp)[1].trim().split(/\s+/);
    assert.deepStrictEqual(connect, ["'self'", 'http://*:*', 'ws://*:*']);
});

test('popup sends off loopback only with the LAN opt-in, which is off by default', function () {
    assert.strictEqual(/confirm\(/.test(popupJs), false, 'a per-send confirm() is not the opt-in');
    assert.ok(/BridgeCore\.movianHostAllowed\(host, \$\('allowLan'\)\.checked\)/.test(popupJs), 'one host rule');
    const send = popupJs.slice(popupJs.indexOf("$('send')"));
    assert.ok(send.indexOf('hostProblem()') !== -1 && send.indexOf('hostProblem()') < send.indexOf('sendStpp'),
        'host check before sending');
    assert.ok(send.indexOf('domainAllowed') < send.indexOf('sendStpp'), 'profile domain check before sending');
    assert.ok(/requireAllowedHost\(\)/.test(popupJs.slice(popupJs.indexOf("$('clearSession')"))));
    assert.ok(/allowLan: false/.test(popupJs), 'stored default is off');
    const html = read('m7-cookie-bridge/extension/popup.html');
    assert.ok(/<input id="allowLan" type="checkbox">/.test(html), 'unchecked checkbox');
    assert.ok(/без шифрования/.test(html) && /риск/.test(html), 'the label names the risk');
});

/* ------------------------------------------------------------------ */
console.log('# orca session tool: functional checks');

const spawnSync = require('child_process').spawnSync;
const os = require('os');
const TOOL = path.join(ROOT, 'm7-cookie-bridge', 'tools', 'orca-session-push.js');
const SECRET = 'SUPERSECRETSESSIONVALUE';
const SECRET2 = 'SUPERSECRETCLEARANCE';

/* A minimal Chromium-shaped cookie DB. Values must never reach stdout. */
function makeFakeOrcaDb() {
    const { DatabaseSync } = require('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-cookies-'));
    const dbPath = path.join(dir, 'Cookies');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT, ' +
        'is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, ' +
        'expires_utc INTEGER, encrypted_value BLOB)');
    const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('bb_session', SECRET, '.rutracker.org', '/forum/', 1, 1, 0, 0, null);
    ins.run('cf_clearance', SECRET2, '.rutracker.org', '/', 1, 1, 0, 0, null);
    ins.run('other_site', 'othervalue', '.example.com', '/', 0, 0, 0, 0, null);
    db.close();
    return { dbPath: dbPath, dir: dir };
}

function runTool(args) {
    return spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8' });
}

test('orca tool reads a Chromium cookie DB and reports names only', function () {
    const fake = makeFakeOrcaDb();
    try {
        const res = runTool(['--db', fake.dbPath, '--dry-run', '--ua', 'TestUA/1']);
        assert.strictEqual(res.status, 0, res.stderr);
        const out = res.stdout + res.stderr;
        assert.ok(out.indexOf('bb_session') !== -1, 'bb_session missing from report');
        assert.ok(out.indexOf('cf_clearance') !== -1, 'cf_clearance missing from report');
        assert.strictEqual(out.indexOf(SECRET), -1, 'cookie value leaked to output');
        assert.strictEqual(out.indexOf(SECRET2), -1, 'cookie value leaked to output');
        assert.strictEqual(out.indexOf('othervalue'), -1, 'off-domain cookie was included');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('orca tool sends one value per cookie name', function () {
    const fake = makeFakeOrcaDb();
    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(fake.dbPath);
        db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?)')
            .run('bb_session', 'STALEROOTVALUE', 'rutracker.org', '/', 1, 1, 0, 0, null);
        db.close();
        const res = runTool(['--db', fake.dbPath, '--dry-run', '--ua', 'TestUA/1']);
        assert.strictEqual(res.status, 0, res.stderr);
        assert.ok(/cookies\s+: 2 \[bb_session, cf_clearance\]/.test(res.stdout), res.stdout);
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('orca tool reads partitioned rows and sends one value per name', function () {
    const { DatabaseSync } = require('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-cookies-'));
    const dbPath = path.join(dir, 'Cookies');
    try {
        const db = new DatabaseSync(dbPath);
        db.exec('CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT, ' +
            'is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, expires_utc INTEGER, ' +
            'encrypted_value BLOB, top_frame_site_key TEXT)');
        const ins = db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?)');
        ins.run('cf_clearance', 'STALEUNPARTITIONED', '.rutracker.org', '/', 1, 1, 0, 0, null, '');
        ins.run('cf_clearance', 'FRESHPARTITIONED', '.rutracker.org', '/', 1, 1, 0, 0, null, 'https://rutracker.org');
        db.close();
        const res = runTool(['--db', dbPath, '--dry-run', '--ua', 'TestUA/1']);
        assert.strictEqual(res.status, 0, res.stderr);
        /* Which one wins is mergeCookieLists' rule (tested above): partitioned. */
        assert.ok(/cookies\s+: 1 \[cf_clearance\]/.test(res.stdout), res.stdout);
        assert.strictEqual(res.stdout.indexOf('PARTITIONED'), -1, 'no values printed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('orca tool refuses a non-loopback STPP destination', function () {
    const fake = makeFakeOrcaDb();
    try {
        const res = runTool(['--db', fake.dbPath, '--ua', 'TestUA/1',
            '--stpp', 'ws://192.168.1.50:42000/api/stpp']);
        assert.notStrictEqual(res.status, 0, 'tool accepted a non-loopback target');
        assert.ok((res.stderr || '').indexOf('non-loopback') !== -1, res.stderr);
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('orca tool sends to a LAN address only with --allow-lan, never to a public one', function () {
    const fake = makeFakeOrcaDb();
    try {
        const lan = runTool(['--db', fake.dbPath, '--ua', 'TestUA/1', '--timeout', '1',
            '--stpp', 'ws://192.0.2.1:42000/api/stpp']);
        assert.ok((lan.stderr || '').indexOf('public addresses are never allowed') !== -1, lan.stderr);
        const opted = runTool(['--db', fake.dbPath, '--ua', 'TestUA/1', '--timeout', '1', '--allow-lan',
            '--stpp', 'ws://10.255.255.1:9/api/stpp']);
        assert.strictEqual((opted.stderr || '').indexOf('refusing'), -1, 'opt-in accepted: ' + opted.stderr);
        assert.ok(/over the LAN unencrypted/.test(opted.stderr), 'warns about the risk');
        const out = opted.stdout + opted.stderr;
        assert.strictEqual(out.indexOf(SECRET), -1, 'no value printed');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('orca tool aborts when no User-Agent can be determined', function () {
    const fake = makeFakeOrcaDb();
    try {
        const res = spawnSync(process.execPath,
            [TOOL, '--db', fake.dbPath, '--dry-run', '--ua', ''],
            { encoding: 'utf8', env: Object.assign({}, process.env, { ORCA_CLI_COMMAND: 'false' }) });
        assert.notStrictEqual(res.status, 0);
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('orca tool source never prints the assembled cookie header', function () {
    const lines = read('m7-cookie-bridge/tools/orca-session-push.js').split('\n');
    lines.forEach(function (line, i) {
        if (!/console\.(log|error)\(/.test(line)) return;
        if (line.indexOf('header') === -1) return;
        assert.ok(line.indexOf('byteLength') !== -1,
            'possible header leak in tools/orca-session-push.js:' + (i + 1) + ' -> ' + line.trim());
    });
});

test('live leak scan reports names only and tells the store from a leak', function () {
    const fake = makeFakeOrcaDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leakscan-'));
    try {
        const scan = function () {
            return spawnSync(process.execPath, [path.join(ROOT, 'tools', 'live', 'leakscan.js'), '--db', fake.dbPath, dir],
                { encoding: 'utf8' });
        };
        fs.mkdirSync(path.join(dir, 'plugins', 'rutracker@local', 'store'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'plugins', 'rutracker@local', 'store', 'rutracker_bridge'), '{"c":"bb_session=' + SECRET + '"}');
        fs.writeFileSync(path.join(dir, 'movian-0.log'), 'nothing here');
        let res = scan();
        assert.strictEqual(res.status, 0, res.stdout + res.stderr);
        assert.ok(/store .*rutracker_bridge: bb_session/.test(res.stdout), res.stdout);

        fs.writeFileSync(path.join(dir, 'movian-0.log'), 'Cookie: cf_clearance=' + SECRET2);
        res = scan();
        assert.strictEqual(res.status, 1, 'a value in the log is a leak');
        assert.ok(/LEAK  movian-0\.log: cf_clearance/.test(res.stdout), res.stdout);
        const out = res.stdout + res.stderr;
        assert.strictEqual(out.indexOf(SECRET), -1, 'value printed');
        assert.strictEqual(out.indexOf(SECRET2), -1, 'value printed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('live STPP reader takes the child-vector frame Movian sends unclosed', function () {
    /* Buksa/movian#295: "[5,100,0,[1]" lacks its final bracket. */
    const parseFrame = require(path.join(ROOT, 'tools', 'live', 'stpp.js')).parseFrame;
    assert.deepStrictEqual(parseFrame('[5,100,0,[1]'), [5, 100, 0, [1]]);
    assert.deepStrictEqual(parseFrame('[4,101,"title"]'), [4, 101, 'title']);
    assert.strictEqual(parseFrame('not json'), null);
});

/* ------------------------------------------------------------------ */
console.log('');
console.log('passed: ' + passed + ', failed: ' + failures.length);
if (failures.length) {
    failures.forEach(function (f) {
        console.log('- ' + f.name + ': ' + (f.err && f.err.message));
    });
    process.exit(1);
}

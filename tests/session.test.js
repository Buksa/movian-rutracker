/*
 * Session Coordinator (src/bridge/session.js): which Session the plugin
 * sends, and when a Candidate Session may replace it. GLOSSARY.md has the
 * terms, docs/adr/0002 the decision.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { loadPlugin } = require('./harness/movian');
const { test, section, finish } = require('./harness/tap');
const fake = require('./fake-rutracker');

const ROOT = path.resolve(__dirname, '..');
const OTHER = 'bb_session=other-valid-session; bb_guid=g2';

/* A runtime with the Clearance, the client, its inspectors and a
 * coordinator, the way main.js wires them. */
function setup(opts) {
    opts = opts || {};
    const h = loadPlugin({
        pluginDir: ROOT, entry: false, stores: opts.stores,
        server: opts.server || fake.server(opts.serverOptions)
    });
    const clearance = h.require('./src/bridge/clearance').create(opts.base || 'https://rutracker.org');
    const client = h.require('./src/api/client').create(opts.base || 'https://rutracker.org', clearance);
    const session = h.require('./src/bridge/session').create(client, h.require('./src/api/parser'), clearance);
    client.inspect(session);
    h.flush();
    return { h: h, client: client, session: session, clearance: clearance };
}

/* What a Session Source does: its cf_clearance goes to the Clearance, the
 * rest is the Candidate. */
function submit(t, c) {
    t.clearance.offer('https://' + c.host + '/forum/', c.cookie, c.ua);
    return t.session.submit(c);
}

function candidate(extra) {
    return Object.assign({ source: 'password', host: 'rutracker.org', cookie: fake.browserCookie(), ua: fake.BROWSER_UA }, extra || {});
}

/* What a request to `url` would carry with the Active Session applied. */
function sent(t, url) {
    t.h.require('movian/http').request(url, { noFail: true });
    return t.h.requests[t.h.requests.length - 1];
}

function lastCheck(t) {
    return t.h.requests.filter(function (r) { return /viewforum\.php\?f=7$/.test(r.url); }).pop();
}

/* ------------------------------------------------------------------ */
section('session: a Candidate Session replaces the Active Session only when authenticated');

test('a Candidate that passes its Session Check becomes the Active Session', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    const res = submit(t, candidate());
    assert.strictEqual(res.status, 'authenticated');
    assert.strictEqual(t.session.status(), 'authenticated');
    assert.strictEqual(t.session.source(), 'password');
    assert.strictEqual(t.session.user(), 'TestUser');
    const r = sent(t, 'https://rutracker.org/forum/tracker.php?nm=x');
    assert.strictEqual(r.cookies.cf_clearance, fake.CLEARANCE);
    assert.strictEqual(r.headers['user-agent'], fake.BROWSER_UA);
});

test('a Candidate that fails its Session Check leaves the Active Session as it was', function () {
    [
        { name: 'challenge', serverOptions: { cloudflare: true }, cand: { cookie: 'bb_session=' + fake.VALID, ua: 'OtherUA/1' } },
        { name: 'rejected', serverOptions: {}, cand: { cookie: 'bb_session=expired' } },
        { name: 'network_error', serverOptions: { down: true }, cand: {} }
    ].forEach(function (c) {
        const srv = fake.server({ cloudflare: true });
        const t = setup({ server: srv });
        submit(t, candidate());
        const before = t.session.user();
        //  Cloudflare stops a Candidate only when no live Clearance travels with it.
        if (c.name === 'challenge') t.clearance.clear();
        const failing = fake.server(c.serverOptions);
        t.h.server = function (req) { return failing(req); };
        const res = t.session.submit(candidate(Object.assign({ source: 'bridge' }, c.cand)));
        assert.strictEqual(res.status, c.name, c.name);
        assert.strictEqual(t.session.source(), 'password', c.name + ': source kept');
        assert.strictEqual(t.session.user(), before, c.name + ': user kept');
        assert.strictEqual(t.session.status(), 'authenticated', c.name + ': the Active Session status is not the candidate\'s');
        t.h.server = srv;
        assert.strictEqual(sent(t, 'https://rutracker.org/forum/index.php').cookies.bb_session, fake.VALID, c.name + ': old cookies still sent');
    });
});

test('the Session Check carries exactly the Candidate\'s cookies and User-Agent', function () {
    const t = setup();
    t.session.submit(candidate({ cookie: 'bb_session=' + fake.VALID + '; active_only=1', ua: 'ActiveUA/1' }));
    t.h.jar['rutracker.org'] = { jar_only: 'j', bb_session: 'from-the-jar' };
    t.session.submit(candidate({ source: 'password', cookie: OTHER, ua: 'CandidateUA/1' }));
    const check = lastCheck(t);
    assert.deepStrictEqual(check.cookies, { bb_session: 'other-valid-session', bb_guid: 'g2' }, 'no Active Session, no jar cookies');
    assert.strictEqual(check.headers['user-agent'], 'CandidateUA/1');
    assert.strictEqual(check.inspector, null, 'no HTTP inspector ran');
    assert.ok(check.opts.noAuth && check.opts.noFollow && check.opts.verifySSL, JSON.stringify(check.opts));
    assert.ok(!check.opts.debug);
    assert.strictEqual(check.url, 'https://rutracker.org/forum/viewforum.php?f=7');
});

test('a redirect instead of the forum page is not a signed-in page', function () {
    const srv = fake.server();
    const t = setup({ server: function (req) {
        if (/viewforum/.test(req.url) && req.cookies.bb_session === 'moved') return { status: 302, headers: { Location: 'https://evil.example/' } };
        return srv(req);
    } });
    const res = t.session.submit(candidate({ cookie: 'bb_session=moved' }));
    assert.strictEqual(res.status, 'rejected');
    assert.strictEqual(t.session.active(), false);
    assert.strictEqual(t.h.requests.length, 1, 'the redirect was not followed');
});

test('a Candidate without bb_session is not checked and not committed', function () {
    const t = setup();
    ['', 'bb_guid=g1', 'cf_clearance=x; bb_ssl=1', 'bb_session='].forEach(function (cookie) {
        const res = t.session.submit(candidate({ cookie: cookie }));
        assert.strictEqual(res.status, 'rejected', cookie);
    });
    assert.strictEqual(t.h.requests.length, 0);
    assert.strictEqual(t.session.active(), false);
});

test('a Candidate for a host that is not a plain host name is refused', function () {
    const t = setup();
    ['', 'evil.example/x', 'rutracker.org:8080', 'user@rutracker.org', 'rutracker.org.', 'http://rutracker.org'].forEach(function (host) {
        assert.strictEqual(t.session.submit(candidate({ host: host })).status, 'rejected', host);
    });
    assert.strictEqual(t.h.requests.length, 0);
});

test('a Cookie Bridge Candidate is checked on an official domain only', function () {
    const t = setup({ base: 'https://evil.example' });
    assert.strictEqual(t.session.submit(candidate({ source: 'bridge', host: 'evil.example' })).status, 'rejected');
    assert.strictEqual(t.h.requests.length, 0, 'browser cookies never went to a custom domain');
});

/* ------------------------------------------------------------------ */
section('session: where the Active Session is sent');

test('a Password Login Session goes to its own host only, over https', function () {
    const t = setup();
    submit(t, candidate());
    assert.strictEqual(sent(t, 'https://rutracker.org/forum/index.php').cookies.bb_session, fake.VALID);
    ['https://www.rutracker.org/forum/index.php', 'https://rutracker.net/forum/index.php',
        'http://rutracker.org/forum/index.php', 'https://rutracker.org.evil.example/forum/index.php',
        'https://static.example/?u=https://rutracker.org/'].forEach(function (u) {
        assert.strictEqual(sent(t, u).cookies.bb_session || '', '', u);
    });
});

test('a Cookie Bridge Session goes to the official domains over https, as before', function () {
    const t = setup();
    submit(t, candidate({ source: 'bridge' }));
    ['https://rutracker.org/forum/index.php', 'https://www.rutracker.org/forum/index.php', 'https://rutracker.net/forum/index.php']
        .forEach(function (u) { assert.strictEqual(sent(t, u).cookies.bb_session, fake.VALID, u); });
    ['http://rutracker.org/forum/index.php', 'https://rutracker.org.evil.example/']
        .forEach(function (u) { assert.strictEqual(sent(t, u).cookies.bb_session || '', '', u); });
});

/* ------------------------------------------------------------------ */
section('session: after a restart, and later checks');

test('the Active Session survives a restart and is checked again', function () {
    const first = setup();
    submit(first, candidate());
    const t = setup({ stores: first.h.stores });
    assert.strictEqual(t.session.active(), true);
    assert.strictEqual(t.session.source(), 'password');
    assert.strictEqual(lastCheck(t).cookies.bb_session, fake.VALID, 're-checked at start');
    assert.strictEqual(t.session.status(), 'authenticated');
});

test('a later failed check changes the status, never the Session', function () {
    [['network_error', { down: true }], ['challenge', { cloudflare: true }], ['rejected', {}]].forEach(function (c) {
        const first = setup();
        submit(first, candidate({ cookie: c[0] === 'rejected' ? 'bb_session=' + fake.VALID : fake.browserCookie(), ua: c[0] === 'challenge' ? 'OtherUA/1' : fake.BROWSER_UA }));
        const failing = fake.server(c[1]);
        const t = setup({ stores: first.h.stores, server: c[0] === 'rejected' ? function (req) {
            return /viewforum/.test(req.url) ? failing(Object.assign({}, req, { cookies: {} })) : failing(req);
        } : failing });
        assert.strictEqual(t.session.status(), c[0], c[0]);
        assert.strictEqual(t.session.active(), true, c[0] + ': Session kept');
        assert.ok(/bb_session=/.test(JSON.stringify(t.h.stores)), c[0] + ': still saved');
        assert.ok(!/вход выполнен/i.test(t.session.text()), c[0] + ': not shown as signed in: ' + t.session.text());
    });
});

test('forget drops the saved Session, also after a restart', function () {
    const t = setup();
    submit(t, candidate());
    t.session.forget();
    assert.strictEqual(t.session.active(), false);
    //  The Core Jar's copy is hidden: it reads as blank (setCookie(name, '')).
    assert.ok(!sent(t, 'https://rutracker.org/forum/index.php').cookies.bb_session);
    assert.strictEqual(JSON.stringify(t.h.stores).indexOf(fake.VALID), -1);
    assert.strictEqual(setup({ stores: t.h.stores }).session.active(), false);
});

test('the Session is saved in the plugin store, never in settings', function () {
    const t = setup();
    submit(t, candidate());
    assert.deepStrictEqual(Object.keys(t.h.settingsStore), []);
    assert.strictEqual(t.h.stores.rutracker_session.session.cookie, fake.browserCookie().replace(/; cf_clearance=.*$/, ''), 'without cf_clearance');
    assert.strictEqual(t.h.stores.rutracker_clearance.pair.value, fake.CLEARANCE, 'the Clearance keeps it');
});

/* ------------------------------------------------------------------ */
section('session: a Candidate that meets a Challenge (#13)');

test('a Candidate checked with the held Clearance drops that pair when it meets a Challenge', function () {
    const so = { cloudflare: true };
    const t = setup({ serverOptions: so });
    submit(t, candidate());
    assert.strictEqual(t.clearance.forUrl('https://rutracker.org/forum/index.php').cookie, 'cf_clearance=' + fake.CLEARANCE);
    so.clearance = 'refused-clearance';
    const res = t.session.submit(candidate({ source: 'bridge', cookie: 'bb_session=' + fake.VALID + '; bb_guid=g2', ua: 'OtherUA/1' }));
    assert.strictEqual(res.status, 'challenge');
    assert.strictEqual(t.clearance.active(), false, 'the held pair is dropped');
    assert.strictEqual(t.h.stores.rutracker_clearance.pair, '', 'the store holds no pair');
    assert.ok(!sent(t, 'https://rutracker.org/forum/index.php').cookies.cf_clearance, 'the next request carries none');
});

test('a Candidate with its own cf_clearance that meets a Challenge leaves the held Clearance alone', function () {
    /* The pair the Candidate carried is its own, not the held one. */
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    const res = t.session.submit(candidate({ source: 'bridge', cookie: 'bb_session=' + fake.VALID + '; cf_clearance=candidate-own', ua: 'OwnUA/1' }));
    assert.strictEqual(res.status, 'challenge');
    assert.strictEqual(t.clearance.forUrl('https://rutracker.org/forum/index.php').cookie, 'cf_clearance=' + fake.CLEARANCE, 'still held');
    const r = sent(t, 'https://rutracker.org/forum/index.php');
    assert.strictEqual(r.cookies.cf_clearance, fake.CLEARANCE);
    assert.strictEqual(r.headers['user-agent'], fake.BROWSER_UA);
});

/* ------------------------------------------------------------------ */
section('session: a Forget or Clear ends the Candidate Check in flight (#14)');

/* Runs `during` once, while the Session Check of the Candidate waits: what
 * Movian lets another page do during that request. */
function duringCheck(t, during) {
    const site = t.h.server;
    let ran = false;
    t.h.server = function (req) {
        if (!ran && /viewforum\.php\?f=7$/.test(req.url)) {
            ran = true;
            during();
        }
        return site(req);
    };
    return function () { return ran; };
}

test('a Forget while a Candidate Check is in flight cancels it: nothing is saved', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    const ran = duringCheck(t, function () { t.session.forget(); });
    const res = t.session.submit(candidate());
    assert.ok(ran(), 'the Candidate was checked');
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(t.session.active(), false, 'no Active Session');
    assert.strictEqual(t.session.status(), 'empty');
    assert.strictEqual(JSON.stringify(t.h.stores).indexOf(fake.VALID), -1, 'the Session is in no store');
});

test('a Clear while a Candidate Check is in flight cancels it, and keeps the Active Session as it was', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    const ran = duringCheck(t, function () { t.session.cancelChecks(); });
    const res = t.session.submit(candidate({ source: 'bridge', cookie: 'bb_session=' + fake.VALID + '; bb_guid=g2; cf_clearance=' + fake.CLEARANCE, ua: fake.BROWSER_UA }));
    assert.ok(ran(), 'the Candidate was checked');
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(t.session.source(), 'password', 'the Active Session is not forgotten by a Clear');
    assert.strictEqual(t.session.user(), 'TestUser');
});

test('a Candidate checked after a Forget or Clear is saved as usual', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    t.session.forget();
    const res = t.session.submit(candidate({ cookie: 'bb_session=' + fake.OTHER_VALID + '; bb_guid=g2; cf_clearance=' + fake.CLEARANCE }));
    assert.strictEqual(res.status, 'authenticated');
    assert.strictEqual(t.session.user(), fake.OTHER_USER, 'the new account, not the forgotten one');
    t.session.cancelChecks();
    const again = t.session.submit(candidate({ source: 'bridge', cookie: 'bb_session=' + fake.VALID + '; cf_clearance=' + fake.CLEARANCE }));
    assert.strictEqual(again.status, 'authenticated', 'after a Clear too');
    assert.strictEqual(t.session.user(), 'TestUser');
});

/* ------------------------------------------------------------------ */
section('session: a recheck() of the Active Session applies its result only to that Session (#20)');

test('a Forget while recheck() of the Active Session is in flight: no throw, cancelled, nothing saved', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    const ran = duringCheck(t, function () { t.session.forget(); });
    const res = t.session.recheck();
    assert.ok(ran(), 'the Active Session was checked');
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(t.session.status(), 'empty', 'the Forget status stays');
    assert.strictEqual(t.session.active(), false, 'no Active Session');
    assert.strictEqual(JSON.stringify(t.h.stores).indexOf(fake.VALID), -1, 'the Session is in no store');
});

test('a hand-over while recheck() of the Active Session is in flight: the old result does not reach the new Session', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    assert.strictEqual(t.session.user(), 'TestUser');
    /* duringCheck fires on the first Session Check only: the outer recheck()
     * is that one, the Candidate's own check inside submit() is the second. */
    let inner;
    const ran = duringCheck(t, function () {
        inner = t.session.submit(candidate({ cookie: 'bb_session=' + fake.OTHER_VALID + '; bb_guid=g2; cf_clearance=' + fake.CLEARANCE }));
    });
    const res = t.session.recheck();
    assert.ok(ran(), 'the old Active Session was checked');
    assert.strictEqual(inner.status, 'authenticated', 'the hand-over was checked and saved');
    assert.strictEqual(inner.user, fake.OTHER_USER);
    assert.strictEqual(t.session.user(), fake.OTHER_USER, 'the new Session keeps its own user');
    assert.strictEqual(t.h.stores.rutracker_session.session.user, fake.OTHER_USER, 'the store holds the new Session');
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(t.session.status(), 'authenticated', 'the new Session keeps its own status');
});

test('a Clear while recheck() of the Active Session is in flight: no throw, cancelled, the login is not hidden', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    const ran = duringCheck(t, function () { t.session.drop(); });
    const res = t.session.recheck();
    assert.ok(ran(), 'the Active Session was checked');
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(t.session.status(), 'empty');
    assert.strictEqual(t.session.active(), false, 'no Active Session');
    assert.strictEqual(t.session.forgotten(), false, 'a Clear does not hide the login');
    assert.strictEqual(JSON.stringify(t.h.stores).indexOf(fake.VALID), -1, 'the Session is in no store');
});

/* ------------------------------------------------------------------ */
section('session: the later-started Candidate wins; a newer check cancels an older one in flight (#35)');

const OTHER_CANDIDATE = 'bb_session=' + fake.OTHER_VALID + '; bb_guid=g2; cf_clearance=' + fake.CLEARANCE;

test('a newer Candidate that passes cancels the older one in flight; the newer one stays Active', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    let inner;
    const ran = duringCheck(t, function () { inner = t.session.submit(candidate({ cookie: OTHER_CANDIDATE })); });
    const res = t.session.submit(candidate());
    assert.ok(ran(), 'the older Candidate was checked');
    assert.strictEqual(inner.status, 'authenticated', 'the newer Candidate passed');
    assert.strictEqual(res.status, 'cancelled', 'the older one is cancelled');
    assert.strictEqual(t.session.source(), 'password');
    assert.strictEqual(t.session.user(), fake.OTHER_USER, 'the newer Session is Active');
    assert.strictEqual(t.session.status(), 'authenticated');
    assert.strictEqual(t.h.stores.rutracker_session.session.user, fake.OTHER_USER, 'the store holds the newer Session');
    assert.strictEqual(JSON.stringify(t.h.stores).indexOf(fake.VALID), -1, 'the older Session is in no store');
});

test('a newer Candidate that is rejected still cancels the older one; the Active Session stays as it was before the older one', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    assert.strictEqual(t.session.user(), 'TestUser', 'the Active Session before both');
    const before = JSON.stringify(t.h.stores.rutracker_session.session);
    let inner;
    const ran = duringCheck(t, function () { inner = t.session.submit(candidate({ cookie: 'bb_session=expired' })); });
    const res = t.session.submit(candidate({ cookie: OTHER_CANDIDATE }));
    assert.ok(ran(), 'the older Candidate was checked');
    assert.strictEqual(inner.status, 'rejected', 'the newer Candidate failed its check');
    assert.strictEqual(res.status, 'cancelled', 'the older one is cancelled, not saved');
    assert.strictEqual(t.session.user(), 'TestUser', 'the Active Session is still TestUser');
    assert.strictEqual(t.session.status(), 'authenticated');
    assert.strictEqual(JSON.stringify(t.h.stores.rutracker_session.session), before, 'the store is unchanged');
});

test('a newer recheck() cancels an older one in flight; the newer answer stays', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    const site = t.h.server;
    let first = true;
    let newer;
    t.h.server = function (req) {
        if (first && /viewforum\.php\?f=7$/.test(req.url)) {
            first = false;
            newer = t.session.recheck();
            //  The older check's answer: the fake site's own Cloudflare page, as without a clearance.
            return site(Object.assign({}, req, { cookies: Object.assign({}, req.cookies, { cf_clearance: '' }) }));
        }
        return site(req);
    };
    const res = t.session.recheck();
    assert.strictEqual(newer.status, 'authenticated', 'the newer recheck answered');
    assert.strictEqual(res.status, 'cancelled', 'the older recheck is cancelled');
    assert.strictEqual(t.session.status(), 'authenticated', 'the older challenge does not change the status');
    assert.strictEqual(t.session.user(), 'TestUser');
    assert.ok(t.clearance.active(), 'the older challenge does not drop the Clearance the newer check used');
});

test('a newer submit() cancels an older one in flight; the older challenge does not drop the held Clearance', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    submit(t, candidate());
    const site = t.h.server;
    let first = true;
    let newer;
    t.h.server = function (req) {
        if (first && /viewforum\.php\?f=7$/.test(req.url)) {
            first = false;
            newer = t.session.submit(candidate({ cookie: 'bb_session=' + fake.VALID + '; bb_guid=g3' }));
            return site(Object.assign({}, req, { cookies: Object.assign({}, req.cookies, { cf_clearance: '' }) }));
        }
        return site(req);
    };
    const res = t.session.submit(candidate({ cookie: 'bb_session=' + fake.OTHER_VALID + '; bb_guid=g2' }));
    assert.strictEqual(newer.status, 'authenticated', 'the newer Candidate passed with the held Clearance');
    assert.strictEqual(res.status, 'cancelled', 'the older Candidate is cancelled');
    assert.strictEqual(t.session.user(), 'TestUser', 'the newer Session is Active');
    assert.ok(t.clearance.active(), 'the older challenge does not drop the held Clearance');
});

test('a Candidate rejected at once does not cancel a Candidate still in flight', function () {
    const t = setup({ serverOptions: { cloudflare: true } });
    let inner;
    const ran = duringCheck(t, function () { inner = t.session.submit(candidate({ cookie: 'cf_clearance=' + fake.CLEARANCE })); });
    const res = t.session.submit(candidate());
    assert.ok(ran(), 'the first Candidate was checked');
    assert.strictEqual(inner.status, 'rejected', 'the second has no bb_session: rejected without a check');
    assert.strictEqual(res.status, 'authenticated', 'the first is not cancelled by it');
    assert.strictEqual(t.session.user(), 'TestUser');
});

finish();

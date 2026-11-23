/*
 * Unit tests for the plugin's pure modules (src/api/parser.js, the catalog
 * filters), loaded through the same Movian stand-in as the plugin itself.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadPlugin, takeLeaks } = require('./harness/movian');
const { test, section, finish } = require('./harness/tap');

const ROOT = path.resolve(__dirname, '..');
const rt = loadPlugin({ pluginDir: ROOT, entry: false });
const parser = rt.require('./src/api/parser');

/* Objects made inside the vm context have that context's prototypes. */
function plain(x) {
    return JSON.parse(JSON.stringify(x));
}

function fixture(name) {
    return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

section('api/parser');

test('loginName reads the account from the logged-in view only', function () {
    assert.strictEqual(parser.loginName(fixture('index.html')), 'TestUser');
    assert.strictEqual(parser.loginName(fixture('index-guest.html')), null);
    assert.strictEqual(parser.loginName(fixture('cf-challenge.html')), null);
    assert.strictEqual(parser.loginName(''), null);
});

test('loginName gives the same answer on repeated calls', function () {
    const page = fixture('index.html');
    assert.strictEqual(parser.loginName(page), parser.loginName(page));
});

test('captcha reads the real sign-in form: image, sid, field and the site\'s message', function () {
    assert.deepStrictEqual(plain(parser.captcha(fixture('login-captcha.html'))), {
        image: 'static.rutracker.cc/captcha/abc.jpg', sid: 'SID123', field: 'cap_code_xyz',
        message: 'Вы ввели неверное/неактивное имя пользователя или неверный пароль' });
    assert.strictEqual(parser.captcha(fixture('index-guest.html')), null);
});

test('subforums lists forum links with id and title', function () {
    const list = parser.subforums(fixture('index-guest.html'));
    assert.ok(list.length > 100, list.length);
    assert.ok(list.some(function (f) { return f.id === '7' && f.title === 'Зарубежное кино'; }));
});

test('topicRows parses tracker search rows into clean values', function () {
    const rows = parser.topicRows(fixture('search-matrix.html'), 'tracker');
    assert.strictEqual(rows.length, 8);
    assert.strictEqual(rows[0].topicId, '6306464');
    assert.strictEqual(rows[0].size, '18.45 GB');
    assert.strictEqual(rows[0].seeders, '332');
    assert.strictEqual(rows[0].leechers, '31');
    assert.ok(/^\d{2}-\w+-\d{2}$|\d/.test(rows[0].added), rows[0].added);
    rows.forEach(function (r) { assert.ok(!/[<>]/.test(r.title + r.size), r.title); });
});

test('topicRows parses forum rows', function () {
    const rows = parser.topicRows(fixture('forum-7.html'), 'forum');
    const release = rows.filter(function (r) { return r.topicId === '6924363'; })[0];
    assert.ok(release, 'release row');
    assert.strictEqual(release.size, '2.75 GB');
});

test('topicRows reads the 50 topics of guest forum 511 (#62)', function () {
    const rows = parser.topicRows(fixture('forum-511-guest.html'), 'forum');
    assert.strictEqual(rows.length, 50);
    rows.forEach(function (r) { assert.ok(r.topicId && r.title, JSON.stringify(r)); });
});

test('a topic title decodes numeric entities: &#252; is ü and &#039; is an apostrophe (#2200 audit)', function () {
    /* Live, forum 2200 (guest): "Gr&#252;ner wird&#039;s n" was shown as is. The row is forum 511's real markup with that title. */
    const page = fixture('forum-511-guest.html').replace('>О правилах раздела "Театр"</a>', '>Gr&#252;ner wird&#039;s n</a>');
    assert.ok(page.indexOf('Gr&#252;ner') !== -1, 'the title was replaced');
    const rows = parser.topicRows(page, 'forum');
    assert.strictEqual(rows[0].title, "Grüner wird's n");
});

test('loginPage: the full sign-in form of the real sign-in page, not the quick form of a public page (#61 tail)', function () {
    assert.strictEqual(parser.loginPage(fixture('login-guest.html')), true);
    assert.strictEqual(parser.loginPage(fixture('index-guest.html')), false);
    assert.strictEqual(parser.loginPage(fixture('forum-511-guest.html')), false);
    assert.strictEqual(parser.loginPage(fixture('forum-7.html')), false);
    assert.strictEqual(parser.loginPage(''), false);
});

test('a post decodes its numeric entities once: "&#38;#252;" stays "&#252;" (#61 tail P3)', function () {
    const page = parser.topicPage('<div class="post_body">&#38;#252; &#x26;#x41;</div><!--/post_body-->', false);
    assert.strictEqual(page.comments[0], '&#252; &#x41;');
});

test('numeric entities that are no character stay text: &#0; and a surrogate (#61 tail P3)', function () {
    const rows = parser.topicRows(fixture('forum-511-guest.html').replace('>О правилах раздела "Театр"</a>', '>Ex &#xD800; &#0; t</a>'), 'forum');
    assert.strictEqual(rows[0].title, 'Ex &#xD800; &#0; t');
    const page = parser.topicPage('<div class="post_body">a &#0; b &#xDC00;</div><!--/post_body-->', false);
    assert.strictEqual(page.comments[0], 'a &#0; b &#xDC00;');
});

test('nextPage finds the "След." pager link or reports the last page', function () {
    assert.ok(/^tracker\.php\?search_id=.*start=50$/.test(parser.nextPage(parser.parse(fixture('search-matrix.html')), 'bottom_info')));
    assert.strictEqual(parser.nextPage(parser.parse(fixture('forum-7.html')), 'bottom_info'), null);
    assert.strictEqual(parser.nextPage(parser.parse(''), 'bottom_info'), null);
});

test('searchResults tells a result page from a challenge or nothing', function () {
    assert.strictEqual(parser.searchResults(fixture('search-matrix.html')), true);
    assert.strictEqual(parser.searchResults(fixture('cf-challenge.html')), false);
    assert.strictEqual(parser.searchResults(''), false);
});

test('topicPage returns the release links, counts and comments', function () {
    const t = parser.topicPage(fixture('topic-6924363.html'), true);
    assert.strictEqual(t.post.torrent, 'dl.php?t=6924363');
    assert.ok(/^magnet:\?xt=urn:btih:/.test(t.post.magnet));
    assert.strictEqual(t.dl, 'dl.php?t=6924363');
    assert.ok(/^magnet:\?xt=urn:btih:[^&]+&tr=/.test(t.magnet), 'entities decoded: ' + t.magnet.slice(0, 60));
    assert.ok(Number(t.seeders) >= 0 && String(t.seeders) !== '');
    assert.ok(t.post.text.length > 50);
    const all = parser.topicPage(fixture('topic-6924363.html'), false);
    assert.strictEqual(all.comments.length, t.comments.length + 1, 'skipFirst drops the opening post');
});

test('topicPage of an empty or broken page is empty, not an exception', function () {
    const t = parser.topicPage('', true);
    assert.deepStrictEqual(plain(t.post), { image: '', text: '', torrent: '', magnet: '' });
    assert.deepStrictEqual(plain(t.comments), []);
    assert.strictEqual(t.next, null);
});

test('nextPage gives null on the last page, whose pager ends in a page number', function () {
    /* The real pager of search-matrix.html on its last page: the "След." link
     * of the bottom_info pager is gone and its last link is page 10. The page
     * header has a second pager with the same link, which is left alone. */
    const page = fixture('search-matrix.html');
    const at = page.indexOf('<div class="bottom_info">');
    const last = page.slice(0, at) + page.slice(at).replace(/&nbsp;&nbsp;<a class="pg" href="[^"]*">След\.<\/a>/, '');
    assert.ok(page.slice(at).indexOf('След.') !== -1, 'the fixture has the link');
    assert.strictEqual(last.slice(at).indexOf('След.'), -1, 'the link was removed');
    assert.strictEqual(parser.nextPage(parser.parse(last), 'bottom_info'), null);
});

test('bookmarksPage tells a bookmarks page from a guest page or a challenge', function () {
    assert.strictEqual(parser.bookmarksPage(fixture('bookmarks-empty.html')), true);
    assert.strictEqual(parser.bookmarksPage(fixture('index-guest.html')), false);
    assert.strictEqual(parser.bookmarksPage(fixture('cf-challenge.html')), false);
    assert.strictEqual(parser.bookmarksPage(''), false);
    /* A list with topics has the rows of a forum page, which bookmarks share. */
    assert.strictEqual(parser.bookmarksPage(fixture('forum-7.html')), true);
});

section('experimental clearance helper');

test('only a clearance-only pair for an exact official HTTPS host is retained', function () {
    const helper = rt.require('./src/bridge/clearance').create();
    assert.strictEqual(helper.offer('https://rutracker.org/forum/', 'bb_guid=g1; cf_clearance=synthetic-clearance', 'BrowserUA/1'), true);
    assert.deepStrictEqual(plain(helper.forUrl('https://rutracker.org/forum/login.php')), {
        cookie: 'cf_clearance=synthetic-clearance',
        ua: 'BrowserUA/1'
    });
    assert.strictEqual(helper.forUrl('https://sub.rutracker.org/forum/'), null);
    assert.strictEqual(helper.forUrl('http://rutracker.org/forum/'), null);
});

test('the helper keeps only clearance from a browser jar with a guest session cookie', function () {
    const helper = rt.require('./src/bridge/clearance').create();
    assert.strictEqual(helper.offer('https://rutracker.org/forum/', 'cf_clearance=synthetic-clearance; bb_session=synthetic-session; bb_guid=g1', 'BrowserUA/1'), true);
    assert.deepStrictEqual(plain(helper.forUrl('https://rutracker.org/forum/login.php')), {
        cookie: 'cf_clearance=synthetic-clearance',
        ua: 'BrowserUA/1'
    });
    assert.strictEqual(helper.offer('https://rutracker.org.evil.test/forum/', 'cf_clearance=synthetic-clearance', 'BrowserUA/1'), false);
    assert.strictEqual(helper.offer('https://rutracker.net:8443/forum/', 'cf_clearance=synthetic-clearance', 'BrowserUA/1'), false);
    assert.strictEqual(helper.offer('https://rutracker.org/forum/', 'cf_clearance=synthetic-clearance', ''), false);
});

test('expired restored clearance is rejected and does not replace a live pair', function () {
    const helper = rt.require('./src/bridge/clearance').create();
    assert.strictEqual(helper.offer('https://rutracker.org/forum/', 'cf_clearance=live', 'BrowserUA/1', Math.floor(Date.now() / 1000) + 3600), true);
    assert.strictEqual(helper.restore('https://rutracker.org/forum/', 'expired', 'BrowserUA/2', 1), false);
    assert.deepStrictEqual(plain(helper.forUrl('https://rutracker.org/forum/')), {
        cookie: 'cf_clearance=live',
        ua: 'BrowserUA/1'
    });
});

test('expired clearance is discarded during request lookup and never crosses host boundaries', function () {
    const helper = rt.require('./src/bridge/clearance').create();
    assert.strictEqual(helper.restore('https://rutracker.org/forum/', 'expired', 'BrowserUA/1', 1), false);
    assert.strictEqual(helper.active(), false);
    assert.strictEqual(helper.restore('https://rutracker.org/forum/', 'valid', 'BrowserUA/1', Math.floor(Date.now() / 1000) + 3600), true);
    assert.strictEqual(helper.forUrl('https://rutracker.net/forum/'), null);
    assert.strictEqual(helper.forUrl('http://rutracker.org/forum/'), null);
    assert.strictEqual(helper.forUrl('https://rutracker.org.evil.test/forum/'), null);
});

test('a refusal of a custom mirror drops its record after the switch to another domain (#57 review round 3 P2)', function () {
    /* omp P2 (VM): the mirror is no longer in `hosts`, so its refusal named no host. */
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const coreStore = {
        'cf_clearance@mirror.example': { value: 'mirror-clearance', ua: 'BrowserUA/1', expires: expires, origin: 'https://mirror.example' },
        'cf_clearance@rutracker.net': { value: 'net-clearance', ua: 'BrowserUA/1', expires: expires, origin: 'https://rutracker.net' },
    };
    const vm = loadPlugin({ pluginDir: ROOT, entry: false,
        popup: { web: { result: 'userclose', cookies: {}, ua: 'BrowserUA/1', core: true } }, coreStore: coreStore });
    const clearance = vm.require('./src/bridge/clearance').create('https://mirror.example');
    const carried = clearance.forUrl('https://mirror.example/forum/');
    assert.ok(carried, 'the mirror pair is held');
    clearance.setBaseUrl('https://rutracker.net');
    assert.strictEqual(clearance.forUrl('https://rutracker.net/forum/').cookie, 'cf_clearance=net-clearance');
    const got = clearance.challengedWith('https://mirror.example/forum/', carried);
    assert.ok(got.dropped, 'the refused mirror pair is dropped');
    assert.strictEqual(coreStore['cf_clearance@mirror.example'], undefined, 'the mirror record is deleted');
    assert.strictEqual(clearance.forUrl('https://rutracker.net/forum/').cookie, 'cf_clearance=net-clearance', 'the rutracker.net pair is kept');
});

test('hostOf: the lower-case host of an https URL, none for a port, http or nothing', function () {
    const hostOf = rt.require('./src/api/credentials').hostOf;
    assert.strictEqual(hostOf('https://RuTracker.ORG/forum/viewforum.php?f=7'), 'rutracker.org');
    assert.strictEqual(hostOf('https://rutracker.org?x=1'), 'rutracker.org');
    assert.strictEqual(hostOf('https://rutracker.org#top'), 'rutracker.org');
    assert.strictEqual(hostOf('https://rutracker.org'), 'rutracker.org');
    assert.strictEqual(hostOf('https://rutracker.org:8443/forum/'), '');
    assert.strictEqual(hostOf('http://rutracker.org/forum/'), '');
    assert.strictEqual(hostOf('https://rutracker.org.evil.test/'), 'rutracker.org.evil.test');
    assert.strictEqual(hostOf('https://'), '');
    assert.strictEqual(hostOf(''), '');
    assert.strictEqual(hostOf(undefined), '');
});

section('business/auth');

const LOGIN_FAILED = '<h4 class="warnColor1 tCenter mrg_16">Вы ввели неверное имя или пароль</h4>';

/* The Session Coordinator as auth uses it; the next test keeps it in step
 * with the real one. */
function sessionStub(submitted, check) {
    return {
        ticket: function () { return {}; },
        untrustJar: function () { return 1; },
        submit: function (c) { submitted.push(c); return { status: check }; }
    };
}

test('the session stub names only methods the real Session Coordinator has (#50)', function () {
    /* Retro 2026-11-22: three session API changes in a row broke this file
     * with "session.x is not a function". */
    const clearance = rt.require('./src/bridge/clearance').create('https://rutracker.org');
    const client = rt.require('./src/api/client').create('https://rutracker.org', clearance);
    const real = rt.require('./src/bridge/session').create(client, parser, clearance);
    Object.keys(sessionStub([], 'authenticated')).forEach(function (name) {
        assert.strictEqual(typeof real[name], 'function', 'session.' + name + ' is not in src/bridge/session.js');
    });
});

function loginWith(answer, check) {
    const submitted = [];
    //  client.login answers with the host the form went to.
    const client = { host: 'rutracker.org', defaultUA: 'UA/1', login: function () { return Object.assign({ host: 'rutracker.org' }, answer); } };
    const auth = rt.require('./src/business/auth').create(client, parser, sessionStub(submitted, check));
    return { result: auth.login('user', 'secret', null), submitted: submitted };
}

test('a login answered by a redirect that carries the error marker is failed, not ok', function () {
    const r = loginWith({ status: 302, text: LOGIN_FAILED, challenge: false, cookie: 'bb_session=s' }, 'authenticated');
    assert.strictEqual(r.result.status, 'failed');
    assert.strictEqual(r.submitted.length, 0);
});

test('a login answered by a bare redirect hands its cookies over as a Candidate Session', function () {
    const r = loginWith({ status: 302, text: '', challenge: false, cookie: 'bb_session=s' }, 'authenticated');
    assert.strictEqual(r.result.status, 'ok');
    assert.deepStrictEqual(plain(r.submitted), [{ source: 'password', host: 'rutracker.org', cookie: 'bb_session=s', ua: 'UA/1', jarWrite: 1 }]);
});

test('a login whose Session Check fails is unverified, not ok', function () {
    const r = loginWith({ status: 302, text: '', challenge: false, cookie: 'bb_session=s' }, 'challenge');
    assert.deepStrictEqual(plain(r.result), { status: 'unverified', check: 'challenge' });
});

section('api/credentials');

test('credentialsFor: what each request carries', function () {
    const c = rt.require('./src/api/credentials');
    const D = c.DEFAULT_UA, NONE = { ua: D, cookies: [], blankJar: true, blankClearance: false, persisted: false };
    const ORG = 'https://rutracker.org/forum/index.php', NET = 'https://rutracker.net/forum/index.php';
    const S = { cookie: 'bb_session=s; bb_ssl=1', ua: 'SessionUA' };
    const C = { cookie: 'cf_clearance=c', ua: 'ClearUA' };
    const P = { cookie: 'cf_clearance=p', ua: 'CoreUA', persisted: true };
    function st(o) { return Object.assign({ baseHost: 'rutracker.org', session: null, clearance: null, clearanceHeld: false }, o); }
    function cookies(h) { return h.split('; ').map(function (p) { return { name: p.split('=')[0], value: p.split('=')[1] }; }); }
    [
        ['plain http', 'http://rutracker.org/forum/', st({ session: S }), NONE],
        ['lookalike host', 'https://evilrutracker.org/', st({ session: S }), NONE],
        ['no Session, other official host', NET, st(), NONE],
        ['no Session, chosen host, nothing held: the jar cf_clearance hidden, the rest as it is', ORG, st(), { ua: D, cookies: [], blankJar: false, blankClearance: true, persisted: false }],
        ['clearance in memory', ORG, st({ clearance: C, clearanceHeld: true }), { ua: 'ClearUA', cookies: cookies(C.cookie), blankJar: false, blankClearance: false, persisted: false }],
        ['clearance Core sends itself', ORG, st({ clearance: P, clearanceHeld: true }), { ua: 'CoreUA', cookies: [], blankJar: false, blankClearance: false, persisted: true }],
        ['clearance held for another host', ORG, st({ clearanceHeld: true }), NONE],
        ['Active Session alone', ORG, st({ session: S }), { ua: 'SessionUA', cookies: cookies(S.cookie), blankJar: false, blankClearance: true, persisted: false }],
        //  One copy of cf_clearance: the Clearance travels with the Session, and its UA.
        ['Active Session and a Clearance in memory', ORG, st({ session: S, clearance: C, clearanceHeld: true }), { ua: 'ClearUA', cookies: cookies(S.cookie + '; ' + C.cookie), blankJar: false, blankClearance: false, persisted: false }],
        ['Active Session and a Clearance Core sends', ORG, st({ session: S, clearance: P, clearanceHeld: true }), { ua: 'CoreUA', cookies: cookies(S.cookie), blankJar: false, blankClearance: false, persisted: true }],
        ['Active Session without a UA', ORG, st({ session: { cookie: 'bb_session=s', ua: '' } }), { ua: D, cookies: cookies('bb_session=s'), blankJar: false, blankClearance: true, persisted: false }],
        //  After a Forget (#3) the Core Jar's auth cookies are hidden until a new Session is Active.
        ['forgotten, nothing held: the Core Jar auth cookies hidden', ORG, st({ forgotten: true }), { ua: D, cookies: [], blankJar: true, blankClearance: false, persisted: false }],
        ['forgotten, clearance in memory: only the Clearance goes', ORG, st({ forgotten: true, clearance: C, clearanceHeld: true }), { ua: 'ClearUA', cookies: cookies(C.cookie), blankJar: true, blankClearance: false, persisted: false }],
        ['forgotten, clearance Core sends itself: the jar copy hidden, Core\'s record stays', ORG, st({ forgotten: true, clearance: P, clearanceHeld: true }), { ua: 'CoreUA', cookies: [], blankJar: true, blankClearance: false, persisted: true }],
        ['forgotten, another official host: as before', NET, st({ forgotten: true }), NONE],
    ].forEach(function (row) {
        assert.deepStrictEqual(plain(c.credentialsFor(row[1], row[2])), row[3], row[0]);
    });
});

section('vendor/movian-cookie-bridge (Movian side)');

/* A fresh runtime per test; sessions share it the way plugins share Movian. */
function runtime(opts) {
    return loadPlugin(Object.assign({ pluginDir: ROOT, entry: false }, opts || {}));
}

function session(r, profile, extra) {
    const mod = r.require('./vendor/movian-cookie-bridge/movian-session');
    return mod.create(Object.assign({
        profile: profile, title: profile, icon: '',
        check: function () { return { status: 'authenticated', user: 'u' }; },
        onSession: function () { return true; }
    }, extra || {}));
}

test('without onSession the module refuses to start: it keeps no session of its own', function () {
    const mod = runtime().require('./vendor/movian-cookie-bridge/movian-session');
    assert.throws(function () {
        mod.create({ profile: 'rutracker', title: 'x', icon: '', check: function () {} });
    }, /onSession/);
});

test('HDRezka and RuTracker transfers stay isolated inside one Movian', function () {
    const r = runtime();
    const got = { ru: [], hd: [] };
    session(r, 'rutracker', { onSession: function (c) { got.ru.push(c); return true; } });
    session(r, 'hdrezka', { onSession: function (c) { got.hd.push(c); return true; } });
    r.stppSet('settings.apps.nodes.HDRezka.nodes.browserCookie.value', 'dle_user_id=7; PHPSESSID=hd');
    r.stppSet('settings.apps.nodes.HDRezka.nodes.browserUA.value', 'UA/1');
    r.flush();
    r.stppSet('settings.apps.nodes.rutracker_bridge.nodes.browserCookie.value', 'bb_session=ru');
    r.stppSet('settings.apps.nodes.rutracker_bridge.nodes.browserUA.value', 'UA/1');
    r.flush();
    assert.deepStrictEqual(got, { ru: ['bb_session=ru'], hd: ['dle_user_id=7; PHPSESSID=hd'] });
});

test('an existing settings group can host the bridge items (HDRezka keeps its paths)', function () {
    const r = runtime();
    const settings = r.require('movian/settings');
    const own = new settings.globalSettings('HDRezka', 'HDRezka', '', '');
    own.createBool('someOption', 'x', true, function () {});
    session(r, 'hdrezka', { group: own });
    assert.ok(r.item('HDRezka', 'someOption') && r.item('HDRezka', 'browserCookie'), 'items share the group');
});

/* onSession: the plugin keeps the session; the module only hands over each
 * cookie + User-Agent pair that arrived together. The extension writes the
 * cookie first, then the UA (bridge-core.js stppSetMessages). */
const RU = 'settings.apps.nodes.rutracker_bridge.nodes.';

function handOver(r, extra) {
    const got = [];
    const s = session(r, 'rutracker', Object.assign({
        onSession: function (cookie, ua, stored) { got.push({ cookie: cookie, ua: ua, stored: stored }); return true; }
    }, extra || {}));
    return { s: s, got: got };
}

function send(r, cookie, ua) {
    if (cookie !== undefined) r.stppSet(RU + 'browserCookie.value', cookie);
    if (ua !== undefined) r.stppSet(RU + 'browserUA.value', ua);
    r.flush();
}

test('onSession: a cookie and its UA are handed over once, in either order', function () {
    const r = runtime();
    const b = handOver(r);
    send(r, 'bb_session=a', 'UA/1');
    r.stppSet(RU + 'browserUA.value', 'UA/2');
    r.stppSet(RU + 'browserCookie.value', 'bb_session=b');
    r.flush();
    assert.deepStrictEqual(plain(b.got), [
        { cookie: 'bb_session=a', ua: 'UA/1', stored: false },
        { cookie: 'bb_session=b', ua: 'UA/2', stored: false }
    ]);
});

test('onSession: half a pair is handed over never, and is dropped', function () {
    const r = runtime();
    const b = handOver(r);
    send(r, 'bb_session=a');
    send(r, undefined, 'UA/1');
    assert.deepStrictEqual(plain(b.got), [], 'a cookie and a UA from two transfers are not a pair');
});

test('onSession: a UA that comes a second after its cookie still makes the pair', function () {
    /* Found live on M7: two STPP writes 0.5 s apart were dropped as two
     * halves by a 300 ms window. */
    const r = runtime();
    const b = handOver(r);
    r.stppSet(RU + 'browserCookie.value', 'bb_session=a');
    r.tick(1000);
    r.stppSet(RU + 'browserUA.value', 'UA/1');
    r.tick(0);
    assert.deepStrictEqual(plain(b.got), [{ cookie: 'bb_session=a', ua: 'UA/1', stored: false }]);
});

test('onSession: a half left alone for 3 s is dropped', function () {
    const r = runtime();
    const b = handOver(r);
    r.stppSet(RU + 'browserCookie.value', 'bb_session=a');
    r.tick(3000);
    r.stppSet(RU + 'browserUA.value', 'UA/1');
    r.tick(3000);
    assert.deepStrictEqual(plain(b.got), []);
});

test('onSession: a new cookie is never paired with the UA of an earlier transfer', function () {
    const r = runtime();
    const b = handOver(r);
    send(r, 'bb_session=a', 'UA/1');
    send(r, 'bb_session=b');
    assert.deepStrictEqual(plain(b.got).map(function (x) { return x.cookie; }), ['bb_session=a']);
});

test('onSession: sending the same session again hands it over again', function () {
    const r = runtime();
    const b = handOver(r);
    send(r, 'bb_session=a', 'UA/1');
    send(r, 'bb_session=a', 'UA/1');
    assert.strictEqual(b.got.length, 2);
});

test('onSession: the module keeps no copy of the session', function () {
    const r = runtime();
    const b = handOver(r);
    send(r, 'bb_session=secret-a; bb_guid=g', 'UA/1');
    assert.strictEqual(b.s, undefined, 'no interface to read it back');
    assert.strictEqual(JSON.stringify(r.stores).indexOf('secret-a'), -1, 'store');
    assert.strictEqual(JSON.stringify(r.settingsStore).indexOf('secret-a'), -1, 'settings');
    assert.ok(/cookies: 2/.test(r.item('rutracker_bridge', 'browserCookie').value));
});

test('onSession: the extension "Clear session" hands over an empty pair', function () {
    const r = runtime();
    const b = handOver(r);
    send(r, 'bb_session=a', 'UA/1');
    send(r, '', '');
    assert.deepStrictEqual(plain(b.got[1]), { cookie: '', ua: '', stored: false });
});

test('onSession: the check and clear actions call check() and hand over an empty pair', function () {
    const r = runtime();
    let checks = 0;
    const b = handOver(r, { check: function () { checks++; } });
    r.item('rutracker_bridge', 'bridgeCheck').action();
    r.item('rutracker_bridge', 'bridgeClear').action();
    assert.strictEqual(checks, 1);
    assert.deepStrictEqual(plain(b.got), [{ cookie: '', ua: '', stored: false }]);
});

test('onSession: a session an earlier version stored is handed over once, then dropped', function () {
    [
        { name: 'store', stores: { rutracker_bridge: { cookie: 'bb_session=old' } }, settings: { rutracker_bridge: { browserUA: 'OldUA/1' } } },
        { name: '0.8.0 settings', stores: {}, settings: { rutracker_bridge: { browserCookie: 'bb_session=old', browserUA: 'OldUA/1' } } }
    ].forEach(function (c) {
        const r = runtime({ stores: c.stores, settings: c.settings });
        const b = handOver(r);
        assert.deepStrictEqual(plain(b.got), [{ cookie: 'bb_session=old', ua: 'OldUA/1', stored: true }], c.name);
        assert.strictEqual(JSON.stringify(r.stores).indexOf('bb_session=old'), -1, c.name + ': old store copy dropped');
        assert.strictEqual(JSON.stringify(r.settingsStore).indexOf('bb_session=old'), -1, c.name + ': settings copy dropped');
        const again = runtime({ stores: r.stores, settings: r.settingsStore });
        assert.deepStrictEqual(plain(handOver(again).got), [], c.name + ': handed over once');
    });
});

test('onSession: a stored session the plugin did not accept is kept for the next start', function () {
    const r = runtime({ stores: { rutracker_bridge: { cookie: 'bb_session=old' } }, settings: { rutracker_bridge: { browserUA: 'OldUA/1' } } });
    session(r, 'rutracker', { onSession: function () { return false; } });
    assert.strictEqual(r.stores.rutracker_bridge.cookie, 'bb_session=old');
});

test('classify: logged-in view, challenge, guest page, HTTP error, no response', function () {
    const mod = runtime().require('./vendor/movian-cookie-bridge/movian-session');
    const login = function (t) { const m = /user=(\w+)/.exec(t); return m ? m[1] : null; };
    const res = function (status, body, headers) {
        return { statuscode: status, headers_lc: headers || {}, toString: function () { return body; } };
    };
    assert.deepStrictEqual(plain(mod.classify(res(200, 'x user=bob /cdn-cgi/challenge-platform/'), login)), { status: 'authenticated', user: 'bob' });
    assert.strictEqual(mod.classify(res(403, '<title>Just a moment...</title>', { 'cf-mitigated': 'challenge' }), login).status, 'challenge');
    assert.strictEqual(mod.classify(res(200, 'guest page /cdn-cgi/challenge-platform/'), login).status, 'rejected');
    assert.strictEqual(mod.classify(res(502, 'bad gateway'), login).status, 'network_error');
    assert.strictEqual(mod.classify(null, login).status, 'network_error');
});

section('tests/harness (session cookie invariant)');

test('a session cookie sent off its host or over http is reported', function () {
    const r = loadPlugin({ pluginDir: ROOT, entry: false, server: function () { return { status: 200, body: '' }; } });
    r.require('native/io').httpInspectorCreate('https?://.*', function (ctrl) { ctrl.setCookie('bb_session', 'S1'); });
    const http = r.require('movian/http');
    http.request('https://rutracker.org/forum/index.php');
    http.request('https://rutracker.net/forum/index.php');
    assert.deepStrictEqual(takeLeaks(), []);
    http.request('https://mirror.example/forum/login.php');
    http.request('http://rutracker.org/forum/login.php');
    const leaks = takeLeaks();
    assert.strictEqual(leaks.length, 2);
    assert.ok(/bb_session sent to mirror\.example/.test(leaks[0]), leaks[0]);
    assert.ok(/bb_session over plain http/.test(leaks[1]), leaks[1]);
    assert.ok(leaks.join(' ').indexOf('S1') < 0, 'no cookie value in the report');
});

finish();

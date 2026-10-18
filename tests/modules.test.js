/*
 * Unit tests for the plugin's pure modules (src/api/parser.js, the catalog
 * filters), loaded through the same Movian stand-in as the plugin itself.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadPlugin } = require('./harness/movian');
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

test('captcha extracts image, sid and field name', function () {
    const html = '<div><img src="https://static.t-ru.org/captcha/x.jpg" alt=""></div>\n' +
        '<input type="hidden" name="cap_sid" value="S1">\n<input class="reg-input" type="text" name="cap_code_q">';
    assert.deepStrictEqual(plain(parser.captcha(html)), { image: 'static.t-ru.org/captcha/x.jpg', sid: 'S1', field: 'cap_code_q' });
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

test('nextPage finds the "След." pager link or reports the last page', function () {
    assert.ok(/^tracker\.php\?search_id=.*start=50$/.test(parser.nextPage(parser.parse(fixture('search-matrix.html')), 'bottom_info')));
    assert.strictEqual(parser.nextPage(parser.parse(fixture('forum-7.html')), 'bottom_info'), null);
    assert.strictEqual(parser.nextPage(parser.parse(''), 'bottom_info'), null);
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

section('vendor/movian-cookie-bridge (Movian side)');

/* A fresh runtime per test; sessions share it the way plugins share Movian. */
function runtime(opts) {
    return loadPlugin(Object.assign({ pluginDir: ROOT, entry: false }, opts || {}));
}

function session(r, profile, extra) {
    const mod = r.require('./vendor/movian-cookie-bridge/movian-session');
    return mod.create(Object.assign({
        profile: profile, title: profile, icon: '',
        check: function () { return { status: 'authenticated', user: 'u' }; }
    }, extra || {}));
}

function inspect(s, url) {
    const ctrl = { url: url, cookies: {}, setCookie: function (k, v) { this.cookies[k] = v; } };
    s.applyToRequest(ctrl);
    return ctrl.cookies;
}

test('HDRezka and RuTracker sessions stay isolated inside one Movian', function () {
    const r = runtime();
    const ru = session(r, 'rutracker');
    const hd = session(r, 'hdrezka', { hosts: ['hdrezka.me'] });
    r.stppSet('settings.apps.nodes.HDRezka.nodes.browserCookie.value', 'dle_user_id=7; PHPSESSID=hd');
    assert.strictEqual(ru.active(), false, 'an HDRezka write must not reach RuTracker');
    assert.deepStrictEqual(plain(inspect(hd, 'https://hdrezka.me/')), { dle_user_id: '7', PHPSESSID: 'hd' });
    assert.deepStrictEqual(plain(inspect(hd, 'https://rutracker.org/')), {});
    r.stppSet('settings.apps.nodes.rutracker_bridge.nodes.browserCookie.value', 'bb_session=ru');
    assert.deepStrictEqual(plain(inspect(ru, 'https://rutracker.org/forum/')), { bb_session: 'ru' });
    assert.deepStrictEqual(plain(inspect(ru, 'https://hdrezka.me/')), {});
    assert.deepStrictEqual(plain(inspect(hd, 'https://hdrezka.me/')), { dle_user_id: '7', PHPSESSID: 'hd' });
    assert.ok(r.stores.HDRezka.cookie.indexOf('PHPSESSID') !== -1 && r.stores.rutracker_bridge.cookie === 'bb_session=ru');
});

test('a profile without domains sends nothing unless the plugin names its hosts', function () {
    const r = runtime();
    const hd = session(r, 'hdrezka');
    r.stppSet('settings.apps.nodes.HDRezka.nodes.browserCookie.value', 'PHPSESSID=hd');
    assert.deepStrictEqual(plain(inspect(hd, 'https://hdrezka.me/')), {});
});

test('an existing settings group can host the bridge items (HDRezka keeps its paths)', function () {
    const r = runtime();
    const settings = r.require('movian/settings');
    const own = new settings.globalSettings('HDRezka', 'HDRezka', '', '');
    own.createBool('someOption', 'x', true, function () {});
    session(r, 'hdrezka', { group: own, hosts: ['hdrezka.me'] });
    assert.ok(r.item('HDRezka', 'someOption') && r.item('HDRezka', 'browserCookie'), 'items share the group');
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

finish();

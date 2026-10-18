/*
 * Behaviour tests for the RuTracker.org plugin, run under the Node stand-in
 * for the Movian runtime (tests/harness/movian.js) against sanitized
 * rutracker.org pages (tests/fixtures/). They drive the real entry file the
 * same way M7 does: settings registration, routes, HTTP inspectors.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadPlugin, text } = require('./harness/movian');
const { test, section, finish } = require('./harness/tap');
const fake = require('./fake-rutracker');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = 'settings.apps.nodes.rutracker_bridge.nodes.';

function load(opts) {
    opts = opts || {};
    return loadPlugin({
        pluginDir: ROOT,
        server: opts.server || fake.server(opts.serverOptions),
        settings: opts.settings,
        stores: opts.stores,
        popup: opts.popup
    });
}

function titles(page) {
    return page.items.map(function (i) { return text(i.meta.title); });
}

function urls(page) {
    return page.items.map(function (i) { return i.url; });
}

function pushSession(h, cookie, ua) {
    h.stppSet(BRIDGE + 'browserCookie.value', cookie === undefined ? fake.browserCookie() : cookie);
    h.stppSet(BRIDGE + 'browserUA.value', ua === undefined ? fake.BROWSER_UA : ua);
    h.flush();
}

/* ------------------------------------------------------------------ */
section('plugin: loading and registration');

test('plugin loads and registers its routes, searcher and service', function () {
    const h = load();
    const patterns = h.routes.map(function (r) { return r.pattern; });
    ['start', 'search:([^:]*):(.*)', 'bookmarks', 'forum:(.*):(.*):(.*)', 'topic:(.*):(.*)',
        'torrent:(.*)', 'login:(.*)', 'logout:(.*):(.*):(.*)', 'captchalogin:(.*):(.*):(.*)',
        'captcha:(.*):(.*):(.*)'].forEach(function (p) {
        assert.ok(patterns.indexOf('rutracker:' + p) !== -1, 'missing route ' + p);
    });
    assert.strictEqual(h.searchers.length, 1);
    /* 0.7.x also called service.create('config', true), which registered a
     * second, disabled service titled "config" with the URL "true". */
    assert.deepStrictEqual(h.services.map(function (s) { return s.url; }), ['rutracker:start']);
});

test('plugin id, entry file, icon and version banner are stable', function () {
    const fs = require('fs');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
    assert.strictEqual(manifest.id, 'rutracker', 'the id keys settings, bookmarks and routes');
    assert.strictEqual(manifest.file, 'main.js');
    assert.strictEqual(manifest.icon, 'logo.png');
    assert.ok(fs.existsSync(path.join(ROOT, manifest.icon)), 'icon file shipped');
    const banner = /^\/\/ ver\. (\S+)/m.exec(fs.readFileSync(path.join(ROOT, manifest.file), 'utf8'));
    assert.ok(banner && banner[1] === manifest.version, 'JS banner must match plugin.json version');
});

test('settings groups keep their ids and user-visible items', function () {
    const h = load();
    assert.ok(h.groups.rutracker, 'main group');
    assert.ok(h.groups.rutracker_bridge, 'bridge group');
    ['tosaccepted', 'debug', 'domain0', 'domain', 'list', 'msearch', 'isearch', 'startAuth']
        .forEach(function (id) { assert.ok(h.item('rutracker', id), 'missing setting ' + id); });
    ['browserCookie', 'browserUA', 'bridgeCheck', 'bridgeClear']
        .forEach(function (id) { assert.ok(h.item('rutracker_bridge', id), 'missing bridge setting ' + id); });
});

test('settings left by the old public "rutracker" plugin (same id) still work', function () {
    /* Buksa/movian-rutracker 0.7.5 has the id "rutracker" too, so Movian
     * treats this plugin as its upgrade and hands it the same settings file.
     * That plugin stored the domain as a bare host. */
    const h = load({ settings: { rutracker: { domain: 'rutracker.org', userCookie: 'DONT_TOUCH_THIS', torrentLink: 0 } } });
    h.open('rutracker:start');
    assert.ok(h.requests.length > 0 && h.requests.every(function (r) { return r.url.indexOf('https://rutracker.org/forum/') === 0; }),
        h.requests.map(function (r) { return r.url; }).join(' '));
});

test(':topic always offers the release torrent item; the torrentLink setting is gone', function () {
    /* "Видимость Torrent-ссылок" hid only this item (the direct dl.php link
     * and the magnets stayed), and an old stored value must not hide it. */
    const h = load({ settings: { rutracker: { torrentLink: 0 } } });
    assert.strictEqual(h.item('rutracker', 'torrentLink'), undefined);
    const u = urls(h.open('rutracker:topic:6924363:x'));
    assert.ok(u.indexOf('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363')) !== -1, u.join('\n'));
});

test('a main setting changed at runtime is saved in the main group and survives a restart', function () {
    /* M7's settings.globalSettings() re-targets the module object; with a
     * second group registered the same way, changes to earlier items were
     * written into the newer group's file and lost on restart. */
    const h = load();
    h.item('rutracker', 'list').value = 'directory';
    assert.strictEqual(h.settingsStore.rutracker.list, 'directory');
    assert.strictEqual((h.settingsStore.rutracker_bridge || {}).list, undefined, 'leaked into the bridge group');
    const again = load({ settings: h.settingsStore, stores: h.stores });
    assert.strictEqual(again.item('rutracker', 'list').value, 'directory');
});

/* ------------------------------------------------------------------ */
section('plugin: catalog, search, topic');

test(':start for a guest offers login and the forum list', function () {
    const h = load();
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /Войти на RuTracker\.org/.test(s); }), 'login item');
    assert.ok(t.indexOf('Зарубежное кино') !== -1, 'forum list');
    assert.strictEqual(t.indexOf('Избранное'), -1, 'no bookmarks for guests');
});

test(':start for a logged-in user shows the account, bookmarks and logout', function () {
    const h = load({ server: fake.server(), stores: {} });
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /Пользователь \[ TestUser \]/.test(s); }), t.join('|'));
    assert.ok(t.indexOf('Избранное') !== -1);
    assert.ok(t.some(function (s) { return /Выйти из аккаунта TestUser/.test(s); }));
    assert.ok(urls(page).indexOf('rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино')) !== -1);
});

test(':forum lists subforums and topics', function () {
    const h = load();
    const page = h.open('rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино'));
    const subforums = page.items.filter(function (i) { return /^rutracker:forum:\d+:0:/.test(i.url); });
    const topics = page.items.filter(function (i) { return /^rutracker:topic:\d+:/.test(i.url); });
    assert.ok(subforums.length > 5, 'subforums: ' + subforums.length);
    assert.ok(topics.length > 5, 'topics: ' + topics.length);
    assert.ok(urls(page).indexOf('rutracker:search:7:') !== -1, 'search in forum');
    assert.strictEqual(page.more, false, 'f=7 has a single page');
});

/* forum-7.html with the real result pager of search-matrix.html in its
 * bottom_info: page 1 links on with "След." to viewforum.php?f=7&start=50,
 * and the page at start=50 is the last one (no "След." link). */
function forumPagerServer() {
    const base = fake.server();
    const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'search-matrix.html'), 'utf8');
    const pager = source.slice(source.indexOf('<div class="nav">'), source.indexOf('<div class="spacer_4">'))
        .replace(/tracker\.php\?search_id=[^&"]*&amp;start=/g, 'viewforum.php?f=7&amp;start=');
    const lastPager = pager.replace(/&nbsp;&nbsp;<a class="pg" href="[^"]*">След\.<\/a>/, '');
    return function (req) {
        const res = base(req);
        if (new URL(req.url).pathname !== '/forum/viewforum.php') return res;
        const last = new URL(req.url).searchParams.get('start') === '50';
        res.body = res.body.replace(/<div class="bottom_info pad_2">[\s\S]*?<!--\/bottom_info-->/, function () {
            return '<div class="bottom_info pad_2">' + (last ? lastPager : pager) + '</div><!--/bottom_info-->';
        });
        return res;
    };
}

test('a forum page after the first lists its topics, not the subforums again', function () {
    const h = load({ server: forumPagerServer() });
    const page = h.open('rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино'));
    const subforums = function () {
        return urls(page).filter(function (u) { return /^rutracker:forum:\d+:0:/.test(u); }).length;
    };
    const topics = function () {
        return urls(page).filter(function (u) { return /^rutracker:topic:\d+:/.test(u); }).length;
    };
    const subforumsFirst = subforums();
    const topicsFirst = topics();
    assert.ok(subforumsFirst > 5, 'subforums on page 1: ' + subforumsFirst);
    assert.strictEqual(page.more, true, 'page 1 has a next page');
    h.more(page);
    assert.strictEqual(subforums(), subforumsFirst, 'subforum list appended again');
    assert.ok(topics() > topicsFirst, 'page 2 added its topics');
    assert.strictEqual(page.more, false, 'start=50 is the last page');
});

test(':search parses result rows with size, seeders and leechers', function () {
    const h = load();
    const page = h.open('rutracker:search:0:matrix');
    const topics = page.items.filter(function (i) { return /^rutracker:topic:\d+:/.test(i.url); });
    assert.strictEqual(topics.length, 8);
    const d = text(topics[0].meta.description);
    assert.ok(/Размер: <\/font>.*18\.45/.test(d), d);
    assert.ok(/Сидеры: <\/font>332/.test(d), d);
    assert.ok(/Личеры: <\/font>31/.test(d), d);
    assert.strictEqual(page.more, true, 'next result page available');
});

test('global searcher returns results and a continue item', function () {
    const h = load();
    const page = h.search('matrix');
    assert.strictEqual(page.items.filter(function (i) { return /:topic:/.test(i.url); }).length, 8);
    assert.ok(titles(page).indexOf('Продолжить поиск') !== -1);
});

test('the global searcher says a search failed when the site sent no result page', function () {
    /* Same rule as :search: no topics and no "continue" item, one separator
     * that says the search failed, not that nothing was found. */
    [{ down: true }, { cloudflare: true }].forEach(function (serverOptions) {
        const page = load({ serverOptions: serverOptions }).search('matrix');
        assert.deepStrictEqual(titles(page), ['Поиск не выполнен: сайт не вернул результаты (сеть или проверка Cloudflare)'],
            JSON.stringify(serverOptions));
        assert.deepStrictEqual(urls(page), [''], JSON.stringify(serverOptions));
    });
});

test('the global searcher with zero topics from a good search keeps the continue item only', function () {
    const page = load().search('zzzqqq');
    assert.deepStrictEqual(titles(page), ['Продолжить поиск']);
});

test(':topic offers torrent and magnet items', function () {
    const h = load();
    const page = h.open('rutracker:topic:6924363:' + encodeURIComponent('Знакомьтесь, Джо Блэк'));
    const u = urls(page);
    assert.ok(u.indexOf('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363')) !== -1, u.join('\n'));
    assert.ok(u.some(function (x) { return /^torrent:browse:magnet:\?xt=urn:btih:/.test(x); }), 'magnet');
    assert.ok(u.indexOf('https://rutracker.org/forum/dl.php?t=6924363') !== -1, 'direct dl link');
    assert.ok(titles(page).some(function (s) { return /^Сиды: /.test(s); }), 'seed/leech line');
});

test(':topic shows the release poster; Movian decodes webp itself', function () {
    /* The old "webp" setting (on by default) replaced every poster with the
     * generic icon. M7 detects WEBP by signature (fa_imageloader.c). */
    const h = load();
    const release = h.open('rutracker:topic:6924363:x').items.filter(function (i) { return i.meta.duration === 'T'; })[0];
    assert.strictEqual(release.meta.icon, 'https://i129.fastpic.org/big/2026/1018/7b/a45a55e1de381f723033e431ffcc7d7b.png');
    assert.strictEqual(h.item('rutracker', 'webp'), undefined, 'setting removed');
});

test('the search shortcuts of a topic take their query from the title', function () {
    /* The old greedy /\[(.*)/ cut everything from the first "[": the
     * title "[Матрица] Осознанность (1999) [1080p]" gave an empty query. */
    [
        ['[Матрица] Осознанность (1999) [1080p]', 'Осознанность'],
        ['[VA] Сборник хитов (2020) FLAC', 'Сборник хитов'],
        ['Знакомьтесь, Джо Блэк / Meet Joe Black (1998) [1080p]', 'Знакомьтесь, Джо Блэк'],
    ].forEach(function (c) {
        const h = load();
        const page = h.open('rutracker:topic:6924363:' + encodeURIComponent(c[0]));
        assert.deepStrictEqual(urls(page).filter(function (u) { return /^rutracker:search:0:/.test(u); }),
            ['rutracker:search:0:' + c[1]], c[0]);
    });
});

test('a topic title that the query rule empties gets no search shortcuts', function () {
    const h = load();
    const page = h.open('rutracker:topic:6924363:' + encodeURIComponent('[Live] [2020]'));
    assert.strictEqual(titles(page).indexOf('Поиск:'), -1, titles(page).join('|'));
    assert.deepStrictEqual(urls(page).filter(function (u) { return /search/.test(u); }), []);
});

test(':torrent downloads the file and hands it to the torrent browser', function () {
    const h = load();
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    const page = h.open('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363'));
    assert.strictEqual(page.redirects[0],
        'torrent:browse:data:application/x-bittorrent;base64,' + fake.TORRENT.toString('base64'));
});

test(':start shows the account on every visit, not every other one', function () {
    /* regExps.login is a /g regex; exec() without resetting lastIndex
     * resumed past the previous match and missed the user on the next page. */
    const h = load();
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    [1, 2, 3].forEach(function (n) {
        const t = titles(h.open('rutracker:start'));
        assert.ok(t.some(function (s) { return /Пользователь \[ TestUser \]/.test(s); }), 'visit ' + n);
    });
});

test('a search query with a colon keeps its colon and the forum', function () {
    /* Codex review: the greedy route split "0:Star Trek" / " Discovery". */
    const h = load();
    h.open('rutracker:search:0:Star Trek: Discovery');
    const url = h.requests[h.requests.length - 1].url;
    assert.ok(url.indexOf('nm=' + encodeURIComponent('Star Trek: Discovery') + '&f=-1&') !== -1, url);
});

test('an empty search says so and offers the word-start search', function () {
    /* The site matches whole words: "dis" finds nothing, "dis*" does. */
    const h = load();
    const page = h.open('rutracker:search:0:matr');
    assert.deepStrictEqual(titles(page), ['Ничего не найдено', 'Искать начало слова: matr*']);
    assert.strictEqual(page.items[1].url, 'rutracker:search:-1:matr*');
    assert.strictEqual(page.more, false);
    assert.strictEqual(page.errors.length, 0);
    const retry = h.open(page.items[1].url);
    assert.strictEqual(retry.items.filter(function (i) { return /:topic:/.test(i.url); }).length, 8);
});

test('an empty word-start search offers no further retry', function () {
    const h = load();
    assert.deepStrictEqual(titles(h.open('rutracker:search:0:zzz*')), ['Ничего не найдено']);
});

test('a search the site did not answer is an error, not "nothing found"', function () {
    [{ cloudflare: true }, { down: true }].forEach(function (serverOptions) {
        const page = load({ serverOptions: serverOptions }).open('rutracker:search:0:matrix');
        assert.strictEqual(page.errors.length, 1, JSON.stringify(serverOptions));
        assert.ok(/Поиск не выполнен/.test(page.errors[0]), page.errors[0]);
        assert.strictEqual(page.items.length, 0);
    });
});

test('a later search page the site did not answer is said so, and paging stops', function () {
    ['down', 'challenge'].forEach(function (pagerFailure) {
        const h = load({ serverOptions: { pagerFailure: pagerFailure } });
        const page = h.open('rutracker:search:0:matrix');
        assert.strictEqual(page.more, true, pagerFailure);
        assert.strictEqual(page.items.filter(function (i) { return /:topic:/.test(i.url); }).length, 8, pagerFailure);
        h.more(page);
        assert.strictEqual(titles(page).slice(-1)[0], 'Следующая страница не загружена: сайт не вернул страницу', pagerFailure);
        assert.strictEqual(page.more, false, pagerFailure);
        assert.strictEqual(page.errors.length, 0, pagerFailure);
    });
});

test('search rows show the size as text, not as a download link', function () {
    const h = load();
    const page = h.open('rutracker:search:0:matrix');
    const d = text(page.items.filter(function (i) { return /:topic:/.test(i.url); })[0].meta.description);
    assert.ok(/Размер: <\/font>18\.45 GB<br>/.test(d), d);
});

test('topic pages do not pile up HTTP inspectors', function () {
    /* Each visit registered up to three never-destroyed inspectors whose
     * patterns (unescaped "?") could not even match their URL. */
    const h = load();
    const before = h.inspectors.length;
    h.open('rutracker:topic:6924363:x');
    h.open('rutracker:topic:6924363:x');
    assert.strictEqual(h.inspectors.length, before);
});

test('bookmarks say so when the site sent no bookmarks page', function () {
    [{ down: true }, { cloudflare: true }].forEach(function (serverOptions) {
        const h = load({ serverOptions: serverOptions });
        h.jar['rutracker.org'] = { bb_session: fake.VALID };
        const page = h.open('rutracker:bookmarks');
        assert.strictEqual(page.errors.length, 1, JSON.stringify(serverOptions));
        assert.ok(/Закладки не загружены/.test(page.errors[0]), page.errors[0]);
        assert.strictEqual(page.items.length, 0);
        assert.strictEqual(page.more, false);
    });
});

test('a bookmarks page without topics says that there are none', function () {
    const h = load();
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    const page = h.open('rutracker:bookmarks');
    assert.deepStrictEqual(titles(page), ['Закладок нет']);
    assert.strictEqual(page.errors.length, 0);
    assert.strictEqual(page.more, false);
});

test('a torrent download that returns a web page is an error, not a torrent', function () {
    const h = load();
    const page = h.open('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363'));
    assert.deepStrictEqual(page.redirects, []);
    assert.strictEqual(page.errors.length, 1, 'error shown');
});

test('a torrent download that fails on the network is an error', function () {
    const h = load({ serverOptions: { down: true } });
    const page = h.open('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363'));
    assert.deepStrictEqual(page.redirects, []);
    assert.strictEqual(page.errors.length, 1);
});

/* ------------------------------------------------------------------ */
function bridgeCookiesOnUrl(h, url) {
    h.context.require('movian/http').request(url, { noFail: true });
    return h.requests[h.requests.length - 1].cookies.bb_session === fake.VALID;
}

section('plugin: legacy login');

/* Codex review (public PR): success needs positive evidence. */
test('a login that gets no answer is an error, not a success', function () {
    const h = load({ serverOptions: { down: true }, popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    pushSession(h, 'bb_session=browser; bb_guid=g1');
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.deepStrictEqual(page.redirects, []);
    assert.strictEqual(page.errors.length, 1, 'error shown');
    assert.ok(h.logs.some(function (l) { return /status=/.test(l); }) && h.item('rutracker_bridge', 'browserCookie').value !== '',
        'the bridge session is not cleared');
});

test('a login answered by a Cloudflare challenge is reported as such', function () {
    const h = load({ serverOptions: { cloudflare: true }, popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.deepStrictEqual(page.redirects, []);
    assert.ok(/Cloudflare/.test(page.errors[0] || ''), page.errors.join());
});

test('a login answered by an unrecognised page asks again instead of claiming success', function () {
    const srv = fake.server({ loginPage: 'unrecognized' });
    const h = load({ server: srv, popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.strictEqual(srv.state.logins.length, 1);
    assert.deepStrictEqual(page.redirects, [], 'no redirect to :start after the second prompt is cancelled');
});

test('logout returns to :start when start-up login is off', function () {
    const h = load();
    const page = h.open('rutracker:logout:true:null:null');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
});

test('logout of a bridged account clears the bridge without logging the browser out', function () {
    const h = load();
    pushSession(h);
    h.open('rutracker:logout:true:null:null');
    const post = h.requests.filter(function (r) { return r.postdata && r.postdata.logout; })[0];
    assert.ok(post, 'logout posted');
    assert.notStrictEqual(post.cookies.bb_session, fake.VALID, 'the browser session cookie was not used for logout');
    assert.strictEqual(bridgeCookiesOnUrl(h, 'https://rutracker.org/forum/index.php'), false, 'bridge cleared');
});

test('accepting the terms is remembered across restarts', function () {
    const h = load({ popup: { message: true } });
    h.open('rutracker:start');
    assert.strictEqual(h.settingsStore.rutracker.tosaccepted, true);
    const again = load({ settings: h.settingsStore, stores: h.stores, popup: { message: false } });
    assert.deepStrictEqual(again.open('rutracker:start').errors, [], 'not asked again');
});

test('legacy login posts the credentials and returns to :start', function () {
    const srv = fake.server();
    const h = load({ server: srv, popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(srv.state.logins.length, 1);
    assert.strictEqual(h.jar['rutracker.org'].bb_session, fake.VALID);
});

test('an active bridge session does not get in the way of the legacy login', function () {
    const srv = fake.server();
    const h = load({ server: srv, popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    pushSession(h, 'bb_session=expired-browser-session; bb_guid=g1');
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(srv.state.logins.length, 1, 'form posted');
    /* Inspector cookies beat the core jar for the same name, so a stale
     * bridge session would hide the fresh login. Logging in replaces it. */
    const t = titles(h.open('rutracker:start'));
    assert.ok(t.some(function (x) { return /Пользователь \[ TestUser \]/.test(x); }), t.slice(0, 3).join(' | '));
    assert.strictEqual(h.requests[h.requests.length - 1].cookies.bb_session, fake.VALID);
});

test('without any bridge session the plugin works as before (no extension installed)', function () {
    const h = load();
    h.flush();
    assert.strictEqual(h.requests.length, 0, 'nothing is fetched until a page is opened');
    const t = titles(h.open('rutracker:start'));
    assert.ok(t.some(function (s) { return /Войти на/.test(s); }));
    assert.ok(!t.some(function (s) { return /Cookie Bridge/.test(s); }), 'no bridge status line');
});

test('legacy login does not leak its form headers into later requests', function () {
    /* login/logout used to write Content-Type, Origin and Referer into the
     * shared headers object, so every later GET claimed to be a form post
     * coming from login.php. */
    const h = load({ popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    h.open('rutracker:logout:false:null:null');
    h.open('rutracker:forum:7:0:x');
    const get = h.requests[h.requests.length - 1];
    assert.strictEqual(get.headers['content-type'], undefined);
    assert.strictEqual(get.headers.origin, undefined);
    assert.ok(!/login\.php/.test(get.headers.referer || ''), get.headers.referer);
});

test('legacy login detects the captcha form', function () {
    const h = load({ serverOptions: { captcha: true }, popup: { credentials: [{ username: 'user', password: 'x' }] } });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.ok(/^rutracker:captcha:/.test(page.redirects[0]), page.redirects.join());
    assert.ok(page.redirects[0].indexOf(':SID123:cap_code_xyz') !== -1, page.redirects[0]);
    /* It used to fall through and redirect to :start right after, which
     * replaced the captcha page before the user could see it. */
    assert.strictEqual(page.redirects.length, 1, page.redirects.join(' | '));
});

test('the captcha entry page shows the captcha image and asks for the code', function () {
    const h = load({ popup: { text: [{ input: 'ab12' }] } });
    const page = h.open('rutracker:captchalogin:http://static.t-ru.org/captcha/abc.jpg:SID123:cap_code_xyz');
    assert.strictEqual(page.items[0].meta.icon, 'http://static.t-ru.org/captcha/abc.jpg');
    const next = JSON.parse(decodeURIComponent(page.redirects[0].replace('rutracker:login:', '')));
    assert.deepStrictEqual(next, { showAuth: true, captchaSid: 'SID123', captchaValue: 'ab12', capCodeName: 'cap_code_xyz' });
});

test('the captcha image is fetched over https, the scheme the site uses', function () {
    /* The site's <img src> is https://static.t-ru.org/…; the page gets the
     * part after "//" and must not fall back to plain http. */
    const h = load({ serverOptions: { captcha: true }, popup: { credentials: [{ username: 'user', password: 'x' }] } });
    const login = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    const captcha = h.open(login.redirects[0]);
    assert.strictEqual(captcha.items[0].meta.icon, 'https://static.t-ru.org/captcha/abc.jpg');
});

test('a login answered with the captcha code sends it with the form', function () {
    const srv = fake.server({ captcha: true });
    const h = load({ server: srv, popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    const opts = { showAuth: true, captchaSid: 'SID123', captchaValue: 'ab12', capCodeName: 'cap_code_xyz' };
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify(opts)));
    assert.strictEqual(srv.state.logins[0].cap, 'SID123');
    const post = h.requests.filter(function (r) { return r.method === 'POST'; })[0].postdata;
    assert.strictEqual(post.cap_code_xyz, 'ab12');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
});

/* ------------------------------------------------------------------ */
section('plugin: cookie bridge');

test('an STPP push is applied without restart and verified on the site', function () {
    const h = load({ serverOptions: { cloudflare: true } });
    pushSession(h);
    assert.ok(h.logs.some(function (l) { return /status=authenticated \(TestUser\)/.test(l); }), h.logs.join('\n'));
    const req = h.requests[h.requests.length - 1];
    assert.strictEqual(req.headers['user-agent'], fake.BROWSER_UA);
    assert.strictEqual(req.cookies.cf_clearance, fake.CLEARANCE);
});

test('bridge cookies are not given to hosts outside the allow-list', function () {
    const h = load();
    pushSession(h);
    const http = h.context.require('movian/http');
    http.request('https://rutracker.org.evil.example/forum/index.php', { noFail: true });
    http.request('https://static.example/?ref=rutracker.org', { noFail: true });
    h.requests.slice(-2).forEach(function (r) {
        assert.strictEqual(r.cookies.bb_session, undefined, r.url);
    });
});

test('clear session empties the runtime session and the settings', function () {
    const h = load();
    pushSession(h);
    h.item('rutracker_bridge', 'bridgeClear').action();
    assert.strictEqual(h.item('rutracker_bridge', 'browserCookie').value, '');
    assert.ok(h.logs.some(function (l) { return /status=empty/.test(l); }));
});

/* ------------------------------------------------------------------ */
section('security: bridge cookie scope');

function bridgeCookiesOn(h, url) {
    h.context.require('movian/http').request(url, { noFail: true });
    return h.requests[h.requests.length - 1].cookies.bb_session === fake.VALID;
}

test('bridge cookies go to the official RuTracker hosts over https', function () {
    const h = load();
    pushSession(h);
    ['https://rutracker.org/forum/index.php', 'https://www.rutracker.org/forum/index.php'].forEach(function (u) {
        assert.ok(bridgeCookiesOn(h, u), u);
    });
    const net = load({ settings: { rutracker: { domain: 'https://rutracker.net' } } });
    pushSession(net);
    assert.ok(bridgeCookiesOn(net, 'https://rutracker.net/forum/index.php'), 'rutracker.net as base');
    /* Codex review: both official domains, whatever the base. */
    assert.ok(bridgeCookiesOn(h, 'https://rutracker.net/forum/index.php'), 'rutracker.net with the .org base');
    assert.strictEqual(h.requests[h.requests.length - 1].headers['user-agent'], fake.BROWSER_UA);
    assert.ok(bridgeCookiesOn(net, 'https://rutracker.org/forum/index.php'), 'rutracker.org with the .net base');
});

test('bridge cookies never travel over plain http', function () {
    /* The extension drops the Secure attribute; the plugin must not send a
     * Secure session cookie in clear text just because a mirror is http://. */
    const h = load();
    pushSession(h);
    assert.strictEqual(bridgeCookiesOn(h, 'http://rutracker.org/forum/index.php'), false);
});

test('a custom domain setting cannot widen the bridge allow-list', function () {
    const h = load({ settings: { rutracker: { domain0: 'https://evil.example', domain: 'https://evil.example' } } });
    pushSession(h);
    h.open('rutracker:start');
    const toEvil = h.requests.filter(function (r) { return /evil\.example/.test(r.url); });
    assert.ok(toEvil.length > 0, 'the plugin did talk to the custom domain');
    toEvil.forEach(function (r) { assert.strictEqual(r.cookies.bb_session, undefined, r.url); });
});

test('third-party proxies and unofficial mirrors get no bridge cookies', function () {
    const h = load();
    pushSession(h);
    ['https://rutracker-org.appspot.com/forum/index.php', 'https://rutracker.lib/forum/index.php',
        'https://rutracker.org.evil.example/'].forEach(function (u) {
        assert.strictEqual(bridgeCookiesOn(h, u), false, u);
    });
});

/* ------------------------------------------------------------------ */
section('security: the session stays out of the STPP-readable tree');

test('after an import the cookie is not left in the settings tree or its file', function () {
    /* settings.apps.nodes.* is readable over unauthenticated STPP (LAN, and any
     * web page via ws://127.0.0.1:42000 - stpp.c checks no Origin) and is
     * rendered on the settings page. */
    const h = load();
    pushSession(h);
    const item = h.item('rutracker_bridge', 'browserCookie');
    assert.ok(item.value.indexOf(fake.VALID) === -1, 'cookie still in the prop tree: ' + item.value.length);
    assert.ok(String(h.settingsStore.rutracker_bridge.browserCookie).indexOf(fake.VALID) === -1, 'cookie in settings file');
    assert.ok(/cookies: 4/.test(item.value), 'placeholder tells what was received: ' + item.value);
    assert.ok(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), 'session still applied');
});

test('the session survives a restart without returning to the settings tree', function () {
    const first = load();
    pushSession(first);
    const h = load({ settings: first.settingsStore, stores: first.stores });
    h.flush();
    assert.ok(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), 'session restored');
    assert.ok(h.logs.some(function (l) { return /status=authenticated/.test(l); }), h.logs.join('\n'));
    assert.ok(h.item('rutracker_bridge', 'browserCookie').value.indexOf(fake.VALID) === -1);
});

test('a 0.8.0 session stored in settings is migrated out of the tree', function () {
    const settings = { rutracker_bridge: { browserCookie: fake.browserCookie(), browserUA: fake.BROWSER_UA } };
    const h = load({ settings: settings, stores: {} });
    assert.ok(h.item('rutracker_bridge', 'browserCookie').value.indexOf(fake.VALID) === -1);
    assert.ok(settings.rutracker_bridge.browserCookie.indexOf(fake.VALID) === -1);
    assert.ok(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'));
});

test('clear session wipes runtime, settings and the private store', function () {
    const h = load();
    pushSession(h);
    h.item('rutracker_bridge', 'bridgeClear').action();
    assert.strictEqual(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), false);
    assert.strictEqual(h.item('rutracker_bridge', 'browserCookie').value, '');
    assert.strictEqual(h.item('rutracker_bridge', 'browserUA').value, '');
    Object.keys(h.stores).forEach(function (name) {
        assert.strictEqual(JSON.stringify(h.stores[name]).indexOf(fake.VALID), -1, 'store ' + name);
    });
    const again = load({ settings: h.settingsStore, stores: h.stores });
    assert.strictEqual(bridgeCookiesOn(again, 'https://rutracker.org/forum/index.php'), false, 'gone after restart');
});

test('the extension "Clear session" (empty STPP write) clears too', function () {
    const h = load();
    pushSession(h);
    pushSession(h, '', '');
    assert.strictEqual(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), false);
    assert.ok(/status=empty/.test(h.logs[h.logs.length - 1]) || h.logs.some(function (l) { return /status=empty/.test(l); }));
});

test('sending the same session again is not ignored', function () {
    const h = load();
    pushSession(h);
    const before = h.requests.length;
    pushSession(h);
    assert.ok(h.requests.length > before, 'second send triggered no check');
});

/* ------------------------------------------------------------------ */
section('bridge: transfer is not authentication');

function checkStatus(serverOptions, cookie, ua) {
    const h = load({ serverOptions: serverOptions });
    pushSession(h, cookie, ua);
    const lines = h.logs.filter(function (l) { return /status=/.test(l); });
    return { h: h, last: lines[lines.length - 1] || '' };
}

test('a valid session is reported as authenticated', function () {
    assert.ok(/status=authenticated \(TestUser\)/.test(checkStatus({ cloudflare: true }).last));
});

test('Cloudflare\'s JS-detection script on a normal page is not a challenge', function () {
    /* Found live: every page Movian fetches carries /cdn-cgi/challenge-platform/
     * - the authenticated and the guest view alike. */
    const auth = checkStatus({});
    assert.ok(/status=authenticated/.test(auth.last), auth.last);
    const guest = checkStatus({}, 'bb_session=expired');
    assert.ok(/status=rejected/.test(guest.last), guest.last);
});

test('a Cloudflare challenge is reported as challenge', function () {
    assert.ok(/status=challenge/.test(checkStatus({ cloudflare: true }, undefined, 'OtherUA/1').last));
});

test('an expired session (site shows the guest page) is reported as rejected', function () {
    const r = checkStatus({}, 'bb_session=expired; bb_guid=g1');
    assert.ok(/status=rejected/.test(r.last), r.last);
});

test('a network failure is reported as network_error', function () {
    assert.ok(/status=network_error/.test(checkStatus({ down: true }).last));
});

test('one STPP push (cookie + UA) triggers exactly one check', function () {
    const h = load();
    pushSession(h);
    assert.strictEqual(h.requests.length, 1);
});

test('the check uses a page Cloudflare protects, so a missing cf_clearance shows', function () {
    /* Live: without cf_clearance index.php still answers 200 with the
     * logged-in view while viewforum.php and tracker.php get the 403
     * challenge. Checking index.php reported "authenticated" for a session
     * that could not open a single forum. */
    const r = checkStatus({ cloudflare: true }, 'bb_session=' + fake.VALID + '; bb_guid=g1');
    assert.ok(/status=challenge/.test(r.last), r.last);
    assert.ok(/viewforum\.php/.test(r.h.requests[r.h.requests.length - 1].url));
});

test('before the check runs the status says received, not authenticated', function () {
    const h = load();
    h.stppSet(BRIDGE + 'browserCookie.value', fake.browserCookie());
    h.stppSet(BRIDGE + 'browserUA.value', fake.BROWSER_UA);
    const lines = h.logs.filter(function (l) { return /status=/.test(l); });
    assert.ok(/status=received/.test(lines[lines.length - 1]), lines.join('|'));
});

/* ------------------------------------------------------------------ */
section('security: secrets never reach movian.log');

/* Visits every route once with a bridge session; logout and the legacy
 * login come last because both drop the bridge session. */
function exerciseAll(h) {
    pushSession(h);
    h.open('rutracker:start');
    h.open('rutracker:forum:7:0:x');
    h.open('rutracker:search:0:matrix');
    h.search('matrix');
    h.open('rutracker:bookmarks');
    h.open('rutracker:topic:6924363:x');
    h.open('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363'));
    h.item('rutracker_bridge', 'bridgeCheck').action();
    h.flush();
    h.open('rutracker:logout:false:null:null');
    h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
}

test('no request turns on core HTTP tracing (debug), which logs Cookie and POST data', function () {
    /* FA_DEBUG makes fa_http.c trace every request header ("> Cookie: ...")
     * and hexdump the POST body (login_password) into movian.log. The log is
     * written regardless of -d (trace.c writes every level to log_fd) and is
     * served unauthenticated on :42000/api/logfile (httpcontrol.c). */
    const h = load({ popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    exerciseAll(h);
    assert.ok(h.requests.length > 10, 'requests: ' + h.requests.length);
    h.requests.forEach(function (r) {
        assert.ok(!r.opts.debug, 'debug:true on ' + r.method + ' ' + r.url);
    });
});

test('every RuTracker request carries the bridge User-Agent', function () {
    /* cf_clearance is bound to the UA that earned it. Request-option headers
     * override inspector headers, so a static UA in a headers object would
     * silently defeat the bridge (seen live in 0.8.0 development). */
    const h = load({ popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    exerciseAll(h);
    const whileBridged = h.requests.slice(0, h.requests.findIndex(function (r) { return r.postdata && r.postdata.logout; }));
    assert.ok(whileBridged.length > 8, 'requests made while the bridge was active: ' + whileBridged.length);
    whileBridged.filter(function (r) { return /^https:\/\/rutracker\.org\//.test(r.url); }).forEach(function (r) {
        assert.strictEqual(r.headers['user-agent'], fake.BROWSER_UA, r.method + ' ' + r.url);
    });
});

test('plugin log lines carry neither cookie values nor the password', function () {
    const h = load({ popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    exerciseAll(h);
    const all = h.logs.join('\n');
    [fake.VALID, fake.CLEARANCE, 'secret-password', 'g1'].forEach(function (secret) {
        assert.strictEqual(all.indexOf(secret), -1, 'secret in log: ' + secret);
    });
});

finish();

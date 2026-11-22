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
const { loadPlugin, text, takeLeaks } = require('./harness/movian');
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
        jar: opts.jar,
        popup: opts.popup,
        coreStore: opts.coreStore
    });
}

function titles(page) {
    return page.items.map(function (i) { return text(i.meta.title); });
}

// A short failure message: the first title (the status line on :start) and the count, never the whole list.
function brief(t) {
    return (t[0] || '(no items)').replace(/<[^>]+>/g, '') + ' [' + t.length + ' items]';
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
    ['start', 'search:([^:]*):(.*)', 'bookmarks', 'forum:(.*):(.*):(.*)', 'topic:([^:]*):([^:]*)(?::([0-9]+))?',
        'torrent:(.*)', 'refreshclearance', 'login:(.*)', 'logout', 'captcha:(.*)'].forEach(function (p) {
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

test(':start for a logged-in user shows the account as a label, bookmarks and no logout', function () {
    const h = load({ server: fake.server(), stores: {} });
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /Пользователь \[ TestUser \]/.test(s); }), brief(t));
    assert.ok(t.indexOf('Избранное') !== -1);
    assert.ok(!t.some(function (s) { return /Выйти/.test(s); }), brief(t));
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

test('the global searcher never opens the Cloudflare window', function () {
    /* Movian's global search runs every searcher: a challenge must not put
     * a browser window over the user's search. */
    const h = load({
        serverOptions: { cloudflare: true },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.search('matrix');
    assert.strictEqual(h.webpopups.length, 0);
    assert.deepStrictEqual(titles(page), ['Поиск не выполнен: сайт не вернул результаты (сеть или проверка Cloudflare)']);
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
    assert.strictEqual(u.indexOf('https://rutracker.org/forum/dl.php?t=6924363'), -1, 'no raw dl.php link: Core would open it without the clearance');
    assert.ok(u.filter(function (x) { return x === 'rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363'); }).length >= 2, 'direct link goes through the plugin client');
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
    assert.strictEqual(titles(page).indexOf('Поиск:'), -1, brief(titles(page)));
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

/* #6: a stored Session on :start, checked before the start-up timers ran. */
function storedSession() {
    return { rutracker_session: { session: { source: 'password', host: 'rutracker.org',
        cookie: fake.SESSION + '=' + fake.VALID, ua: fake.BROWSER_UA, user: 'TestUser' } } };
}
function sessionChecks(h) {
    return h.requests.filter(function (r) { return r.url === 'https://rutracker.org/forum/viewforum.php?f=7'; }).length;
}
const PASSWORD_LOGIN = 'rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false }));

test(':start opened before the start-up timers shows the checked Session and sends one Session Check', function () {
    /* Movian Go opened rutracker:start before the deferred check ran: the
     * line said "проверяется..." and the page had no forum list. */
    const h = load({ stores: storedSession() });
    const t = titles(h.open('rutracker:start'));
    assert.ok(t.some(function (s) { return /вход выполнен как TestUser/.test(s); }), brief(t));
    assert.ok(t.indexOf('Зарубежное кино') !== -1, 'forum list');
    assert.strictEqual(sessionChecks(h), 1, 'the inline check');
    h.flush();
    assert.strictEqual(sessionChecks(h), 1, 'the start-up timer does not check again');
});

test(':start with the network down shows a warning, Forget and the sign-in item, and no bookmarks', function () {
    const h = load({ serverOptions: { down: true }, stores: storedSession() });
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /нет связи с RuTracker/.test(s); }), brief(t));
    assert.ok(t.some(function (s) { return /Забыть сессию/.test(s); }), 'Forget');
    assert.ok(urls(page).indexOf(PASSWORD_LOGIN) !== -1, 'sign-in method');
    assert.strictEqual(t.indexOf('Избранное'), -1, 'no bookmarks without a confirmed sign-in');
});

test(':start reopened after the network came back shows the forum list and the checked status', function () {
    let up = false;
    const site = fake.server();
    const h = load({
        server: function (req) { return up ? site(req) : { error: 'Connection refused' }; },
        stores: storedSession()
    });
    const first = titles(h.open('rutracker:start'));
    assert.ok(first.some(function (s) { return /нет связи с RuTracker/.test(s); }), brief(first));
    up = true;
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /вход выполнен как TestUser/.test(s); }), brief(t));
    assert.ok(t.indexOf('Зарубежное кино') !== -1, 'forum list');
    assert.ok(t.indexOf('Избранное') !== -1, 'bookmarks after a confirmed sign-in');
    assert.ok(!t.some(function (s) { return /нет связи с RuTracker/.test(s); }), 'no warning once the network is back');
});

test('a start-up check that got no response is retried by the next :start, which then shows the answer', function () {
    /* Owner's rule (2026-11-21): the start-up check runs once; :start runs it
     * again only after a check that got no response, so the total is two. */
    let up = false;
    const site = fake.server();
    const h = load({
        server: function (req) { return up ? site(req) : { error: 'Connection refused' }; },
        stores: storedSession()
    });
    h.flush();
    assert.strictEqual(sessionChecks(h), 1, 'the start-up check');
    up = true;
    const t = titles(h.open('rutracker:start'));
    assert.strictEqual(sessionChecks(h), 2, 'the retry by :start');
    assert.ok(t.some(function (s) { return /вход выполнен как TestUser/.test(s); }), brief(t));
});

test('a start-up check that was answered is not repeated by :start', function () {
    const h = load({ stores: storedSession() });
    h.flush();
    assert.strictEqual(sessionChecks(h), 1, 'the start-up check');
    const t = titles(h.open('rutracker:start'));
    assert.strictEqual(sessionChecks(h), 1, ':start does not check again');
    assert.ok(t.some(function (s) { return /вход выполнен как TestUser/.test(s); }), brief(t));
});

test(':start warns when the index gets no response, with no Session and only a Clearance or nothing', function () {
    /* The forum list is empty because the request failed, not because the
     * page is empty; the warning must show without any Session Check. */
    const clearanceStore = { rutracker_clearance: { pair: { host: 'rutracker.org', value: fake.CLEARANCE, ua: fake.BROWSER_UA } } };
    [{ stores: {} }, { stores: clearanceStore }].forEach(function (c, i) {
        const h = load({ serverOptions: { down: true }, stores: c.stores });
        const page = h.open('rutracker:start');
        const t = titles(page);
        assert.ok(t.some(function (s) { return /нет связи с RuTracker/.test(s); }), 'case ' + i + ': ' + brief(t));
        assert.ok(urls(page).indexOf(PASSWORD_LOGIN) !== -1, 'case ' + i + ': sign-in item');
        assert.strictEqual(t.indexOf('Избранное'), -1, 'case ' + i + ': no bookmarks');
        if (i === 1) assert.ok(t.some(function (s) { return /Забыть Cloudflare clearance/.test(s); }), 'Forget of the Clearance');
    });
});

test(':start with a checked Session and a failed index shows the warning and no bookmarks', function () {
    /* The Session Check answers (viewforum.php), but the index request gets
     * no response: the warning shows, Forget and the sign-in item stay, and
     * Избранное is not offered over the dead index. */
    const site = fake.server();
    const h = load({
        server: function (req) {
            return new URL(req.url).pathname === '/forum/index.php' ? { error: 'Connection refused' } : site(req);
        },
        stores: storedSession()
    });
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /вход выполнен как TestUser/.test(s); }), brief(t));
    assert.ok(t.some(function (s) { return /нет связи с RuTracker/.test(s); }), 'warning: ' + brief(t));
    assert.ok(t.some(function (s) { return /Забыть сессию/.test(s); }), 'Forget');
    assert.ok(urls(page).indexOf(PASSWORD_LOGIN) !== -1, 'sign-in method');
    assert.strictEqual(t.indexOf('Избранное'), -1, 'no bookmarks over a dead index');
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

const FORUM_URL = 'rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино');
const NETWORK_WARNING = /нет связи с RuTracker/;

test(':forum with no response on the first page says so instead of looking empty', function () {
    const page = load({ serverOptions: { down: true } }).open(FORUM_URL);
    const t = titles(page);
    assert.ok(t.some(function (s) { return NETWORK_WARNING.test(s); }), brief(t));
    assert.strictEqual(urls(page).filter(function (u) { return /:(forum|topic):/.test(u); }).length, 0, 'nothing listed');
    assert.strictEqual(page.more, false, 'no further pages to load');
});

test(':topic with no response on the first page says so, with no empty release or seeders line', function () {
    const page = load({ serverOptions: { down: true } }).open('rutracker:topic:6924363:x');
    const t = titles(page);
    assert.ok(t.some(function (s) { return NETWORK_WARNING.test(s); }), brief(t));
    assert.ok(!t.some(function (s) { return /Торренты:|Сиды:/.test(s); }), brief(t));
});

/* The first request is challenged; the retry after the Clearance Refresh
 * (the second request to path) gets no response. */
function failRetryAfterRefresh(path) {
    const site = fake.server({ cloudflare: true });
    let seen = 0;
    return function (req) {
        if (new URL(req.url).pathname !== path) return site(req);
        seen++;
        return seen === 2 ? { error: 'Connection refused' } : site(req);
    };
}

function refreshedJar() {
    return {
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    };
}

test(':forum a retry after the Clearance Refresh that gets no response shows the warning, not Password Login', function () {
    const opts = refreshedJar();
    opts.server = failRetryAfterRefresh('/forum/viewforum.php');
    const h = load(opts);
    const page = h.open(FORUM_URL);
    assert.strictEqual(h.webpopups.length, 1, 'one CEF window');
    assert.strictEqual(page.redirects.length, 0, 'redirects: ' + page.redirects.length);
    assert.ok(NETWORK_WARNING.test(titles(page).slice(-1)[0]), brief(titles(page)));
    assert.strictEqual(page.more, false);
});

test(':topic a retry after the Clearance Refresh that gets no response shows the warning, not Password Login', function () {
    const opts = refreshedJar();
    opts.server = failRetryAfterRefresh('/forum/viewtopic.php');
    const h = load(opts);
    const page = h.open('rutracker:topic:6924363:x');
    assert.strictEqual(h.webpopups.length, 1, 'one CEF window');
    assert.strictEqual(page.redirects.length, 0, 'redirects: ' + page.redirects.length);
    assert.ok(titles(page).some(function (s) { return NETWORK_WARNING.test(s); }), brief(titles(page)));
    assert.strictEqual(page.more, false);
});

test(':search a retry after the Clearance Refresh that gets no response shows the search error, not Password Login', function () {
    const opts = refreshedJar();
    opts.server = failRetryAfterRefresh('/forum/tracker.php');
    const h = load(opts);
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1, 'one CEF window');
    assert.strictEqual(page.redirects.length, 0, 'redirects: ' + page.redirects.length);
    assert.strictEqual(page.errors.length, 1, brief(titles(page)));
    assert.ok(/Поиск не выполнен/.test(page.errors[0]), page.errors[0]);
});

test(':bookmarks a retry after the Clearance Refresh that gets no response shows the bookmarks error, not Password Login', function () {
    const opts = refreshedJar();
    opts.server = failRetryAfterRefresh('/forum/bookmarks.php');
    const h = load(opts);
    const page = h.open('rutracker:bookmarks');
    assert.strictEqual(h.webpopups.length, 1, 'one CEF window');
    assert.strictEqual(page.redirects.length, 0, 'redirects: ' + page.redirects.length);
    assert.strictEqual(page.errors.length, 1, brief(titles(page)));
    assert.ok(/Закладки не загружены/.test(page.errors[0]), page.errors[0]);
});

test(':forum a later page the site did not answer shows the warning and paging stops', function () {
    const pager = forumPagerServer();
    const h = load({
        server: function (req) {
            return new URL(req.url).searchParams.get('start') === '50' ? { error: 'Connection refused' } : pager(req);
        }
    });
    const page = h.open(FORUM_URL);
    assert.strictEqual(page.more, true, 'page 1 has a next page');
    h.more(page);
    assert.ok(NETWORK_WARNING.test(titles(page).slice(-1)[0]), titles(page).slice(-1)[0]);
    assert.strictEqual(page.more, false, 'paging stops');
    assert.strictEqual(page.errors.length, 0);
});

test(':forum that the site answered with no subforums or topics is an empty forum, with no warning', function () {
    const page = load({ serverOptions: { emptyForum: true } }).open(FORUM_URL);
    const t = titles(page);
    assert.ok(!t.some(function (s) { return NETWORK_WARNING.test(s); }), brief(t));
    assert.strictEqual(page.errors.length, 0);
    assert.strictEqual(urls(page).filter(function (u) { return /:topic:/.test(u); }).length, 0);
    assert.strictEqual(page.more, false, 'the page keeps its bottom_info block but has no pager');
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
test('a Cloudflare challenge on a later tracker page preserves its search cursor', function () {
    const h = load({
        serverOptions: { pagerFailure: 'challenge-once' },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(page.more, true);
    h.more(page);
    const pagerRequests = h.requests.filter(function (r) { return r.url.indexOf('search_id=') !== -1; });
    assert.strictEqual(pagerRequests.length, 2);
    assert.strictEqual(pagerRequests[0].url, pagerRequests[1].url, 'retry retains the server cursor');
    assert.strictEqual(h.webpopups.length, 1);
    assert.strictEqual(titles(page).indexOf('Следующая страница не загружена: сайт не вернул страницу'), -1);
    assert.strictEqual(page.errors.length, 0);
});

test('an authenticated Core Jar refreshes missing clearance in CEF and resumes the search', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const searchUrl = 'https://rutracker.org/forum/tracker.php?nm=matrix&f=-1&o=10';
    const page = h.open('rutracker:search:0:matrix');
    const retried = h.requests.filter(function (r) { return r.url === searchUrl; });
    assert.strictEqual(retried.length, 2, 'the same filtered search is retried once');
    assert.strictEqual(h.webpopups.length, 1, 'CEF challenge opened');
    assert.strictEqual(h.webpopups[0].url, 'https://rutracker.org/forum/login.php');
    assert.strictEqual(h.webpopups[0].options.waitForCookie.name, 'cf_clearance');
    assert.strictEqual(page.items.filter(function (i) { return /:topic:/.test(i.url); }).length, 8, 'original search resumed');
    assert.strictEqual(page.errors.length, 0);
    assert.deepStrictEqual(h.server.state.logins, [], 'no Password Login');
    assert.strictEqual(h.jar['rutracker.org'].bb_session, fake.VALID, 'Core Jar owns authentication');
    assert.ok(!h.stores.rutracker_session || !h.stores.rutracker_session.session, 'bb_session remains outside the plugin session store');
});

test('restores a persisted clearance with its User-Agent after plugin restart', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: {
            result: 'userclose',
            cookies: {},
            ua: '',
            persistedWebCookie: { value: fake.CLEARANCE, ua: fake.BROWSER_UA, expires: Math.floor(Date.now() / 1000) + 3600 }
        } }
    });
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 0, 'restored clearance avoids CEF');
    const request = h.requests.filter(function (r) { return r.url.indexOf('/forum/tracker.php?') !== -1; })[0];
    assert.strictEqual(request.cookies.cf_clearance, fake.CLEARANCE);
    assert.strictEqual(request.headers['user-agent'], fake.BROWSER_UA);
    assert.strictEqual(page.errors.length, 0);
});

test('a persistence failure is visible and does not start Password Login', function () {
    let reads = 0;
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: {
            result: 'userclose',
            cookies: function () { return reads++ ? { cf_clearance: fake.CLEARANCE } : {}; },
            ua: fake.BROWSER_UA,
            persistWebCookie: null
        } }
    });
    const page = h.open('rutracker:refreshclearance');
    assert.strictEqual(h.server.state.logins.length, 0);
    assert.strictEqual(page.errors.length, 1);
    assert.ok(/сохранить Cloudflare clearance/.test(page.errors[0]));
});

test('failed forced persistence refresh preserves the previously restored pair', function () {
    let reads = 0;
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: {
            result: 'userclose',
            cookies: function () { return { cf_clearance: reads++ ? 'new-clearance' : 'old-clearance' }; },
            ua: 'NewBrowserUA/1',
            persistWebCookie: null,
            persistedWebCookie: { value: fake.CLEARANCE, ua: fake.BROWSER_UA, expires: Math.floor(Date.now() / 1000) + 3600 }
        } }
    });
    const refresh = h.open('rutracker:refreshclearance');
    assert.strictEqual(refresh.errors.length, 1);
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(page.errors.length, 0);
    assert.ok(h.requests.some(function (r) {
        return r.cookies.cf_clearance === fake.CLEARANCE && r.headers['user-agent'] === fake.BROWSER_UA;
    }));
});
test('an unsuccessful automatic refresh retries once and does not loop', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: 'stale-clearance' }, ua: fake.BROWSER_UA } }
    });
    h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1);
    assert.strictEqual(h.requests.filter(function (r) {
        return r.url.indexOf('/forum/tracker.php?') !== -1;
    }).length, 2);
});
test('a challenge again after the automatic refresh is reported, not taken for a guest page (#43)', function () {
    /* Codex on the mirror PR: the second challenge has no user and is a
     * response, so a signed-in user was sent to Password Login. */
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: 'stale-clearance' }, ua: fake.BROWSER_UA } }
    });
    const page = h.open(FORUM_URL);
    assert.strictEqual(h.webpopups.length, 1, 'one refresh');
    assert.deepStrictEqual(page.redirects, [], 'no Password Login');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /Cloudflare/.test(s); }), brief(t));
    assert.strictEqual(page.more, false, 'paging stops');
});
test('an expired Core Jar session after clearance resumes the same forum category through Password Login', function () {
    const title = 'Зарубежное кино';
    const route = 'rutracker:forum:7:0:' + encodeURIComponent(title);
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: 'expired-session' } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.open(route);
    assert.strictEqual(h.webpopups.length, 1);
    const options = JSON.parse(decodeURIComponent(page.redirects[0].slice('rutracker:login:'.length)));
    assert.strictEqual(options.resumeUrl, route);
});

test('a challenge page without the cf-mitigated header is a Challenge for pages too', function () {
    /* The Session Check already knew it by its "Just a moment..." title;
     * pages, which decide on a Clearance Refresh, read only the header. */
    const site = fake.server({ cloudflare: true });
    const h = load({
        server: function (req) {
            const res = site(req);
            if (res.headers && res.headers['cf-mitigated']) {
                res.headers = Object.assign({}, res.headers);
                delete res.headers['cf-mitigated'];
            }
            return res;
        },
        stores: { rutracker_session: { session: { source: 'password', host: 'rutracker.org',
            cookie: fake.SESSION + '=' + fake.VALID, ua: fake.BROWSER_UA, user: 'TestUser' } } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    h.flush();
    const page = h.open('rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино'));
    assert.strictEqual(h.webpopups.length, 1, 'a Clearance Refresh');
    assert.ok(page.items.some(function (i) { return /:topic:/.test(i.url); }), 'the forum loaded after it');
});

test('a clearance refresh with an Active Session is used by the retry and the next pages', function () {
    /* Live on Movian Go (CEF and Android): the browser passed the check, but
     * the retry still sent the Active Session's old cf_clearance and every
     * later page opened the window again. */
    const title = 'Зарубежное кино';
    const h = load({
        serverOptions: { cloudflare: true },
        stores: { rutracker_session: { session: { source: 'password', host: 'rutracker.org',
            cookie: fake.SESSION + '=' + fake.VALID + '; cf_clearance=expired-clearance', ua: 'OldBrowserUA/1', user: 'TestUser' } } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    h.flush();  /* the start-up Session Check answers challenge */
    assert.ok(/Cloudflare/.test(titles(h.open('rutracker:start'))[0]));
    const page = h.open('rutracker:forum:7:0:' + encodeURIComponent(title));
    assert.deepStrictEqual(page.redirects, [], 'no Password Login');
    assert.ok(page.items.some(function (i) { return /:topic:/.test(i.url); }), 'the forum loaded');
    h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1, 'one window for both pages');
    const last = h.requests[h.requests.length - 1];
    assert.strictEqual(last.cookies.bb_session, fake.VALID);
    assert.strictEqual(last.cookies.cf_clearance, fake.CLEARANCE);
    h.flush();
    assert.ok(/вход выполнен как/.test(titles(h.open('rutracker:start'))[0]), 'the status is checked again');
});

test('a page that runs while another waits keeps the other page\'s clearance refresh', function () {
    /* Movian runs other pages while a request waits (es_context_suspend in
     * es_io.c). Here the bookmarks page runs while the forum page retries
     * after its refresh; the forum page must still see its own refresh. */
    const title = 'Зарубежное кино';
    const route = 'rutracker:forum:7:0:' + encodeURIComponent(title);
    const site = fake.server({ cloudflare: true });
    let h, interleaved = false;
    h = load({
        server: function (req) {
            if (!interleaved && req.url === 'https://rutracker.org/forum/viewforum.php?f=7' && req.cookies.cf_clearance === fake.CLEARANCE) {
                interleaved = true;
                h.open('rutracker:bookmarks');
            }
            return site(req);
        },
        jar: { 'rutracker.org': { bb_session: 'expired-session' } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.open(route);
    assert.ok(interleaved, 'the bookmarks page ran during the retry');
    const options = JSON.parse(decodeURIComponent(page.redirects[0].slice('rutracker:login:'.length)));
    assert.strictEqual(options.resumeUrl, route);
});

test('an expired Core Jar session after clearance resumes the same topic through Password Login', function () {
    const route = 'rutracker:topic:6924363:' + encodeURIComponent('Знакомьтесь, Джо Блэк');
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: 'expired-session' } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.open(route);
    assert.strictEqual(h.webpopups.length, 1);
    const options = JSON.parse(decodeURIComponent(page.redirects[0].slice('rutracker:login:'.length)));
    assert.strictEqual(options.resumeUrl, route);
});
test('an expired Core Jar session after clearance resumes the bookmarks through Password Login', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: 'expired-session' } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.open('rutracker:bookmarks');
    assert.strictEqual(h.webpopups.length, 1);
    assert.ok(page.redirects.length, 'Password Login, not an error page');
    const options = JSON.parse(decodeURIComponent(page.redirects[0].slice('rutracker:login:'.length)));
    assert.strictEqual(options.resumeUrl, 'rutracker:bookmarks');
});

test('expired authentication on a forum pagination cursor resumes at that cursor', function () {
    const title = 'Зарубежное кино';
    const route = 'rutracker:forum:7:50:' + encodeURIComponent(title);
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: 'expired-session' } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.open(route);
    assert.ok(h.requests.some(function (r) { return r.url === 'https://rutracker.org/forum/viewforum.php?f=7&start=50'; }));
    const options = JSON.parse(decodeURIComponent(page.redirects[0].slice('rutracker:login:'.length)));
    assert.strictEqual(options.resumeUrl, route);
});

test('expired authentication on a topic pagination cursor resumes at that cursor', function () {
    const route = 'rutracker:topic:6924363:' + encodeURIComponent('Знакомьтесь, Джо Блэк') + ':50';
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: 'expired-session' } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.open(route);
    assert.ok(h.requests.some(function (r) { return r.url === 'https://rutracker.org/forum/viewtopic.php?t=6924363&start=50'; }));
    const options = JSON.parse(decodeURIComponent(page.redirects[0].slice('rutracker:login:'.length)));
    assert.strictEqual(options.resumeUrl, route);
});


test('a challenged forum category retries its original category URL after CEF', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const forumUrl = 'https://rutracker.org/forum/viewforum.php?f=7';
    const page = h.open('rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино'));
    assert.strictEqual(h.requests.filter(function (r) { return r.url === forumUrl; }).length, 2);
    assert.ok(page.items.some(function (i) { return /:topic:/.test(i.url); }));
    assert.strictEqual(h.server.state.logins.length, 0);
});

test('closing CEF without clearance stops before retry or Password Login', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        popup: { web: { result: 'userclose', cookies: {}, ua: fake.BROWSER_UA }, credentials: [{ username: 'TestUser', password: 'sanitized-password' }] }
    });
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1);
    assert.strictEqual(h.requests.filter(function (r) { return r.url.indexOf('/forum/tracker.php?') !== -1; }).length, 1);
    assert.strictEqual(page.errors.length, 1);
    assert.strictEqual(h.server.state.logins.length, 0);
});
test('a rejected cached clearance forces a fresh CEF window before retry', function () {
    let reads = 0;
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: {
            result: 'userclose',
            cookies: function () {
                return { cf_clearance: reads++ === 0 ? 'stale-clearance' : fake.CLEARANCE };
            },
            ua: fake.BROWSER_UA
        } }
    });
    pushSession(h, 'cf_clearance=stale-clearance', fake.BROWSER_UA);
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1);
    assert.strictEqual(h.webpopups[0].options.waitForCookie, undefined);
    assert.strictEqual(page.items.filter(function (i) { return /:topic:/.test(i.url); }).length, 8);
});

test('an unsupported CEF challenge leaves a visible Cookie Bridge fallback', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: { result: 'unsupported', cookies: {}, ua: fake.BROWSER_UA } }
    });
    const page = h.open('rutracker:search:0:matrix');
    assert.ok(/Cookie Bridge/.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(h.webpopups.length, 1);
});





test('search rows show the size as text, not as a download link', function () {
    const h = load();
    const page = h.open('rutracker:search:0:matrix');
    const d = text(page.items.filter(function (i) { return /:topic:/.test(i.url); })[0].meta.description);
    assert.ok(/Размер: <\/font>18\.45 GB<br>/.test(d), d);
});

test('the HTTP Inspector sends Active Sessions only to official HTTPS domains', function () {
    const h = load();
    pushSession(h);
    [
        'https://rutracker.org/forum/index.php',
        'https://www.rutracker.org/forum/',
        'https://rutracker.net/forum/dl.php?t=1'
    ].forEach(function (url) {
        assert.strictEqual(bridgeCookiesOnUrl(h, url), true, url);
    });
    [
        'http://rutracker.org/forum/index.php',
        'http://rutracker.net/forum/dl.php?t=1',
        'https://rutracker.org.evil.example/forum/',
        'https://evilrutracker.org/forum/',
        'https://rutracker.organic.example/',
        'https://static.example/?u=https://rutracker.org/'
    ].forEach(function (url) {
        assert.strictEqual(bridgeCookiesOnUrl(h, url), false, url);
    });
});

test('requests to the chosen domain keep its own Referer', function () {
    const h = load();
    h.open('rutracker:forum:7:0:x');
    assert.strictEqual(h.requests[h.requests.length - 1].headers.referer, 'https://rutracker.org/');
    h.context.require('movian/http').request('https://rutracker.net/forum/index.php', { noFail: true });
    assert.strictEqual(h.requests[h.requests.length - 1].headers.referer, 'http://rutracker.net/');
});

test('topic pages do not pile up HTTP inspectors', function () {
    /* Visiting a topic must not register another global HTTP inspector. */
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

section('plugin: Password Login');

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
    const page = h.open('rutracker:logout');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
});

test('"Забыть сессию" of a bridged account keeps the browser logged in', function () {
    const h = load();
    pushSession(h);
    h.open('rutracker:forget');
    assert.ok(!h.requests.some(function (r) { return r.postdata && r.postdata.logout; }), 'no logout posted');
    assert.strictEqual(bridgeCookiesOnUrl(h, 'https://rutracker.org/forum/index.php'), false, 'bridge cleared');
});

test('accepting the terms is remembered across restarts', function () {
    const h = load({ popup: { message: true } });
    h.open('rutracker:start');
    assert.strictEqual(h.settingsStore.rutracker.tosaccepted, true);
    const again = load({ settings: h.settingsStore, stores: h.stores, popup: { message: false } });
    assert.deepStrictEqual(again.open('rutracker:start').errors, [], 'not asked again');
});

test('Password Login posts the credentials and returns to :start', function () {
    const srv = fake.server();
    const h = load({ server: srv, popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(srv.state.logins.length, 1);
    assert.strictEqual(h.jar['rutracker.org'].bb_session, fake.VALID);
});

test('an active bridge session does not get in the way of Password Login', function () {
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

test('Password Login does not leak its form headers into later requests', function () {
    /* login/logout used to write Content-Type, Origin and Referer into the
     * shared headers object, so every later GET claimed to be a form post
     * coming from login.php. */
    const h = load({ popup: { credentials: [{ username: 'user', password: 'secret-password' }] } });
    h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    h.open('rutracker:logout');
    h.open('rutracker:forum:7:0:x');
    const get = h.requests[h.requests.length - 1];
    assert.strictEqual(get.headers['content-type'], undefined);
    assert.strictEqual(get.headers.origin, undefined);
    assert.ok(!/login\.php/.test(get.headers.referer || ''), get.headers.referer);
});

test('Password Login detects the captcha form', function () {
    const h = load({ serverOptions: { captcha: true }, popup: { credentials: [{ username: 'user', password: 'x' }] } });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.ok(/^rutracker:captcha:/.test(page.redirects[0]), page.redirects.join());
    /* It used to fall through and redirect to :start right after, which
     * replaced the captcha page before the user could see it. */
    assert.strictEqual(page.redirects.length, 1, page.redirects.join(' | '));
});

const CAPTCHA_USER = { username: 'user', password: 'wrong' };

function captchaPage(route, serverOptions) {
    serverOptions = serverOptions || {};
    serverOptions.captcha = true;
    const srv = fake.server(serverOptions);
    const h = load({ server: srv, popup: { credentials: [CAPTCHA_USER] } });
    const login = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false, resumeUrl: route || '' })));
    return { h: h, srv: srv, route: login.redirects[0], page: h.open(login.redirects[0]) };
}

test('the Login Captcha form shows the site\'s picture and message, and the user name tried', function () {
    const c = captchaPage();
    assert.strictEqual(c.page.type, 'raw');
    assert.ok(/views\/login-captcha\.view$/.test(c.page.metadata.glwview), c.page.metadata.glwview);
    /* The site's <img src> is https; the page must not fall back to http. */
    assert.strictEqual(c.page.metadata.captchaImage, 'https://static.rutracker.cc/captcha/abc.jpg');
    assert.strictEqual(c.page.metadata.captchaMessage, 'Вы ввели неверное/неактивное имя пользователя или неверный пароль');
    assert.strictEqual(c.page.metadata.username, 'user');
    assert.strictEqual(c.page.metadata.password, '');
    /* The route carries the user name, never the password. */
    assert.ok(decodeURIComponent(c.route).indexOf('"wrong"') === -1, 'password in the route');
});

test('the Login Captcha form signs in with its password and code and returns to the page that asked for it', function () {
    const route = 'rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино');
    const c = captchaPage(route);
    c.page.metadata.password = 'secret-password';
    c.page.metadata.captchaCode = 'ab12';
    c.h.deliver(c.page, 'captchaSubmit');
    const post = loginPost(c.h).postdata;
    assert.strictEqual(post.cap_sid, 'SID123');
    assert.strictEqual(post.cap_code_xyz, 'ab12');
    assert.strictEqual(post.login_username, 'user');
    assert.deepStrictEqual(c.page.redirects, [route]);
});

test('the Login Captcha form sends nothing without a password and a code', function () {
    const c = captchaPage();
    const before = c.h.requests.length;
    c.page.metadata.captchaCode = 'ab12';
    c.h.deliver(c.page, 'captchaSubmit');
    c.page.metadata.captchaCode = '';
    c.page.metadata.password = 'secret-password';
    c.h.deliver(c.page, 'captchaSubmit');
    assert.strictEqual(c.h.requests.length, before);
    assert.deepStrictEqual(c.page.redirects, []);
});

test('a wrong Login Captcha code keeps the form with the site\'s new picture and an empty password', function () {
    /* Live, 2026-11-15 (Movian Go): a wrong code is answered with the
     * captcha form again. */
    const c = captchaPage('', { captchaCode: 'right' });
    c.page.metadata.password = 'secret-password';
    c.page.metadata.captchaCode = 'wrong';
    c.h.deliver(c.page, 'captchaSubmit');
    assert.deepStrictEqual(c.page.redirects, []);
    assert.strictEqual(c.srv.state.logins.length, 2);
    assert.strictEqual(c.page.metadata.captchaImage, 'https://static.rutracker.cc/captcha/abc-1.jpg');
    assert.strictEqual(c.page.metadata.password, '');
    assert.strictEqual(c.page.metadata.captchaCode, '');
    c.page.metadata.password = 'secret-password';
    c.page.metadata.captchaCode = 'right';
    c.h.deliver(c.page, 'captchaSubmit');
    const post = loginPost(c.h).postdata;
    assert.strictEqual(post.cap_sid, 'SID123-1');
    assert.strictEqual(post.cap_code_xyz1, 'right');
    assert.deepStrictEqual(c.page.redirects, ['rutracker:start']);
});

test('the Login Captcha form keeps no password once it has sent it', function () {
    /* An error page replaces the form but keeps its metadata, which the
     * navigator tree exposes; only a new captcha used to clear it. */
    const options = {};
    const c = captchaPage('', options);
    c.page.metadata.password = 'secret-password';
    c.page.metadata.captchaCode = 'ab12';
    options.down = true;
    c.h.deliver(c.page, 'captchaSubmit');
    assert.strictEqual(c.page.errors.length, 1);
    assert.strictEqual(c.page.metadata.password, '');
});

test('cancelling the Login Captcha goes back to the sign-in form', function () {
    const c = captchaPage('rutracker:bookmarks');
    c.h.deliver(c.page, 'captchaCancel');
    const next = JSON.parse(decodeURIComponent(c.page.redirects[0].slice('rutracker:login:'.length)));
    assert.deepStrictEqual(next, { showAuth: true, resumeUrl: 'rutracker:bookmarks' });
});

test('every action the Login Captcha view delivers reaches its route', function () {
    /* Its "submit" and "cancel" arrived as Movian's own "Submit" and "Cancel"
     * (Movian Go, 2026-11-15), so the page never heard them. */
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'login-captcha.view'), 'utf8');
    const names = [];
    view.replace(/deliverEvent\(\$self\.eventSink, "([^"]+)"\)/g, function (m, n) { if (names.indexOf(n) < 0) names.push(n); });
    assert.ok(names.length >= 2, names.join());
    names.forEach(function (name) {
        const c = captchaPage();
        c.page.metadata.password = 'secret-password';
        c.page.metadata.captchaCode = 'ab12';
        c.h.deliver(c.page, name);
        assert.ok(c.page.redirects.length, name + ' was not heard');
    });
});

/* ------------------------------------------------------------------ */
section('plugin: Password Login Session, with and without clearance');

const LOGIN = 'rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false }));
const USER = { username: 'user', password: 'secret-password' };

function loginPost(h) {
    return h.requests.filter(function (r) { return r.postdata && r.postdata.login_username; }).pop();
}

test('the login form goes out with an empty Cookie header and no Active Session', function () {
    const h = load({ popup: { credentials: [USER] } });
    pushSession(h, fake.browserCookie().replace(/; cf_clearance=.*$/, ''));
    h.jar['rutracker.org'] = { bb_session: 'stale-jar-session', bb_t: 't' };
    h.open(LOGIN);
    const post = loginPost(h);
    assert.deepStrictEqual(post.cookies, {}, 'neither the bridge nor the jar cookies');
    assert.strictEqual(post.inspector, null);
    assert.ok(post.opts.noAuth && post.opts.noFollow && post.opts.verifySSL, JSON.stringify(post.opts));
    assert.notStrictEqual(post.headers['user-agent'], fake.BROWSER_UA, 'not the bridge UA either');
});

test('a login becomes the Active Session only after its own Session Check', function () {
    const h = load({ popup: { credentials: [USER] } });
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    const check = h.requests[h.requests.length - 1];
    assert.ok(/viewforum\.php\?f=7$/.test(check.url), check.url);
    assert.deepStrictEqual(check.cookies, { bb_session: fake.VALID }, 'checked with the cookies of the login answer only');
    const t = titles(h.open('rutracker:start'));
    assert.ok(t.some(function (s) { return /Сессия \(вход по паролю\): вход выполнен как TestUser/.test(s); }), t.slice(0, 3).join(' | '));
});

test('every Set-Cookie of the login answer is kept, not only the last one', function () {
    const srv = fake.server({ loginCookies: ['bb_session=' + fake.VALID + '; path=/forum/', 'bb_guid=g9; path=/', 'bb_ssl=1; path=/'] });
    const h = load({ server: srv, popup: { credentials: [USER] } });
    h.open(LOGIN);
    const check = h.requests[h.requests.length - 1];
    assert.ok(/viewforum/.test(check.url) && check.opts.noAuth, check.url);
    assert.deepStrictEqual(check.cookies, { bb_session: fake.VALID, bb_guid: 'g9', bb_ssl: '1' });
});

test('a login whose Session Check failed does not reach later pages through the Core Jar (#42)', function () {
    /* Codex on the mirror PR: the POST put bb_session in the Core Jar, the
     * check answered 503, and :start then ran signed in as that login. */
    const site = fake.server();
    const h = load({
        server: function (req) {
            if (req.opts && req.opts.noAuth && /viewforum/.test(req.url)) return { status: 503, headers: {}, body: '' };
            return site(req);
        },
        popup: { credentials: [USER] }
    });
    const page = h.open(LOGIN);
    assert.ok(/не подтвержд/.test(page.errors[0] || ''), page.errors.join());
    const t = titles(h.open('rutracker:start'));
    assert.ok(!t.some(function (s) { return /TestUser/.test(s); }), brief(t));
    assert.ok(!h.requests[h.requests.length - 1].cookies.bb_session, 'the jar login is not sent');
});

test('a login answer without bb_session is not committed and is reported', function () {
    const h = load({ server: fake.server({ loginCookies: ['bb_guid=g9; path=/'] }), popup: { credentials: [USER] } });
    pushSession(h);
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, []);
    assert.ok(/не подтвержд/.test(page.errors[0] || ''), page.errors.join());
    assert.ok(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), 'the bridge session stays active');
});

test('a login that Cloudflare stops at the forum keeps the previous session and says why', function () {
    const stores = { rutracker_session: { session: {
        source: 'bridge',
        host: 'rutracker.org',
        cookie: 'bb_session=' + fake.VALID,
        ua: fake.BROWSER_UA,
        user: 'TestUser'
    } } };
    const h = load({ serverOptions: { cloudflare: 'pages' }, stores: stores, popup: { credentials: [USER] } });
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, []);
    assert.ok(/Cloudflare/.test(page.errors[0] || ''), page.errors.join());
    assert.ok(/bb_session=/.test(h.stores.rutracker_session.session.cookie), 'the previous Active Session stays stored');
});

test('Password Login needs an https domain', function () {
    const h = load({ settings: { rutracker: { domain: 'http://rutracker.org' } }, popup: { credentials: [USER] } });
    const page = h.open(LOGIN);
    assert.ok(/https/.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(loginPost(h), undefined, 'the password did not go out over http');
});

test('a clearance-backed Password Login becomes the Active Session; the Clearance travels with it', function () {
    const srv = fake.server({
        cloudflare: 'pages',
        loginCookies: ['bb_session=' + fake.VALID + '; path=/forum/', 'bb_guid=g9; path=/', 'bb_ssl=1; path=/']
    });
    const h = load({ server: srv, popup: { credentials: [USER] } });
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);

    const post = loginPost(h);
    assert.deepStrictEqual(Object.keys(post.cookies), ['cf_clearance']);
    assert.strictEqual(post.headers['user-agent'], fake.BROWSER_UA);
    const check = h.requests[h.requests.length - 1];
    assert.ok(/viewforum\.php\?f=7$/.test(check.url) && check.opts.noAuth, 'an isolated Session Check: ' + check.url);
    assert.deepStrictEqual(check.cookies, { bb_session: fake.VALID, bb_guid: 'g9', bb_ssl: '1', cf_clearance: fake.CLEARANCE });
    assert.strictEqual(check.headers['user-agent'], fake.BROWSER_UA);
    const stored = h.stores.rutracker_session.session;
    assert.strictEqual(stored.source, 'password');
    assert.strictEqual(stored.ua, fake.BROWSER_UA);
    assert.ok(/bb_session=/.test(stored.cookie) && !/cf_clearance=/.test(stored.cookie), 'one copy of cf_clearance, not in the Session');
    assert.strictEqual(h.stores.rutracker_clearance.pair.value, fake.CLEARANCE, 'the Clearance keeps it');
    const t = titles(h.open('rutracker:start'));
    assert.ok(t.some(function (s) { return /Сессия \(вход по паролю\): вход выполнен как TestUser/.test(s); }), t.slice(0, 3).join(' | '));

    const emitted = JSON.stringify([h.logs, h.notifications, h.settingsStore]);
    assert.strictEqual(emitted.indexOf(fake.CLEARANCE), -1, 'clearance was not logged');
    assert.strictEqual(emitted.indexOf(USER.password), -1, 'password was not persisted or logged');

    //  A restart needs no new clearance: the Clearance keeps it.
    const restarted = load({ server: srv, stores: h.stores });
    restarted.flush();
    const afterRestart = restarted.context.require('movian/http').request('https://rutracker.org/forum/tracker.php?nm=matrix', { noFail: true });
    assert.strictEqual(afterRestart.statuscode, 200);
    const sent = restarted.requests[restarted.requests.length - 1];
    assert.strictEqual(sent.cookies.bb_session, fake.VALID);
    assert.strictEqual(sent.cookies.cf_clearance, fake.CLEARANCE);
    assert.strictEqual(sent.headers['user-agent'], fake.BROWSER_UA);

    const before = restarted.requests.length;
    const logout = restarted.open('rutracker:logout');
    assert.deepStrictEqual(logout.redirects, ['rutracker:start']);
    assert.ok(!restarted.requests.slice(before).some(function (r) { return r.postdata && 'logout' in r.postdata; }), 'no logout posted');
});

test('Password Login accepts clearance transfers both with and without bb_guid', function () {
    [
        {name: 'clearance only', cookie: 'cf_clearance=' + fake.CLEARANCE},
        {name: 'clearance plus bb_guid', cookie: 'bb_guid=g1; cf_clearance=' + fake.CLEARANCE}
    ].forEach(function (transfer) {
        const h = load({
            serverOptions: { cloudflare: 'pages' },
            popup: { credentials: [USER] }
        });
        pushSession(h, transfer.cookie, fake.BROWSER_UA);

        const page = h.open(LOGIN);
        assert.deepStrictEqual(page.redirects, ['rutracker:start'], transfer.name);
        const post = loginPost(h);
        assert.deepStrictEqual(post.cookies, { cf_clearance: fake.CLEARANCE }, transfer.name + ': only clearance reaches Password POST');
        assert.strictEqual(post.headers['user-agent'], fake.BROWSER_UA, transfer.name);
        const stored = h.stores.rutracker_session.session;
        assert.strictEqual(stored.source, 'password', transfer.name);
        assert.deepStrictEqual(stored.cookie.split('; ').map(function (c) { return c.split('=')[0]; }), ['bb_session'], transfer.name + ': the login answer only');
        assert.strictEqual(h.stores.rutracker_clearance.pair.value, fake.CLEARANCE, transfer.name + ': the Clearance stays the Clearance\'s');
    });
});

test('clearance User-Agent mismatch keeps Password Login behind Cloudflare', function () {
    const h = load({ serverOptions: { cloudflare: 'pages' }, popup: { credentials: [USER] } });
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, 'DifferentUA/1');
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, []);
    assert.ok(/Cloudflare/.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(loginPost(h).headers['user-agent'], 'DifferentUA/1');
});

test('clearance login does not trust a stale jar session without new bb_session', function () {
    const srv = fake.server({ cloudflare: 'pages', loginCookies: [] });
    const h = load({ server: srv, popup: { credentials: [USER] } });
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, []);
    assert.ok(/не подтвержд/.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(h.requests.some(function (r) { return /viewforum\.php\?f=7$/.test(r.url); }), false, 'a stale jar session was not used as proof');
});

test('invalid credentials with clearance do not pass the protected-page checks', function () {
    const h = load({ serverOptions: { cloudflare: 'pages' }, popup: { credentials: [{ username: 'wrong', password: 'wrong' }] } });
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    h.open(LOGIN);
    assert.strictEqual(h.requests.some(function (r) { return /viewforum\.php\?f=7$/.test(r.url); }), false);
    assert.strictEqual(h.jar['rutracker.org'], undefined);
});

test('clearance login replaces an Active Session only after its Session Check passes', function () {
    const h = load({ serverOptions: { cloudflare: 'pages' }, popup: { credentials: [USER] } });
    pushSession(h);
    h.jar['rutracker.org'] = { bb_session: 'stale-core-jar-session', bb_t: 'stale-token' };
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    const post = loginPost(h);
    assert.deepStrictEqual(Object.keys(post.cookies), ['cf_clearance'], 'old Active Session and Core Jar bb_* were excluded');
    assert.strictEqual(post.headers['user-agent'], fake.BROWSER_UA);
    const checks = h.requests.filter(function (r) {
        return /viewforum\.php\?f=7$/.test(r.url) && r.opts.noFollow;
    });
    assert.ok(checks.length && checks.every(function (r) { return r.opts.noAuth; }), 'an isolated check that follows no redirect');
    assert.strictEqual(h.stores.rutracker_session.session.source, 'password', 'the login replaced the bridge Session');
    const request = h.context.require('movian/http').request('https://rutracker.org/forum/dl.php?t=6924363', { noFail: true });
    assert.strictEqual(request.statuscode, 200, 'a direct Movian HTTP request reaches dl.php');
    const torrent = h.requests[h.requests.length - 1];
    assert.strictEqual(torrent.cookies.cf_clearance, fake.CLEARANCE);
    assert.strictEqual(torrent.cookies.bb_session, fake.VALID);
    assert.strictEqual(torrent.headers['user-agent'], fake.BROWSER_UA);
});

test('failed clearance login preserves Active Session but may change shared Core Jar', function () {
    const srv = fake.server({
        cloudflare: 'pages',
        loginCookies: ['bb_session=synthetic-invalid; path=/forum/', 'bb_guid=changed; path=/']
    });
    const h = load({ server: srv, popup: { credentials: [USER] } });
    pushSession(h);
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, []);
    assert.ok(/не подтвержд/.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(h.stores.rutracker_session.session.source, 'bridge');
    assert.ok(/bb_session=/.test(h.stores.rutracker_session.session.cookie), 'the previous Active Session remains stored');
    assert.notStrictEqual(h.jar['rutracker.org'].bb_session, fake.VALID, 'the login response did alter Movian\'s shared Core Jar');

    const request = h.context.require('movian/http').request('https://rutracker.org/forum/tracker.php?nm=matrix', { noFail: true });
    assert.strictEqual(request.statuscode, 200, 'normal traffic still uses the preserved Active Session');
    assert.strictEqual(h.requests[h.requests.length - 1].cookies.bb_session, fake.VALID);
    assert.strictEqual(h.requests[h.requests.length - 1].headers['user-agent'], fake.BROWSER_UA);
});

test('Forget drops the Session and clearance, and hides the login cookies Movian\'s jar keeps', function () {
    const h = load({ serverOptions: { cloudflare: 'pages' }, popup: { credentials: [USER] } });
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    h.open(LOGIN);
    const start = h.open('rutracker:start');
    assert.ok(urls(start).indexOf('rutracker:forget') !== -1, 'Forget is available');
    assert.strictEqual(h.jar['rutracker.org'].bb_session, fake.VALID, 'the jar holds the login (Password Login)');
    const page = h.open('rutracker:forget');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);

    const response = h.context.require('movian/http').request('https://rutracker.org/forum/viewforum.php?f=7', { noFail: true });
    const request = h.requests[h.requests.length - 1];
    assert.strictEqual(response.statuscode, 403, 'without in-memory clearance the protected page is challenged');
    //  setCookie(name, '') hides the jar's copy: it reads as blank.
    assert.strictEqual(request.cookies.cf_clearance, '', 'Forget removed the helper cookie');
    assert.ok(!request.cookies.bb_session, 'the Core Jar\'s bb_session is hidden after a Forget (#3)');
    assert.notStrictEqual(request.headers['user-agent'], fake.BROWSER_UA, 'the matching User-Agent was forgotten too');
});

test('clearance and Core Jar cookies stay off HTTP, third-party, and lookalike hosts', function () {
    const h = load({ serverOptions: { cloudflare: 'pages' }, popup: { credentials: [USER] } });
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    h.open(LOGIN);
    h.jar['evilrutracker.org'] = Object.assign({}, h.jar['rutracker.org']);
    h.jar['rutracker.org.evil.example'] = Object.assign({}, h.jar['rutracker.org']);
    const http = h.context.require('movian/http');
    [
        'http://rutracker.org/forum/viewforum.php?f=7',
        'https://evilrutracker.org/forum/viewforum.php?f=7',
        'https://rutracker.org.evil.example/forum/viewforum.php?f=7',
        'https://static.example/?ref=rutracker.org'
    ].forEach(function (url) {
        http.request(url, { noFail: true });
        const request = h.requests[h.requests.length - 1];
        assert.strictEqual(request.cookies.bb_session || '', '', url);
        assert.strictEqual(request.cookies.cf_clearance || '', '', url);
        assert.strictEqual(request.cookies.bb_guid || '', '', url);
        assert.strictEqual(request.cookies.bb_ssl || '', '', url);
        assert.notStrictEqual(request.headers['user-agent'], fake.BROWSER_UA, url);
    });
});

test('a page that runs during the clearance-backed login check keeps the Active Session', function () {
    /* Movian runs other pages while a request waits; the Session Check of
     * one login must not change what another page's request carries. */
    const site = fake.server({ cloudflare: 'pages', loginCookies: [fake.SESSION + '=jar-session; path=/forum/'] });
    let h, other = null;
    h = load({
        server: function (req) {
            if (!other && /viewforum\.php\?f=7$/.test(req.url) && req.cookies.bb_session === 'jar-session') {
                h.context.require('movian/http').request('https://rutracker.org/forum/bookmarks.php', { noFail: true });
                other = h.requests[h.requests.length - 1];
            }
            return site(req);
        },
        popup: { credentials: [USER] }
    });
    pushSession(h);
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    h.open(LOGIN);
    assert.ok(other, 'the other page ran during the Session Check');
    assert.strictEqual(other.cookies.bb_session, fake.VALID, 'the previous Active Session, not the Candidate');
});

test('a clearance-backed login rejects a non-redirect answer', function () {
    const h = load({
        serverOptions: { cloudflare: 'pages', loginPage: 'unrecognized' },
        popup: { credentials: [USER] }
    });
    pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, []);
    assert.strictEqual(h.requests.some(function (r) { return /viewforum\.php\?f=7$/.test(r.url); }), false);
});

/* ------------------------------------------------------------------ */
section('plugin: Movian Go browser window (Clearance only)');

/* What webcookies('https://rutracker.org/forum/') returns once Movian Go
 * hands over partitioned cookies (Buksa/movian-go#10); `/forum/` path
 * matching includes the cookies set on `/`. */
function browserJar(extra) {
    return Object.assign({ bb_guid: 'g1', bb_session: fake.VALID, bb_ssl: '1', cf_clearance: fake.CLEARANCE }, extra || {});
}

function mgo(web, opts) {
    opts = opts || {};
    var popupOptions = Object.assign({
        web: Object.assign({ result: 'userclose', cookies: browserJar(), ua: fake.BROWSER_UA, supportsBrowserLogin: true }, web)
    }, opts.popup || {});
    return load(Object.assign({ serverOptions: { cloudflare: true } }, opts, { popup: popupOptions }));
}

section('plugin: Clearance-Only Login UX');
test('an expired Core Jar session after clearance acquisition enters Password Login with the original search to resume', function () {
    const h = mgo(undefined, {
        jar: { 'rutracker.org': { bb_session: 'expired-session' } },
        popup: { credentials: [USER] }
    });
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1, 'clearance is obtained before login');
    assert.ok(/^rutracker:login:/.test(page.redirects[0] || ''), page.redirects.join());
    const loginUrl = page.redirects[0];
    const options = JSON.parse(decodeURIComponent(loginUrl.slice('rutracker:login:'.length)));
    assert.strictEqual(options.resumeUrl, 'rutracker:search:0:matrix');
    const login = h.open(loginUrl);
    assert.deepStrictEqual(login.redirects, ['rutracker:search:0:matrix']);
});


test('Password Login waits for cf_clearance, then uses only that cookie and its CEF User-Agent', function () {
    const srv = fake.server({
        cloudflare: 'pages',
        loginCookies: ['bb_session=' + fake.VALID + '; path=/forum/', 'bb_guid=g9; path=/']
    });
    const h = mgo({ result: 'cookie', cookies: browserJar(), ua: fake.BROWSER_UA }, {
        server: srv,
        popup: { credentials: [USER] }
    });
    const loginItems = urls(h.open('rutracker:start')).filter(function (url) {
        return url.indexOf('rutracker:login:') === 0;
    });
    assert.strictEqual(loginItems.length, 1);
    const page = h.open(loginItems[0]);
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(h.webpopups.length, 1);
    assert.strictEqual(h.webpopups[0].url, 'https://rutracker.org/forum/login.php');
    assert.strictEqual(h.webpopups[0].trap, '');
    assert.strictEqual(h.webpopups[0].options.waitForCookie.url, 'https://rutracker.org/forum/');
    assert.strictEqual(h.webpopups[0].options.waitForCookie.name, 'cf_clearance');
    const post = loginPost(h);
    assert.deepStrictEqual(post.cookies, {cf_clearance: fake.CLEARANCE});
    assert.strictEqual(post.headers['user-agent'], fake.BROWSER_UA);
    assert.strictEqual(h.jar['rutracker.org'].bb_session, fake.VALID);
});

test('closing the clearance popup without cf_clearance does not open Password Login', function () {
    const h = mgo({ result: 'userclose', cookies: {} }, { popup: { credentials: [USER] } });
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, []);
    assert.ok(/закрыл|закры|Cloudflare/.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(loginPost(h), undefined);
    assert.strictEqual(h.webpopups.length, 1);
});

test('a cookie completion without a readable clearance never opens Password Login', function () {
    const h = mgo({ result: 'cookie', cookies: {} }, { popup: { credentials: [USER] } });
    const page = h.open(LOGIN);
    assert.ok(/cf_clearance|cookies/i.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(loginPost(h), undefined);
});

test('an unsupported cookie-aware popup points to Cookie Bridge and skips credentials', function () {
    const h = mgo({ result: 'unsupported' }, { popup: { credentials: [USER] } });
    const page = h.open(LOGIN);
    assert.ok(/Cookie Bridge/.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(loginPost(h), undefined);
});

test('a cookie retrieval error does not enter Password Login', function () {
    const h = mgo({
        result: 'cookie',
        cookies: function () { throw new Error('CEF cookie retrieval failed'); }
    }, { popup: { credentials: [USER] } });
    const page = h.open(LOGIN);
    assert.ok(/cookie|браузер/i.test(page.errors[0] || ''), page.errors.join());
    assert.strictEqual(loginPost(h), undefined);
});
test('manual Cloudflare refresh forces a CEF window without waitForCookie and returns to start', function () {
    let reads = 0;
    const h = mgo({
        result: 'userclose',
        cookies: function () {
            reads++;
            return reads === 1 ? {} : { cf_clearance: fake.CLEARANCE };
        },
        ua: fake.BROWSER_UA
    });
    const page = h.open('rutracker:refreshclearance');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(h.webpopups.length, 1);
    assert.strictEqual(h.webpopups[0].options.waitForCookie, undefined, 'cached rejected cookie cannot auto-close popup');
});
test('manual refresh does not report success when CEF retains the same rejected clearance', function () {
    const stale = 'stale-clearance';
    const h = mgo({
        result: 'userclose',
        cookies: function () { return { cf_clearance: stale }; },
        ua: fake.BROWSER_UA
    });
    const page = h.open('rutracker:refreshclearance');
    assert.deepStrictEqual(page.redirects, []);
    assert.strictEqual(page.errors.length, 1);
    assert.strictEqual(h.webpopups.length, 1);
});


test('an already acquired clearance pair skips CEF on the next Password Login', function () {
    const h = mgo({ result: 'cookie', cookies: browserJar(), ua: fake.BROWSER_UA }, {
        popup: { credentials: [USER, USER] }
    });
    h.open(LOGIN);
    h.webpopups.length = 0;
    const page = h.open(LOGIN);
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(h.webpopups.length, 0);
});

test('on M7 (no webcookies) the Built-in Browser Login is not offered', function () {
    const page = load().open('rutracker:start');
    assert.strictEqual(urls(page).indexOf('rutracker:browserlogin'), -1);
});

test('an http domain does not offer the Built-in Browser Login', function () {
    const h = mgo({}, { settings: { rutracker: { domain: 'http://rutracker.org' } } });
    assert.strictEqual(urls(h.open('rutracker:start')).indexOf('rutracker:browserlogin'), -1);
});

/* ------------------------------------------------------------------ */
section('plugin: Forget only (#3)');

/* What a guest sees, and what the next RuTracker request carries. */
function assertGuest(h, when) {
    const t = titles(h.open('rutracker:start'));
    assert.ok(t.some(function (s) { return /Войти на RuTracker\.org/.test(s); }), when + ': guest page: ' + brief(t));
    assert.ok(!t.some(function (s) { return /Пользователь|Сессия \(/.test(s); }), when + ': no account line: ' + brief(t));
    h.open('rutracker:forum:7:0:x');
    const sent = h.requests[h.requests.length - 1];
    assert.ok(!sent.cookies.bb_session, when + ': the Core Jar\'s bb_session is not sent');
}

test(':start with an Active Session has no Server Logout, and the account line is a plain label', function () {
    const h = load();
    pushSession(h);
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(!urls(page).some(function (u) { return /logout/.test(u); }), urls(page).join(' | '));
    assert.ok(!t.some(function (s) { return /Выйти/.test(s); }), brief(t));
    const account = page.items.filter(function (i) { return /Пользователь \[ TestUser \]/.test(text(i.meta.title)); });
    assert.strictEqual(account.length, 1, brief(t));
    assert.ok(!account[0].url, 'the account line opens nothing: ' + account[0].url);
    assert.strictEqual(account[0].type, 'separator');
    assert.ok(urls(page).indexOf('rutracker:forget') !== -1, 'Forget is offered');
    assert.ok(urls(page).some(function (u) { return /^rutracker:login:/.test(u); }), 'Password Login still offered');
});

test('rutracker:logout, an old bookmark, redirects to :start and posts nothing', function () {
    const h = load();
    pushSession(h);
    const before = h.requests.length;
    const page = h.open('rutracker:logout');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(h.requests.length, before, 'no request at all: ' + h.requests.slice(before).map(function (r) { return r.url; }).join(' '));
    assert.ok(JSON.stringify(h.stores.rutracker_session).indexOf(fake.VALID) !== -1, 'the Session is kept');
});

test('the Forget item says that RuTracker keeps the session valid, and the result says so too', function () {
    const h = load();
    pushSession(h);
    const forget = h.open('rutracker:start').items.filter(function (i) { return i.url === 'rutracker:forget'; })[0];
    assert.ok(forget, 'Forget item');
    assert.ok(/на сайте она останется действующей/.test(text(forget.meta.title)), text(forget.meta.title));
    assert.ok(/в вашем браузере тоже/.test(text(forget.meta.title)), 'a Cookie Bridge Session: the browser keeps its copy: ' + text(forget.meta.title));
    h.open('rutracker:forget');
    assert.ok(h.notifications.some(function (m) { return /остаётся действующей/.test(m) && /браузере/.test(m); }), h.notifications.join(' | '));
});

test('Forget of a Password Login Session hides the login in Movian\'s jar, until the next Session is Active, also after a restart', function () {
    const srv = fake.server();
    const h = load({ server: srv, popup: { credentials: [USER] } });
    h.open(LOGIN);
    assert.strictEqual(h.jar['rutracker.org'].bb_session, fake.VALID, 'the login went to the Core Jar');
    h.open('rutracker:forget');
    assertGuest(h, 'after Forget');
    const restarted = load({ server: srv, settings: h.settingsStore, stores: h.stores, jar: h.jar, popup: { credentials: [USER] } });
    restarted.flush();
    assertGuest(restarted, 'after a restart');
    restarted.open(LOGIN);
    assert.ok(titles(restarted.open('rutracker:start')).some(function (s) { return /Пользователь \[ TestUser \]/.test(s); }), 'signed in again');
    restarted.open('rutracker:forum:7:0:x');
    assert.strictEqual(restarted.requests[restarted.requests.length - 1].cookies.bb_session, fake.VALID, 'the new Session is sent again');
});

test('a session left in Movian\'s own cookie jar is a label, and Forget hides it', function () {
    const h = load();
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    const page = h.open('rutracker:start');
    const t = titles(page);
    assert.ok(t.some(function (s) { return /Пользователь \[ TestUser \] \(сессия Movian\)/.test(s); }), t.slice(0, 3).join(' | '));
    assert.ok(!urls(page).some(function (u) { return /logout/.test(u); }), 'no logout item');
    assert.ok(urls(page).indexOf('rutracker:forget') !== -1, 'Forget is offered for it');
    h.open('rutracker:forget');
    assertGuest(h, 'after Forget');
});

test('"Забыть сессию" forgets it without asking the site', function () {
    const h = load();
    pushSession(h);
    const before = h.requests.length;
    const page = h.open('rutracker:forget');
    assert.strictEqual(h.requests.length, before, 'no request');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), false);
});

test('Forget of a Password Login or a Cookie Bridge Session deletes no bb_* from the browser store', function () {
    /* The browser's cookies are never a Session source any more (#22): only cf_clearance is its copy. */
    const web = { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA, deletecookies: true };
    [['Password Login', function (h) { h.open(LOGIN); }], ['Cookie Bridge', function (h) { pushSession(h); }]].forEach(function (c) {
        const h = load({ popup: { credentials: [USER], web: web } });
        c[1](h);
        assert.ok(h.stores.rutracker_session.session, c[0] + ': a Session is Active');
        h.open('rutracker:forget');
        const bb = h.deleteCookiesCalls.filter(function (x) { return x.names.some(function (n) { return /^bb_/.test(n); }); });
        assert.strictEqual(bb.length, 0, c[0] + ': ' + JSON.stringify(h.deleteCookiesCalls));
        assert.ok(h.deleteCookiesCalls.some(function (x) { return x.names.indexOf('cf_clearance') !== -1; }), c[0] + ': cf_clearance still deleted');
    });
});

test('a Cookie Bridge Clear keeps Movian\'s jar login sent, also after a restart; only the Forget route hides it', function () {
    const srv = fake.server();
    const h = load({ server: srv });
    pushSession(h);
    h.jar['rutracker.org'] = { bb_session: fake.VALID };
    h.item('rutracker_bridge', 'bridgeClear').action();
    h.flush();
    assert.strictEqual(h.stores.rutracker_session.session, '', 'the Bridge Session is dropped');
    assert.notStrictEqual(h.stores.rutracker_session.forgotten, true, 'Clear is not Forget');
    h.open('rutracker:forum:7:0:x');
    assert.strictEqual(h.requests[h.requests.length - 1].cookies.bb_session, fake.VALID, 'the jar login is sent after a Clear');

    const restarted = load({ server: srv, settings: h.settingsStore, stores: h.stores, jar: h.jar });
    restarted.flush();
    restarted.open('rutracker:forum:7:0:x');
    assert.strictEqual(restarted.requests[restarted.requests.length - 1].cookies.bb_session, fake.VALID, 'and after a restart');

    restarted.open('rutracker:forget');
    assertGuest(restarted, 'after the Forget route');
});

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
section('plugin: Built-in Browser Login is removed (#22)');

test('on Movian Go :start offers no Built-in Browser Login, and the old route redirects to :start with no window', function () {
    const h = mgo();
    const page = h.open('rutracker:start');
    assert.ok(urls(page).every(function (u) { return u.indexOf('rutracker:browserlogin') !== 0; }), urls(page).join(' | '));
    assert.ok(!titles(page).some(function (s) { return /встроенный браузер/.test(s); }), brief(titles(page)));
    const old = h.open('rutracker:browserlogin');
    assert.deepStrictEqual(old.redirects, ['rutracker:start']);
    assert.strictEqual(h.webpopups.length, 0, 'no window opened');
});

test('a Session saved by an earlier Built-in Browser Login keeps working while its Session Check passes', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        stores: {
            rutracker_clearance: { pair: { host: 'rutracker.org', value: fake.CLEARANCE, ua: fake.BROWSER_UA } },
            rutracker_session: { session: { source: 'browser', host: 'rutracker.org',
                cookie: 'bb_session=' + fake.VALID + '; bb_guid=g1', ua: fake.BROWSER_UA, user: 'TestUser' } },
        },
    });
    h.flush();
    assert.ok(h.logs.some(function (l) { return /browser: status=authenticated \(TestUser\)/.test(l); }), h.logs.join('\n'));
    const r = h.context.require('movian/http').request('https://rutracker.org/forum/tracker.php?nm=x', { noFail: true });
    assert.strictEqual(r.statuscode, 200);
    assert.strictEqual(h.requests[h.requests.length - 1].cookies.bb_session, fake.VALID);
});

test('after a Forget, Password Login shows the dialog even with saved credentials; after that sign-in the saved ones are used silently again', function () {
    const h = load({ popup: { credentials: [], saved: USER } });
    h.open(LOGIN);
    assert.deepStrictEqual(h.authPrompts.map(function (p) { return p.silent; }), [true], 'first sign-in takes the saved credentials');
    assert.ok(h.stores.rutracker_session.session, 'signed in');
    h.open('rutracker:forget');
    h.popup.credentials.push(USER);
    const page = h.open(LOGIN);
    const after = h.authPrompts[h.authPrompts.length - 1];
    assert.deepStrictEqual({ showAuth: after.showAuth, silent: after.silent }, { showAuth: true, silent: false }, 'the dialog after Forget');
    assert.deepStrictEqual(page.redirects, ['rutracker:start'], page.errors.join());
    assert.strictEqual(h.authPrompts.filter(function (p) { return p.silent; }).length, 1, 'no silent sign-in after Forget');
    h.open(LOGIN);
    assert.strictEqual(h.authPrompts[h.authPrompts.length - 1].silent, true, 'a later sign-in uses the saved credentials');
});

test('after a Forget, the automatic Password Login of the start page (startAuth) shows the dialog too', function () {
    const h = load({ popup: { credentials: [], saved: USER }, settings: { rutracker: { startAuth: true } } });
    h.open(h.open('rutracker:start').redirects[0]);
    assert.deepStrictEqual(h.authPrompts.map(function (p) { return p.silent; }), [true], 'the start page signs in with the saved credentials');
    h.open('rutracker:forget');
    h.popup.credentials.push(USER);
    const start = h.open('rutracker:start');
    assert.deepStrictEqual(start.redirects.length, 1, 'the start page asks for a login');
    h.open(start.redirects[0]);
    const after = h.authPrompts[h.authPrompts.length - 1];
    assert.deepStrictEqual({ showAuth: after.showAuth, silent: after.silent }, { showAuth: true, silent: false });
});

test('Forget of a Session from an earlier browser login deletes cf_clearance from the browser store and no bb_*', function () {
    const h = mgo({ deletecookies: true }, {
        stores: { rutracker_session: { session: { source: 'browser', host: 'rutracker.org',
            cookie: 'bb_session=' + fake.VALID + '; bb_guid=g1', ua: fake.BROWSER_UA, user: 'TestUser' } } },
    });
    h.open('rutracker:forget');
    const names = [].concat.apply([], h.deleteCookiesCalls.map(function (c) { return c.names; }));
    assert.ok(names.indexOf('cf_clearance') !== -1, 'cf_clearance deleted: ' + names.join(','));
    assert.deepStrictEqual(names.filter(function (n) { return /^bb_/.test(n); }), [], 'no bb_* deleted');
});

section('plugin: cookie bridge');

test('an STPP push is applied without restart and verified on the site', function () {
    const h = load({ serverOptions: { cloudflare: true } });
    pushSession(h);
    assert.ok(h.logs.some(function (l) { return /status=authenticated \(TestUser\)/.test(l); }), h.logs.join('\n'));
    const req = h.requests[h.requests.length - 1];
    assert.strictEqual(req.headers['user-agent'], fake.BROWSER_UA);
    assert.strictEqual(req.cookies.cf_clearance, fake.CLEARANCE);
});

test('a Cookie Bridge push that fails its check does not replace a working session', function () {
    [['rejected', 'bb_session=expired; bb_guid=g1', fake.BROWSER_UA], ['challenge', fake.browserCookie(), 'OtherUA/1']].forEach(function (c) {
        const h = load({ serverOptions: { cloudflare: true } });
        pushSession(h);
        pushSession(h, c[1], c[2]);
        assert.ok(h.notifications.some(function (n) { return /не прош/.test(n); }), c[0] + ': user told: ' + h.notifications.join(' | '));
        const r = h.context.require('movian/http').request('https://rutracker.org/forum/tracker.php?nm=x', { noFail: true });
        assert.strictEqual(r.statuscode, 200, c[0] + ': the working session is still sent');
        assert.strictEqual(h.requests[h.requests.length - 1].headers['user-agent'], fake.BROWSER_UA, c[0]);
    });
});

test('a Cookie Bridge push that passes its check is announced', function () {
    const h = load();
    pushSession(h);
    assert.ok(h.notifications.some(function (n) { return /TestUser/.test(n); }), h.notifications.join(' | '));
});

test('an installed bridge session survives the upgrade: adopted once, re-checked, old copy removed', function () {
    /* What 0.9.0 left on disk: the cookie in the bridge store, the UA in the
     * settings item. */
    const stores = { rutracker_bridge: { cookie: fake.browserCookie() } };
    const settings = { rutracker_bridge: { browserUA: fake.BROWSER_UA } };
    const h = load({ serverOptions: { cloudflare: true }, stores: stores, settings: settings });
    h.flush();
    assert.ok(bridgeCookiesOn(h, 'https://rutracker.org/forum/tracker.php?nm=x'), 'still applied');
    assert.strictEqual(h.requests[h.requests.length - 1].headers['user-agent'], fake.BROWSER_UA);
    assert.ok(h.logs.some(function (l) { return /bridge: status=authenticated \(TestUser\)/.test(l); }), h.logs.join('\n'));
    assert.strictEqual(String(h.stores.rutracker_bridge.cookie || ''), '', 'no second copy in the old store');
    assert.strictEqual(JSON.stringify(h.settingsStore).indexOf(fake.VALID), -1);
    const again = load({ stores: h.stores, settings: h.settingsStore });
    again.flush();
    assert.ok(bridgeCookiesOn(again, 'https://rutracker.org/forum/index.php'), 'after the next restart too');
});

test(':start shows the Active Session with its source and check result', function () {
    const h = load({ serverOptions: { cloudflare: true } });
    pushSession(h);
    const t = titles(h.open('rutracker:start'));
    assert.ok(t.some(function (s) { return /Сессия \(Cookie Bridge\): вход выполнен как TestUser/.test(s); }), t.slice(0, 3).join(' | '));
});

test('bridge cookies are not given to hosts outside the allow-list', function () {
    const h = load();
    pushSession(h);
    const http = h.context.require('movian/http');
    http.request('https://rutracker.org.evil.example/forum/index.php', { noFail: true });
    http.request('https://static.example/?ref=rutracker.org', { noFail: true });
    h.requests.slice(-2).forEach(function (r) {
        assert.strictEqual(r.cookies.bb_session || '', '', r.url);
    });
});

test('clear session empties the runtime session and the settings', function () {
    const h = load();
    pushSession(h);
    h.item('rutracker_bridge', 'bridgeClear').action();
    assert.strictEqual(h.item('rutracker_bridge', 'browserCookie').value, '');
    assert.strictEqual(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), false);
});

test('clearing right after a transfer cancels its pending hand-over', function () {
    /* Codex on PR #10: the hand-over runs from a timer, which "Clear"
     * did not cancel, so the cleared session came back as Active Session. */
    const h = load();
    h.stppSet(BRIDGE + 'browserCookie.value', fake.browserCookie());
    h.stppSet(BRIDGE + 'browserUA.value', fake.BROWSER_UA);
    h.item('rutracker_bridge', 'bridgeClear').action();
    h.flush();
    assert.ok(!h.stores.rutracker_session || !h.stores.rutracker_session.session, 'the cleared session stays gone');
});

test('a UA half left alone does not block the same pair sent again (#44)', function () {
    /* Codex on the mirror PR: the timed-out UA stayed in browserUA, so the
     * same UA sent again was no change and no callback; every retry lacked it. */
    const h = load();
    h.stppSet(BRIDGE + 'browserUA.value', fake.BROWSER_UA);
    h.tick(3001);
    pushSession(h);
    assert.ok(bridgeCookiesOn(h, 'https://rutracker.org/forum/index.php'), 'the retried pair is the session');
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
    //  '' is the jar's bb_session hidden by the inspector.
    toEvil.forEach(function (r) { assert.strictEqual(r.cookies.bb_session || '', '', r.url); });
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

test('a Session saved with its cf_clearance hands it to the Clearance once', function () {
    /* Before docs/adr/0003 the Session kept a second copy of cf_clearance. */
    const h = load({ serverOptions: { cloudflare: true }, stores: { rutracker_session: { session: {
        source: 'bridge', host: 'rutracker.org', cookie: fake.browserCookie(), ua: fake.BROWSER_UA, user: 'TestUser' } } } });
    h.flush();
    assert.ok(!/cf_clearance/.test(h.stores.rutracker_session.session.cookie), 'the Session lost its copy');
    assert.strictEqual(h.stores.rutracker_clearance.pair.value, fake.CLEARANCE);
    assert.strictEqual(h.stores.rutracker_clearance.pair.ua, fake.BROWSER_UA);
    const r = h.context.require('movian/http').request('https://rutracker.org/forum/tracker.php?nm=x', { noFail: true });
    assert.strictEqual(r.statuscode, 200, 'it still travels with the Session');
    assert.ok(h.logs.some(function (l) { return /bridge: status=authenticated/.test(l); }), h.logs.join('\n'));
});

test('on M7 a Clearance Cloudflare no longer takes is dropped at its first Challenge', function () {
    /* No window to get a new one: the next Cookie Bridge transfer brings it.
     * Until then the dead cookie is not sent again. */
    let dead = false;
    const site = fake.server({ cloudflare: true });
    const h = load({ server: function (req) {
        if (dead && req.cookies.cf_clearance === fake.CLEARANCE)
            return site(Object.assign({}, req, { cookies: Object.assign({}, req.cookies, { cf_clearance: 'revoked' }) }));
        return site(req);
    } });
    pushSession(h);
    dead = true;
    const page = h.open('rutracker:search:0:matrix');
    assert.ok(page.errors.length || page.redirects.length, 'the page met the Challenge');
    assert.strictEqual(String(h.stores.rutracker_clearance.pair || ''), '', 'dropped from the store');
    h.context.require('movian/http').request('https://rutracker.org/forum/index.php', { noFail: true });
    assert.strictEqual(h.requests[h.requests.length - 1].cookies.cf_clearance, '', 'not sent again');
    assert.strictEqual(h.stores.rutracker_session.session.source, 'bridge', 'the Session stays');
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

test('before the check runs the log says received, not authenticated', function () {
    const h = load();
    h.stppSet(BRIDGE + 'browserCookie.value', fake.browserCookie());
    h.stppSet(BRIDGE + 'browserUA.value', fake.BROWSER_UA);
    assert.ok(h.logs.some(function (l) { return /cookie received/.test(l); }), h.logs.join('|'));
    assert.ok(!h.logs.some(function (l) { return /authenticated/.test(l); }), h.logs.join('|'));
});

/* ------------------------------------------------------------------ */
section('security: secrets never reach movian.log');

/* Visits every route once with a bridge session; the legacy login comes
 * late because it replaces the bridge session. */
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
    h.open('rutracker:logout');
    h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    h.open('rutracker:start');
    if (h.popup.web) h.open('rutracker:refreshclearance');
    h.open('rutracker:forget');
}

/* Synthetic secrets of every Session Source: the session and clearance
 * cookies, the bridge guid, the password. */
const SECRETS = [fake.VALID, fake.CLEARANCE, 'secret-password', 'g1'];

function secretsIn(name, text) {
    SECRETS.forEach(function (secret) {
        assert.strictEqual(String(text).indexOf(secret), -1, secret + ' in ' + name);
    });
}

test('no secret of any Session Source reaches the log, notifications, settings or the STPP-readable tree', function () {
    /* settings.apps.nodes.* is the prop tree STPP and /api/prop serve; the
     * settings files are its persisted form. Only the plugin's own store,
     * which is a file outside that tree, holds the Active Session. */
    const h = load({ popup: { credentials: [{ username: 'user', password: 'secret-password' }],
        web: { result: 'userclose', cookies: { bb_guid: 'g1', bb_session: fake.VALID, cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } } });
    exerciseAll(h);
    assert.ok(h.webpopups.length === 1 && h.requests.some(function (r) { return r.postdata && r.postdata.login_password; }), 'all three sources ran');
    secretsIn('log', h.logs.join('\n'));
    secretsIn('notifications', h.notifications.join('\n'));
    secretsIn('settings files', JSON.stringify(h.settingsStore));
    Object.keys(h.groups).forEach(function (g) {
        Object.keys(h.groups[g].items).forEach(function (id) { secretsIn('prop ' + g + '.' + id, h.groups[g].items[id].value); });
    });
    Object.keys(h.stores).forEach(function (name) {
        if (name !== 'rutracker_session') secretsIn('store ' + name, JSON.stringify(h.stores[name]));
    });
});

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
    const whileBridged = h.requests.slice(0, h.requests.findIndex(function (r) { return r.postdata && r.postdata.login_username; }));
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


section('plugin: clearance capability split and Core persistence (WS5)');

function cfCore(web, extra) {
    return load(Object.assign({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: Object.assign({
            result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA, core: true
        }, web) }
    }, extra || {}));
}

test('Android-like core (webcookies + persist API): clearance and Password Login, no Built-in Browser Login', function () {
    let reads = 0;
    const h = cfCore({ cookies: function () { return reads++ ? { cf_clearance: fake.CLEARANCE } : {}; } });
    const u = urls(h.open('rutracker:start'));
    assert.strictEqual(u.indexOf('rutracker:browserlogin'), -1, u.join());
    assert.notStrictEqual(u.indexOf('rutracker:refreshclearance'), -1, 'clearance stays available');
    assert.ok(u.some(function (x) { return /^rutracker:login:/.test(x); }), 'Password Login stays');
    const refresh = h.open('rutracker:refreshclearance');
    assert.strictEqual(refresh.errors.length, 0, refresh.errors.join());
    assert.deepStrictEqual(refresh.redirects, ['rutracker:start']);
});

function passwordLoginRun() {
    const h = load({
        serverOptions: { cloudflare: true },
        popup: { credentials: [USER], web: {
            result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA,
            core: true,
        } }
    });
    h.login = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    return h;
}

test('Android-like core: Password Login acquires and persists clearance first, then signs in', function () {
    const h = passwordLoginRun();
    assert.strictEqual(h.webpopups.length, 1, 'clearance window first');
    assert.strictEqual(h.persistWebCookieCalls, 1);
    assert.strictEqual(h.login.errors.length, 0, h.login.errors.join());
    assert.strictEqual(h.server.state.logins.length, 1);
    assert.deepStrictEqual(h.login.redirects, ['rutracker:start']);
});

test('Password Login POST sends its explicit clearance Cookie and never persistedCookies', function () {
    const h = passwordLoginRun();
    const post = h.requests.filter(function (r) { return r.postdata && r.postdata.login_username; })[0] ||
        h.requests.filter(function (r) { return r.method === 'POST'; })[0];
    assert.ok(post, 'login POST was made');
    assert.notStrictEqual(post.opts.persistedCookies, true);
    assert.strictEqual(post.cookies.cf_clearance, fake.CLEARANCE);
});

test('a Movian Go core offers no Built-in Browser Login, even with popup.webcookies', function () {
    const h = cfCore({ supportsBrowserLogin: true, cookies: {} }, { jar: {} });
    const u = urls(h.open('rutracker:start'));
    assert.strictEqual(u.indexOf('rutracker:browserlogin'), -1, u.join());
    assert.notStrictEqual(u.indexOf('rutracker:refreshclearance'), -1, 'clearance stays available');
});

test('a core with webcookies but no Movian Go browser login offers none, and keeps the clearance', function () {
    const h = cfCore({});
    const u = urls(h.open('rutracker:start'));
    assert.strictEqual(u.indexOf('rutracker:browserlogin'), -1);
    assert.notStrictEqual(u.indexOf('rutracker:refreshclearance'), -1);
});

test('clearance persists in Core and is restored after a simulated restart', function () {
    const h = cfCore({});
    h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1);
    assert.strictEqual(h.persistWebCookieCalls, 1, 'persisted after the clearance');
    const restarted = cfCore({ cookies: {} }, { coreStore: h.coreStore });
    const page = restarted.open('rutracker:search:0:matrix');
    assert.strictEqual(restarted.webpopups.length, 0, 'restored without the browser');
    assert.strictEqual(restarted.getPersistedWebCookieCalls >= 1, true);
    assert.strictEqual(page.errors.length, 0);
    assert.strictEqual(page.items.filter(function (i) { return /:topic:/.test(i.url); }).length, 8);
});

test('requests carry persistedCookies only once a Core clearance is active, and never on Password Login POST', function () {
    const h = cfCore({ persistedWebCookie: undefined }, {
        serverOptions: { cloudflare: true }, jar: { 'rutracker.org': { bb_session: fake.VALID } }
    });
    h.open('rutracker:search:0:matrix');
    const first = h.requests[0];
    assert.notStrictEqual(first.opts.persistedCookies, true, 'a plain request before clearance');
    const withClearance = h.requests.filter(function (r) { return r.cookies.cf_clearance === fake.CLEARANCE; });
    assert.ok(withClearance.length > 0);
    withClearance.forEach(function (r) {
        assert.strictEqual(r.opts.persistedCookies, true, r.url);
    });
    h.requests.forEach(function (r) {
        if (r.opts.persistedCookies === true) assert.ok(/^https:\/\/rutracker\.org\//.test(r.url));
    });
});

test('a null from persistWebCookie gives the persistfailed status and no Core clearance', function () {
    let reads = 0;
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID } },
        popup: { web: {
            result: 'userclose', ua: fake.BROWSER_UA,
            cookies: function () { return reads++ ? { cf_clearance: fake.CLEARANCE } : {}; },
            persistWebCookie: null
        } }
    });
    const page = h.open('rutracker:refreshclearance');
    assert.strictEqual(page.errors.length, 1);
    assert.ok(/сохранить Cloudflare clearance/.test(page.errors[0]));
    assert.ok(!h.requests.some(function (r) { return r.opts.persistedCookies === true; }));
});

test('Forget deletes the persisted Core clearance', function () {
    const h = cfCore({});
    h.open('rutracker:search:0:matrix');
    assert.ok(h.coreStore.cf_clearance, 'stored');
    const page = h.open('rutracker:forget');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(h.deletePersistedCalls, 1);
    assert.strictEqual(h.coreStore.cf_clearance, undefined);
});

test('Forget also deletes cf_clearance from the browser store, next to the RuTracker session cookies', function () {
    const h = cfCore({ deletecookies: true });
    h.open('rutracker:search:0:matrix');
    const page = h.open('rutracker:forget');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    //  JSON: the plugin's arrays come from the vm context, deepStrictEqual would compare realms.
    assert.strictEqual(JSON.stringify(h.deleteCookiesCalls.filter(function (c) { return c.names.indexOf('cf_clearance') !== -1; })),
        JSON.stringify([{ url: 'https://rutracker.org/forum/', names: ['cf_clearance'] }]));
    assert.strictEqual(h.coreStore.cf_clearance, undefined, 'Core record is gone too');
});

test('Forget still drops the Core record where popup.deletecookies is missing', function () {
    const h = cfCore({});
    h.open('rutracker:search:0:matrix');
    const page = h.open('rutracker:forget');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.strictEqual(h.deleteCookiesCalls, undefined);
    assert.strictEqual(h.coreStore.cf_clearance, undefined);
});

test('a throwing popup.deletecookies does not break Forget', function () {
    const h = cfCore({ deletecookies: new Error('boom') });
    h.open('rutracker:search:0:matrix');
    const page = h.open('rutracker:forget');
    assert.deepStrictEqual(page.redirects, ['rutracker:start']);
    assert.ok(h.deleteCookiesCalls.some(function (c) { return c.names.indexOf('cf_clearance') !== -1; }), 'cf_clearance deletion was attempted');
    assert.strictEqual(h.coreStore.cf_clearance, undefined);
});

test('the clearance value does not reach logs or notifications on Forget', function () {
    const h = cfCore({ deletecookies: new Error('boom') });
    h.open('rutracker:search:0:matrix');
    h.open('rutracker:forget');
    const emitted = JSON.stringify([h.logs, h.notifications, h.stores, h.settingsStore]);
    assert.strictEqual(emitted.indexOf(fake.CLEARANCE), -1);
});

test('the Core clearance value does not reach logs, notifications or plugin stores', function () {
    const h = cfCore({});
    h.open('rutracker:search:0:matrix');
    const emitted = JSON.stringify([h.logs, h.notifications, h.stores, h.settingsStore]);
    assert.strictEqual(emitted.indexOf(fake.CLEARANCE), -1);
});

test('direct torrent links of a topic go through the plugin client, which sends the Core-held clearance', function () {
    const first = cfCore({});
    first.open('rutracker:search:0:matrix');
    const h = cfCore({ cookies: {} }, { coreStore: first.coreStore });
    const u = urls(h.open('rutracker:topic:6924363:x'));
    assert.strictEqual(u.filter(function (x) { return /^https?:.*dl\.php/.test(x); }).length, 0, u.join('\n'));
    h.requests.length = 0;
    const page = h.open('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363'));
    assert.strictEqual(page.errors.length, 0, page.errors.join());
    assert.strictEqual(h.requests[0].opts.persistedCookies, true);
});

test('a stale Core-held Clearance is dropped at its first Challenge and replaced in the window', function () {
    /* One copy of cf_clearance: after a restart the Active Session travels
     * with the Core record. When Cloudflare no longer takes it, it is
     * deleted everywhere and the window gets a new one. */
    const first = cfCore({}, { jar: {}, popup: { credentials: [USER], web: {
        result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA, core: true } } });
    first.open(LOGIN);
    assert.ok(first.stores.rutracker_session && first.stores.rutracker_session.session, 'session stored');
    const stale = { value: 'stale-clearance', ua: 'StaleUA/1', expires: Math.floor(Date.now() / 1000) + 3600 };
    const h = cfCore({ cookies: browserJar() }, {
        stores: first.stores, jar: first.jar, coreStore: { cf_clearance: stale }
    });
    h.requests.length = 0;
    const page = h.open('rutracker:search:0:matrix');
    assert.strictEqual(page.errors.length, 0, page.errors.join());
    assert.strictEqual(h.webpopups.length, 1, 'one window');
    assert.ok(h.deletePersistedCalls >= 1, 'the stale Core record was deleted');
    assert.strictEqual(h.coreStore.cf_clearance.value, fake.CLEARANCE, 'the new one is Core\'s');
    const last = h.requests[h.requests.length - 1];
    assert.strictEqual(last.opts.persistedCookies, true, 'Core sends the new one with the Session');
    assert.strictEqual(last.cookies.bb_session, fake.VALID);
});

test('a Cookie Bridge clearance replaces an older Core record, so a restart does not bring the old one back', function () {
    /* Codex on PR #10: the Bridge pair went to the plugin store, the old
     * Core record stayed, and on restart it was restored first and wiped
     * the new pair. */
    const old = { cf_clearance: { value: 'old-clearance', ua: 'OldUA/1', expires: Math.floor(Date.now() / 1000) + 3600 } };
    const first = cfCore({}, { coreStore: old, jar: {} });
    first.flush();
    pushSession(first);
    const h = cfCore({}, { coreStore: first.coreStore, jar: {},
        settings: first.settingsStore, stores: first.stores });
    h.flush();
    assert.ok(h.logs.some(function (l) { return /status=authenticated/.test(l); }), h.logs.join('\n'));
    const page = h.open('rutracker:forum:7:0:x');
    assert.strictEqual(h.webpopups.length, 0, 'no Clearance Refresh');
    assert.ok(page.items.some(function (i) { return /:topic:/.test(i.url); }));
});

test('a clearance window on a custom https mirror keeps its clearance for the next pages', function () {
    /* Codex on PR #10: the Clearance took only the official hosts, so the
     * mirror's cf_clearance, stripped from the Session, was lost. */
    const site = fake.server({ cloudflare: true });
    let reads = 0;
    const h = mgo({ cookies: function () { return reads++ ? browserJar() : {}; } }, {
        settings: { rutracker: { domain: 'https://mirror.example' } },
        server: function (req) {
            return site(Object.assign({}, req, { url: req.url.replace('https://mirror.example/', 'https://rutracker.org/') }));
        }
    });
    h.open('rutracker:refreshclearance');
    const page = h.open('rutracker:forum:7:0:x');
    assert.strictEqual(h.webpopups.length, 1, 'only the clearance window');
    assert.ok(page.items.some(function (i) { return /:topic:/.test(i.url); }), 'the forum loaded');
});

test('a topic opened at its second page (start=30) shows comments, not the release', function () {
    /* Codex on PR #10, issue #11: topic pages hold 30 posts, the pager
     * counted 50, so start=30 was taken for the first page. */
    const h = load();
    const page = h.open('rutracker:topic:6924363:' + encodeURIComponent('x') + ':30');
    const titles = page.items.map(function (i) { const x = i.meta && i.meta.title; return x && x.toRichString ? x.toRichString() : String(x); });
    assert.ok(titles.indexOf('Торренты:') === -1, titles.slice(0, 3).join('|'));
    assert.ok(titles.some(function (s) { return /Комментарии .*2/.test(s); }), titles.slice(0, 3).join('|'));
});

test('with an http domain chosen, a Cookie Bridge clearance still survives a restart', function () {
    /* gpt-6.1-sol review of PR #10: the plugin store existed only for an
     * https domain, and the Session is saved without cf_clearance. */
    const first = load({ serverOptions: { cloudflare: true }, settings: { rutracker: { domain: 'http://rutracker.org' } } });
    pushSession(first);
    const h = load({ serverOptions: { cloudflare: true }, settings: first.settingsStore, stores: first.stores });
    h.flush();
    h.context.require('movian/http').request('https://rutracker.org/forum/viewforum.php?f=7', { noFail: true });
    assert.strictEqual(h.requests[h.requests.length - 1].cookies.cf_clearance, fake.CLEARANCE);
});

test('Cookie Bridge "Clear" also deletes the Core clearance record, so a restart does not bring it back', function () {
    /* gpt-6.1-sol review of PR #10: Clear dropped the pair in memory and in
     * the plugin store only. */
    const record = { cf_clearance: { value: fake.CLEARANCE, ua: fake.BROWSER_UA, expires: Math.floor(Date.now() / 1000) + 3600 } };
    const first = cfCore({ cookies: {} }, { coreStore: record });
    first.item('rutracker_bridge', 'bridgeClear').action();
    assert.strictEqual(first.coreStore.cf_clearance, undefined);
    const h = cfCore({ cookies: {} }, { coreStore: first.coreStore, stores: first.stores, settings: first.settingsStore });
    h.context.require('movian/http').request('https://rutracker.org/forum/index.php', { noFail: true });
    assert.ok(!h.requests[h.requests.length - 1].cookies.cf_clearance);
});

section('plugin: the Core Jar cf_clearance follows the held Clearance (#12)');

test('scenario A: a jar cf_clearance for rutracker.net is not sent with a Session whose Clearance is held for rutracker.org', function () {
    const h = load({ serverOptions: { cloudflare: true } });
    pushSession(h);
    h.jar['rutracker.net'] = { cf_clearance: 'net-jar-clearance' };
    h.context.require('movian/http').request('https://rutracker.net/forum/viewforum.php?f=7', { noFail: true });
    const request = h.requests[h.requests.length - 1];
    assert.strictEqual(request.cookies.bb_session, fake.VALID, 'the Session still goes to rutracker.net');
    assert.strictEqual(request.cookies.cf_clearance, '', 'no cf_clearance: the Clearance is for rutracker.org only');
});

test('scenario B: a stored Session without a Clearance and a jar cf_clearance: the start-up check and the next forum request agree', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        stores: { rutracker_session: { session: { source: 'password', host: 'rutracker.org',
            cookie: fake.SESSION + '=' + fake.VALID, ua: fake.BROWSER_UA, user: 'TestUser' } } },
        jar: { 'rutracker.org': { bb_session: fake.VALID, cf_clearance: fake.CLEARANCE } }
    });
    h.flush();  /* the start-up Session Check */
    const check = h.requests.filter(function (r) { return r.url.indexOf('https://rutracker.org/forum/') === 0; }).pop();
    //  The isolated check sends its own Cookie header: nothing from the jar to hide.
    assert.strictEqual(check.cookies.cf_clearance, undefined, 'the check sends no cf_clearance');
    assert.ok(/Cloudflare/.test(titles(h.open('rutracker:start'))[0]), 'the start-up check meets the challenge');
    const res = h.context.require('movian/http').request('https://rutracker.org/forum/viewforum.php?f=7', { noFail: true });
    const forum = h.requests[h.requests.length - 1];
    assert.strictEqual(forum.cookies.cf_clearance, '', 'the next forum request sends no cf_clearance either');
    assert.strictEqual(res.statuscode, 403, 'and meets the same challenge');
});

test('a plugin-store Clearance goes with its own User-Agent, not with the jar cf_clearance', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        stores: {
            rutracker_session: { session: { source: 'password', host: 'rutracker.org',
                cookie: fake.SESSION + '=' + fake.VALID, ua: 'SessionUA/1', user: 'TestUser' } },
            rutracker_clearance: { pair: { host: 'rutracker.org', value: fake.CLEARANCE, ua: fake.BROWSER_UA } }
        },
        jar: { 'rutracker.org': { bb_session: fake.VALID, cf_clearance: 'jar-clearance' } }
    });
    h.context.require('movian/http').request('https://rutracker.org/forum/viewforum.php?f=7', { noFail: true });
    const request = h.requests[h.requests.length - 1];
    assert.strictEqual(request.cookies.cf_clearance, fake.CLEARANCE);
    assert.strictEqual(request.headers['user-agent'], fake.BROWSER_UA);
});

test('a Core record (persisted clearance) goes with its User-Agent; the Core Jar cf_clearance is not added by the plugin', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID, cf_clearance: 'jar-clearance' } },
        popup: { web: {
            result: 'userclose',
            cookies: {},
            ua: '',
            persistedWebCookie: { value: fake.CLEARANCE, ua: fake.BROWSER_UA, expires: Math.floor(Date.now() / 1000) + 3600 }
        } }
    });
    h.open('rutracker:search:0:matrix');
    const request = h.requests.filter(function (r) { return r.url.indexOf('/forum/tracker.php?') !== -1; })[0];
    assert.strictEqual(request.opts.persistedCookies, true);
    assert.strictEqual(request.cookies.cf_clearance, fake.CLEARANCE);
    assert.strictEqual(request.headers['user-agent'], fake.BROWSER_UA);
});


test('M7 with only a jar cf_clearance on the chosen host: a forum request carries no cf_clearance, and the jar bb_* cookies still go', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        jar: { 'rutracker.org': { bb_session: fake.VALID, bb_guid: 'g1', bb_ssl: '1', cf_clearance: fake.CLEARANCE } }
    });
    const res = h.context.require('movian/http').request('https://rutracker.org/forum/viewforum.php?f=7', { noFail: true });
    const request = h.requests[h.requests.length - 1];
    assert.strictEqual(res.statuscode, 403, 'without a Clearance the forum meets the challenge');
    assert.strictEqual(request.cookies.cf_clearance, '', 'the jar copy is hidden');
    assert.strictEqual(request.cookies.bb_session, fake.VALID);
    assert.strictEqual(request.cookies.bb_guid, 'g1');
    assert.strictEqual(request.cookies.bb_ssl, '1');
});

test('a Core record with expires 0 is expired: the harness neither sends it nor accepts it as held', function () {
    /* src/bridge/clearance.js: any expires that is not undefined or null is a
     * timestamp, and 0 is in the past (offer() refuses it). */
    const h = load({
        serverOptions: { cloudflare: true },
        popup: { web: { result: 'userclose', cookies: {}, ua: '', persistedWebCookie: { value: fake.CLEARANCE, ua: fake.BROWSER_UA, expires: 0 } } }
    });
    takeLeaks();
    const http = h.context.require('movian/http');
    http.request('https://rutracker.org/forum/index.php', { noFail: true, persistedCookies: true });
    assert.notStrictEqual(h.requests[h.requests.length - 1].cookies.cf_clearance, fake.CLEARANCE, 'not sent by Core');
    http.request('https://rutracker.org/forum/index.php', { noFail: true, persistedCookies: true,
        headers: { Cookie: 'cf_clearance=' + fake.CLEARANCE, 'User-Agent': fake.BROWSER_UA } });
    const leaks = takeLeaks();
    assert.ok(leaks.some(function (l) { return /no Clearance held/.test(l); }), 'the invariant does not accept it: ' + leaks.join('; '));
});

test('a plugin-store Clearance with expires 0 is expired: the invariant does not accept it as held', function () {
    const h = load({
        serverOptions: { cloudflare: true },
        stores: { rutracker_clearance: { pair: { host: 'rutracker.org', value: fake.CLEARANCE, ua: fake.BROWSER_UA, expires: 0 } } }
    });
    takeLeaks();
    h.context.require('movian/http').request('https://rutracker.org/forum/index.php', { noFail: true,
        headers: { Cookie: 'cf_clearance=' + fake.CLEARANCE, 'User-Agent': fake.BROWSER_UA } });
    const leaks = takeLeaks();
    assert.ok(leaks.some(function (l) { return /no Clearance held/.test(l); }), 'the invariant does not accept it: ' + leaks.join('; '));
});

/* ------------------------------------------------------------------ */
section('plugin: a Challenge drops the Clearance the request carried (#13)');

/* The plugin store's Clearance (src/bridge/clearance.js), held for rutracker.org. */
function heldStores(value) {
    return { rutracker_clearance: { pair: { host: 'rutracker.org', value: value || fake.CLEARANCE, ua: fake.BROWSER_UA } } };
}

function sessionStores() {
    return { rutracker_session: { session: { source: 'password', host: 'rutracker.org',
        cookie: fake.SESSION + '=' + fake.VALID, ua: fake.BROWSER_UA, user: 'TestUser' } } };
}

function storedPair(h) {
    const pair = h.stores.rutracker_clearance && h.stores.rutracker_clearance.pair;
    return pair && pair.value ? pair.value : '';
}

test('a Cookie Bridge check that meets a Challenge drops the pair it carried: the next request, a restart and the stores agree', function () {
    /* The site accepted the Bridge pair; then it refuses it, and "check
     * session" meets the real challenge fixture with that pair. */
    const so = { cloudflare: true };
    const h = load({ serverOptions: so });
    pushSession(h);
    assert.strictEqual(storedPair(h), fake.CLEARANCE, 'the Bridge pair is held');
    so.clearance = 'refused-clearance';
    h.item('rutracker_bridge', 'bridgeCheck').action();
    h.flush();
    h.open('rutracker:start');
    assert.ok(!h.requests[h.requests.length - 1].cookies.cf_clearance, 'the next request carries no cf_clearance');
    assert.strictEqual(storedPair(h), '', 'the store holds no pair');
    const again = load({ serverOptions: so, stores: h.stores });
    again.flush();
    again.open('rutracker:start');
    assert.ok(!again.requests[again.requests.length - 1].cookies.cf_clearance, 'a restart does not restore it');
    assert.strictEqual(storedPair(again), '', 'a restart restores no pair');
});

test('the global searcher drops the held pair it met a Challenge with, and opens no window', function () {
    const h = load({
        serverOptions: { cloudflare: true, clearance: 'refused-clearance' },
        stores: heldStores(),
        popup: { web: { result: 'userclose', cookies: { cf_clearance: fake.CLEARANCE }, ua: fake.BROWSER_UA } }
    });
    const page = h.search('matrix');
    assert.strictEqual(h.webpopups.length, 0, 'no Clearance window');
    assert.deepStrictEqual(titles(page), ['Поиск не выполнен: сайт не вернул результаты (сеть или проверка Cloudflare)']);
    assert.strictEqual(storedPair(h), '', 'the store holds no pair');
    const again = load({ serverOptions: { cloudflare: true, clearance: 'refused-clearance' }, stores: h.stores });
    again.open('rutracker:start');
    assert.ok(!again.requests[again.requests.length - 1].cookies.cf_clearance, 'a restart does not restore it');
});

test('Password Login drops the held pair its form carried when Cloudflare challenges the form', function () {
    const h = load({
        serverOptions: { cloudflare: true, clearance: 'refused-clearance' },
        stores: heldStores(),
        popup: { credentials: [{ username: 'user', password: 'secret-password' }] }
    });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.ok(/Cloudflare/.test(page.errors[0] || ''), page.errors.join());
    const form = h.requests.filter(function (r) { return /login\.php$/.test(r.url) && r.postdata; });
    assert.strictEqual(form.length, 1, 'one form request');
    assert.strictEqual(form[0].cookies.cf_clearance, fake.CLEARANCE, 'the form carried the held pair');
    assert.strictEqual(h.webpopups.length, 0, 'no window while a Clearance is held');
    assert.strictEqual(storedPair(h), '', 'the store holds no pair');
    h.open('rutracker:start');
    assert.ok(!h.requests[h.requests.length - 1].cookies.cf_clearance, 'the next request carries no cf_clearance');
});

test('a Session Check that meets a Challenge keeps the Clearance another page refreshed while it waited, and sends that one', function () {
    /* Movian runs other pages while a request waits. Here another page
     * refreshes the Clearance during the Session Check, and the pair the check
     * carried is refused. The newer pair stays held and the next request sends it. */
    const NEW = 'refreshed-clearance';
    const site = fake.server({ cloudflare: true, clearance: NEW });
    let h;
    h = load({
        server: function (req) {
            if (/viewforum\.php\?f=7$/.test(req.url) && req.cookies.cf_clearance === fake.CLEARANCE)
                h.context.clearance.offer('https://rutracker.org/forum/', 'cf_clearance=' + NEW, fake.BROWSER_UA);
            return site(req);
        },
        stores: Object.assign(sessionStores(), heldStores())
    });
    h.flush();
    assert.ok(/Cloudflare/.test(titles(h.open('rutracker:start'))[0]), 'the check met the challenge');
    assert.strictEqual(storedPair(h), NEW, 'the newer Clearance stays held');
    const page = h.open('rutracker:forum:7:0:' + encodeURIComponent('Зарубежное кино'));
    assert.strictEqual(h.requests[h.requests.length - 1].cookies.cf_clearance, NEW, 'the next request sends it');
    assert.ok(page.items.some(function (i) { return /:topic:/.test(i.url); }), 'the forum loaded with it');
});

test('a refreshed Clearance that Cloudflare refuses on its retry is dropped too, and no second window opens', function () {
    /* The window hands over a pair the site refuses: the retry meets the
     * challenge with the pair it carried, so that pair goes. */
    const h = load({
        serverOptions: { cloudflare: true, clearance: 'accepted-clearance' },
        stores: heldStores(),
        popup: { web: { result: 'userclose', cookies: { cf_clearance: 'refused-clearance' }, ua: fake.BROWSER_UA } }
    });
    h.open('rutracker:search:0:matrix');
    assert.strictEqual(h.webpopups.length, 1, 'one window');
    assert.strictEqual(h.requests.filter(function (r) { return r.url.indexOf('/forum/tracker.php?') !== -1; }).length, 2, 'the retry ran once');
    assert.strictEqual(storedPair(h), '', 'the refused pair is not kept');
    h.open('rutracker:start');
    assert.ok(!h.requests[h.requests.length - 1].cookies.cf_clearance, 'the next request carries no cf_clearance');
});

test('a torrent download that meets a Challenge drops the held pair it carried', function () {
    const h = load({
        serverOptions: { cloudflare: true, clearance: 'refused-clearance' },
        stores: heldStores()
    });
    const page = h.open('rutracker:torrent:' + encodeURIComponent('https://rutracker.org/forum/dl.php?t=6924363'));
    assert.strictEqual(page.errors.length, 1, 'the download failed');
    assert.strictEqual(storedPair(h), '', 'the store holds no pair');
});

test('a late Challenge for a Clearance replaced by the same cookie with another User-Agent keeps the new pair', function () {
    /* A Clearance is its cookie together with its User-Agent (docs/adr/0003).
     * The same cookie value under another UA is another pair: the challenge
     * for the old one must not forget it, nor the browser's copy. */
    const UA_B = 'OtherUA/2';
    const site = fake.server({ cloudflare: true, clearance: 'refused-clearance' });
    let replaced = false;
    const h = load({
        server: function (req) {
            if (!replaced && req.url.indexOf('/forum/tracker.php?') !== -1 && req.cookies.cf_clearance === fake.CLEARANCE) {
                replaced = true;
                h.context.clearance.offer('https://rutracker.org/forum/', 'cf_clearance=' + fake.CLEARANCE, UA_B);
            }
            return site(req);
        },
        stores: heldStores()
    });
    h.search('matrix');
    assert.ok(replaced, 'the pair was replaced while the search waited');
    assert.strictEqual(storedPair(h), fake.CLEARANCE, 'the replaced pair is still held');
    assert.strictEqual(h.stores.rutracker_clearance.pair.ua, UA_B, 'with its own User-Agent');
    h.context.require('movian/http').request('https://rutracker.org/forum/index.php', { noFail: true });
    const last = h.requests[h.requests.length - 1];
    assert.strictEqual(last.cookies.cf_clearance, fake.CLEARANCE, 'the next request carries it');
    assert.strictEqual(last.headers['user-agent'], UA_B, 'with the User-Agent of the new pair');
});

/* ------------------------------------------------------------------ */
section('plugin: a Forget or Clear ends the Candidate Check in flight (#14)');

/* Runs `during` once, while the Session Check of the Candidate waits
 * (what Movian lets another page do during that request). */
function duringCheck(during, opts) {
    opts = opts || {};
    const site = fake.server(opts.serverOptions || { cloudflare: true });
    let ran = false;
    const h = load({
        server: function (req) {
            if (!ran && /viewforum\.php\?f=7$/.test(req.url) && req.cookies.bb_session === fake.VALID) {
                ran = true;
                during(h);
            }
            return site(req);
        },
        stores: opts.stores,
        popup: opts.popup
    });
    h.checkRan = function () { return ran; };
    return h;
}

function assertNothingSaved(h, what) {
    assert.ok(!h.stores.rutracker_session.session, what + ': no Session saved');
    assert.ok(!h.stores.rutracker_clearance.pair, what + ': no Clearance kept');
    const again = load({ stores: h.stores, server: fake.server({ cloudflare: true }) });
    assert.strictEqual(again.context.session.active(), false, what + ': no Session after a restart');
    assert.strictEqual(again.context.clearance.active(), false, what + ': no Clearance after a restart');
}

test('Cookie Bridge: a Forget while its Candidate Check is in flight leaves no Session and no Clearance', function () {
    const h = duringCheck(function (h) { h.open('rutracker:forget'); });
    pushSession(h);
    assert.ok(h.checkRan(), 'the Candidate was checked');
    assertNothingSaved(h, 'forget');
    assert.ok(h.notifications.some(function (n) { return /отмен/.test(n); }), 'a cancelled notice: ' + h.notifications.join(' | '));
    assert.ok(!h.notifications.some(function (n) { return /не прошла/.test(n); }), 'not reported as rejected');
});

test('Password Login: a Forget while its form POST is in flight cancels that login (#41)', function () {
    /* Codex on the mirror PR: submit() took the generation only after the
     * POST, so a Forget during the POST did not cancel its late answer. */
    const site = fake.server();
    let h;
    let ran = false;
    h = load({
        server: function (req) {
            if (!ran && /login\.php/.test(req.url) && req.method === 'POST') {
                ran = true;
                h.open('rutracker:forget');
            }
            return site(req);
        },
        popup: { credentials: [{ username: 'user', password: 'secret-password' }] }
    });
    const page = h.open('rutracker:login:' + encodeURIComponent(JSON.stringify({ showAuth: false })));
    assert.ok(ran, 'the Forget ran during the POST');
    assert.strictEqual(h.context.session.active(), false, 'no Active Session');
    assert.strictEqual(h.context.session.forgotten(), true, 'the Forget still holds');
    assert.deepStrictEqual(page.redirects, [], 'no return to :start');
});

test('Cookie Bridge: the "Clear" action while its Candidate Check is in flight leaves no Session and no Clearance', function () {
    const h = duringCheck(function (h) { h.item('rutracker_bridge', 'bridgeClear').action(); });
    pushSession(h);
    assert.ok(h.checkRan(), 'the Candidate was checked');
    assertNothingSaved(h, 'clear action');
});

test('Cookie Bridge: an empty-cookie transfer while its Candidate Check is in flight leaves no Session and no Clearance', function () {
    const h = duringCheck(function (h) { h.stppSet(BRIDGE + 'browserCookie.value', ''); });
    pushSession(h);
    assert.ok(h.checkRan(), 'the Candidate was checked');
    assertNothingSaved(h, 'empty transfer');
});

test('Cookie Bridge: a transfer that starts after a Forget is checked and saved, as the user it signs in as', function () {
    let forgotten = false;
    const h = duringCheck(function (h) { forgotten = true; h.open('rutracker:forget'); });
    pushSession(h);
    assert.ok(h.checkRan() && forgotten, 'the first Candidate was cancelled by the Forget');
    assert.ok(!h.stores.rutracker_session.session, 'nothing saved from the first transfer');
    pushSession(h, 'bb_session=' + fake.OTHER_VALID + '; bb_guid=g2; cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    assert.strictEqual(h.stores.rutracker_session.session.user, fake.OTHER_USER, 'the new account');
    assert.strictEqual(h.stores.rutracker_session.session.cookie.indexOf(fake.VALID), -1, 'not the forgotten session');
    assert.strictEqual(h.stores.rutracker_clearance.pair.value, fake.CLEARANCE, 'the new transfer\'s Clearance is kept');
    const page = titles(h.open('rutracker:start'));
    assert.ok(page.some(function (s) { return /OtherUser/.test(s); }), page.slice(0, 3).join(' | '));
});

test('Password Login: a Forget during its Session Check saves no Session, keeps no clearance pair, and does not ask again', function () {
    /* Without Cloudflare: as the Password Login tests above, the login
     * itself must get through to its Session Check. */
    const h = duringCheck(function (h) { h.open('rutracker:forget'); }, {
        serverOptions: {},
        popup: { credentials: [USER, USER] }
    });
    const page = h.open(LOGIN);
    assert.ok(h.checkRan(), 'the login was checked');
    assert.deepStrictEqual(page.redirects, [], 'no redirect to a signed-in start');
    assert.strictEqual(page.errors.length, 1, 'error shown');
    assert.ok(/отмен/.test(page.errors[0]), page.errors[0]);
    assert.strictEqual(h.popup.credentials.length, 1, 'the password is not asked for again');
    assertNothingSaved(h, 'password login');
});

/* ------------------------------------------------------------------ */
section('plugin: a newer sign-in ends the Candidate Check in flight, and :start reads the Clearance after its check (#35)');

test(':start: a Forget during its index request shows no "Забыть Cloudflare clearance" item', function () {
    const stores = storedSession();
    stores.rutracker_clearance = { pair: { host: 'rutracker.org', value: fake.CLEARANCE, ua: fake.BROWSER_UA } };
    const site = fake.server({ cloudflare: true });
    let forgotten = false;
    const h = load({ stores: stores, server: function (req) {
        if (!forgotten && /\/forum\/index\.php$/.test(req.url)) {
            forgotten = true;
            h.open('rutracker:forget');
            //  The index answered as a guest: the Session is gone with the Forget.
            return site(Object.assign({}, req, { cookies: {} }));
        }
        return site(req);
    } });
    const t = titles(h.open('rutracker:start'));
    assert.ok(forgotten, 'the index was requested');
    assert.ok(!t.some(function (s) { return /Забыть Cloudflare clearance/.test(s); }), brief(t));
});

test(':start: a Forget during its inline Session Check shows no "Забыть Cloudflare clearance" item', function () {
    const stores = storedSession();
    stores.rutracker_clearance = { pair: { host: 'rutracker.org', value: fake.CLEARANCE, ua: fake.BROWSER_UA } };
    const h = duringCheck(function (h) { h.open('rutracker:forget'); }, { stores: stores });
    const t = titles(h.open('rutracker:start'));
    assert.ok(h.checkRan(), 'the inline Session Check ran');
    assert.ok(!t.some(function (s) { return /Забыть Cloudflare clearance/.test(s); }), brief(t));
});

test('Password Login: a newer sign-in during its Session Check cancels it, and the error says so', function () {
    /* Without Cloudflare: as the Password Login tests above. The newer
     * sign-in is a Cookie Bridge Candidate, checked and saved by the
     * Session Coordinator while the login's check waits. */
    const h = duringCheck(function (h) {
        h.context.session.submit({ source: 'bridge', host: 'rutracker.org', ua: fake.BROWSER_UA,
            cookie: 'bb_session=' + fake.OTHER_VALID + '; bb_guid=g2; cf_clearance=' + fake.CLEARANCE });
    }, {
        serverOptions: {},
        popup: { credentials: [USER, USER] }
    });
    const page = h.open(LOGIN);
    assert.ok(h.checkRan(), 'the login was checked');
    assert.strictEqual(page.errors.length, 1, 'error shown');
    assert.ok(/начат другой вход/.test(page.errors[0]), page.errors[0]);
    assert.ok(/Пароль не запрашивается снова/.test(page.errors[0]), page.errors[0]);
    assert.strictEqual(h.popup.credentials.length, 1, 'the password is not asked for again');
    assert.strictEqual(h.stores.rutracker_session.session.user, fake.OTHER_USER, 'the newer Session is saved');
    assert.strictEqual(h.stores.rutracker_session.session.cookie.indexOf(fake.VALID), -1, 'the login\'s Session is not saved');
});

test('Password Login: a Cookie Bridge push with only cf_clearance during its Session Check does not cancel the login', function () {
    /* The clearance-only push is no sign-in: the login still ends signed in. */
    const h = duringCheck(function (h) {
        pushSession(h, 'cf_clearance=' + fake.CLEARANCE, fake.BROWSER_UA);
    }, {
        serverOptions: {},
        popup: { credentials: [USER] }
    });
    const page = h.open(LOGIN);
    assert.ok(h.checkRan(), 'the login was checked');
    assert.deepStrictEqual(page.errors, [], 'no error: ' + page.errors.join(' | '));
    assert.deepStrictEqual(page.redirects, ['rutracker:start'], 'the login ends signed in');
    assert.strictEqual(h.stores.rutracker_session.session.user, 'TestUser', 'the login\'s Session is saved');
    assert.ok(!h.notifications.some(function (n) { return /начат другой вход/.test(n); }), h.notifications.join(' | '));
});

finish();

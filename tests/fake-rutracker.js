/*
 * Fake rutracker.org for the plugin tests: serves the sanitized fixtures in
 * tests/fixtures/ and models the few server behaviours the plugin depends on
 * (session cookie, Cloudflare challenge, Password Login, torrent download).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const SESSION = 'bb_session';
const VALID = 'valid-session-token';
/* A second account: its session is valid and its pages show OTHER_USER. */
const OTHER_VALID = 'other-valid-session';
const OTHER_USER = 'OtherUser';
const CLEARANCE = 'valid-clearance';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) BrowserUA/1.0';
const TORRENT = Buffer.from('d8:announce35:http://bt.t-ru.org/ann?magnet4:infod4:name4:teste' + 'e');

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/* Cloudflare's "JavaScript detections" script, injected into every page a
 * browser navigates to (and into what Movian fetches). A normal page that
 * mentions challenge-platform is NOT a challenge. Copied from a real guest
 * index.php; in-page fetch() responses (the authenticated fixtures) lack it. */
const CF_JSD = '<script>(function(){function c(){var b=a.contentDocument;if(b){var d=b.createElement(\'script\');' +
    'd.innerHTML="window.__CF$cv$params={r:\'0\',t:\'0\'};var a=document.createElement(\'script\');' +
    'a.src=\'/cdn-cgi/challenge-platform/scripts/jsd/main.js\';document.getElementsByTagName(\'head\')[0].appendChild(a);";' +
    'b.getElementsByTagName(\'head\')[0].appendChild(d)}}c()})();</script>';

/* Pages captured logged in; `guest` turns the account link into the login
 * link a guest sees, so a rejected session gets a guest page everywhere. */
function html(name, guest, user) {
    let body = fixture(name);
    if (guest) body = body.replace(/<a id="logged-in-username"[^>]*>[^<]*<\/a>/, '<a href="login.php">Вход</a>');
    if (user) body = body.replace(/(<a id="logged-in-username"[^>]*>)TestUser(<\/a>)/, '$1' + user + '$2');
    if (body.indexOf('challenge-platform') === -1) body = body.replace('</body>', CF_JSD + '</body>');
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=windows-1251' }, body: body };
}

/* The live site's empty result: the results table stays, with a single
 * "Не найдено" row, and there is no pager. */
function emptySearch(page) {
    page.body = page.body
        .replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody><tr><td colspan="10" class="row1 tCenter pad_12">Не найдено</td></tr></tbody>')
        .replace(/Результатов поиска: \d+/, 'Результатов поиска: 0')
        .replace(/<div class="bottom_info">[\s\S]*?<!--\/bottom_info-->/, '<div class="bottom_info"></div><!--/bottom_info-->');
    return page;
}

/*
 * options:
 *   cloudflare: true  -> requests without the bridge cf_clearance + browser UA
 *                        get the real "Just a moment..." 403 challenge
 *                        (index.php excepted, as on the live site)
 *   cloudflare: 'pages' -> the same, but login.php passes too (how the live
 *                        site treats login.php has not been observed)
 *   clearance: 'value' -> the cf_clearance the challenge takes (default
 *                        CLEARANCE); read per request, so a test may change it
 *                        to make the site refuse the pair it held
 *   loginCookies: [...] -> the Set-Cookie headers of a successful login; by
 *                        default one bb_session (not yet compared with a
 *                        capture of the live login)
 *   down: true        -> every request fails at the network level
 *   captcha: true     -> login answers with the captcha form (the real page)
 *   captchaCode: 'x'  -> ... and again, with a new picture, SID and code
 *                        field, unless the last ones come with code 'x'
 *   loginPage: 'unrecognized' -> login answers 200 with a page that has
 *                        neither the error marker nor a redirect
 *   pagerFailure: 'down' | 'challenge' -> the pager links (search_id=…) fail
 *                        at the network level, or get the Cloudflare challenge
 *   emptyForum: true  -> viewforum.php answers with a real forum that has no
 *                        subforums and no topics (f=203, captured 2026-11-21:
 *                        "В этом форуме нет сообщений")
 */
function server(options) {
    options = options || {};
    const state = { logins: [] };
    /* The fixture's own challenge; every captcha answered again is a new one. */
    let cap = { round: 0, sid: 'SID123', field: 'cap_code_xyz' };
    let pagerChallengeServed = false;

    function handler(req) {
        if (options.down) return { error: 'Connection refused' };
        const u = new URL(req.url);
        /* rutracker.net is the official mirror: the same site. */
        if (u.hostname !== 'rutracker.org' && u.hostname !== 'rutracker.net') return { status: 404, body: 'not found' };
        if (u.searchParams.has('search_id')) {
            if (options.pagerFailure === 'down') return { error: 'Connection refused' };
            if (options.pagerFailure === 'challenge' ||
                    (options.pagerFailure === 'challenge-once' && !pagerChallengeServed)) {
                pagerChallengeServed = true;
                return { status: 403, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' }, body: fixture('cf-challenge.html') };
            }
        }
        /* Like the live site: Cloudflare challenges forum and tracker pages
         * without a valid cf_clearance + matching UA, but not index.php. */
        if (options.cloudflare && u.pathname !== '/forum/index.php' &&
                !(options.cloudflare === 'pages' && u.pathname === '/forum/login.php') &&
                !(req.cookies.cf_clearance === (options.clearance || CLEARANCE) && req.headers['user-agent'] === BROWSER_UA)) {
            return { status: 403, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' }, body: fixture('cf-challenge.html') };
        }
        const other = req.cookies[SESSION] === OTHER_VALID;
        const authed = req.cookies[SESSION] === VALID || other;
        switch (u.pathname) {
        case '/forum/index.php':
            return html(authed ? 'index.html' : 'index-guest.html', false, other ? OTHER_USER : undefined);
        case '/forum/viewforum.php':
            return html(options.emptyForum ? 'forum-203.html' : 'forum-7.html', !authed, other ? OTHER_USER : undefined);
        case '/forum/tracker.php': {
            /* Like the site: whole words, or a word start with "*". This one
             * only knows "matrix"; pager links (search_id) carry no query. */
            const nm = u.searchParams.get('nm');
            const known = nm === null || nm.toLowerCase().split(/[^a-z*]+/).some(function (w) {
                return w === 'matrix' || (w.length > 1 && w.slice(-1) === '*' && 'matrix'.indexOf(w.slice(0, -1)) === 0);
            });
            const page = html('search-matrix.html', !authed);
            return known ? page : emptySearch(page);
        }
        case '/forum/viewtopic.php':
            return html('topic-6924363.html', !authed);
        case '/forum/bookmarks.php':
            return html('bookmarks-empty.html', !authed);
        case '/forum/dl.php':
            if (!authed) return html('index-guest.html');
            return { status: 200, headers: { 'Content-Type': 'application/x-bittorrent' }, body: TORRENT };
        case '/forum/login.php': {
            const p = req.postdata || {};
            /* The site's logout answers 302 and expires bb_session, but the
             * Session it named stays valid on the server: live (E2E,
             * 2026-10-18) the old cookie was still signed in on the next
             * request. So nothing is revoked here, whatever form_token says. */
            if (p.logout) return { status: 302, headers: { Location: 'index.php' }, setCookies: [SESSION + '=deleted'] };
            state.logins.push({ username: p.login_username, hasPassword: !!p.login_password, cap: p.cap_sid });
            if (options.loginPage === 'unrecognized') return html('index-guest.html', true);
            if (options.captcha && (!p.cap_sid || (options.captchaCode && (p.cap_sid !== cap.sid || p[cap.field] !== options.captchaCode)))) {
                if (p.cap_sid) cap = { round: cap.round + 1, sid: 'SID123-' + (cap.round + 1), field: 'cap_code_xyz' + (cap.round + 1) };
                const page = html('login-captcha.html', true);
                if (cap.round) {
                    page.body = page.body.replace('captcha/abc.jpg', 'captcha/abc-' + cap.round + '.jpg')
                        .replace('value="SID123"', 'value="' + cap.sid + '"').replace('name="cap_code_xyz"', 'name="' + cap.field + '"');
                }
                return page;
            }
            if (p.login_username === 'user' && p.login_password === 'secret-password') {
                return { status: 302, headers: { Location: 'index.php' },
                    setCookies: options.loginCookies || [SESSION + '=' + VALID + '; path=/forum/'] };
            }
            return { status: 200, headers: { 'Content-Type': 'text/html; charset=windows-1251' },
                body: '<h4 class="warnColor1 tCenter mrg_16">Вы ввели неверное имя или пароль</h4>' };
        }
        default:
            return { status: 404, body: 'not found' };
        }
    }
    handler.state = state;
    return handler;
}

module.exports = {
    server: server,
    SESSION: SESSION,
    VALID: VALID,
    OTHER_VALID: OTHER_VALID,
    OTHER_USER: OTHER_USER,
    CLEARANCE: CLEARANCE,
    BROWSER_UA: BROWSER_UA,
    TORRENT: TORRENT,
    browserCookie: function () { return 'bb_guid=g1; ' + SESSION + '=' + VALID + '; bb_ssl=1; cf_clearance=' + CLEARANCE; }
};

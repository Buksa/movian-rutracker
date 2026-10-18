/*
 * Fake rutracker.org for the plugin tests: serves the sanitized fixtures in
 * tests/fixtures/ and models the few server behaviours the plugin depends on
 * (session cookie, Cloudflare challenge, legacy login, torrent download).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const SESSION = 'bb_session';
const VALID = 'valid-session-token';
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
function html(name, guest) {
    let body = fixture(name);
    if (guest) body = body.replace(/<a id="logged-in-username"[^>]*>[^<]*<\/a>/, '<a href="login.php">Вход</a>');
    if (body.indexOf('challenge-platform') === -1) body = body.replace('</body>', CF_JSD + '</body>');
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=windows-1251' }, body: body };
}

/*
 * options:
 *   cloudflare: true  -> requests without the bridge cf_clearance + browser UA
 *                        get the real "Just a moment..." 403 challenge
 *                        (index.php excepted, as on the live site)
 *   down: true        -> every request fails at the network level
 *   captcha: true     -> login answers with the captcha form
 */
function server(options) {
    options = options || {};
    const state = { logins: [] };

    function handler(req) {
        if (options.down) return { error: 'Connection refused' };
        const u = new URL(req.url);
        if (u.hostname !== 'rutracker.org') return { status: 404, body: 'not found' };
        /* Like the live site: Cloudflare challenges forum and tracker pages
         * without a valid cf_clearance + matching UA, but not index.php. */
        if (options.cloudflare && u.pathname !== '/forum/index.php' &&
                !(req.cookies.cf_clearance === CLEARANCE && req.headers['user-agent'] === BROWSER_UA)) {
            return { status: 403, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' }, body: fixture('cf-challenge.html') };
        }
        const authed = req.cookies[SESSION] === VALID;
        switch (u.pathname) {
        case '/forum/index.php':
            return html(authed ? 'index.html' : 'index-guest.html');
        case '/forum/viewforum.php':
            return html('forum-7.html', !authed);
        case '/forum/tracker.php':
            return html('search-matrix.html', !authed);
        case '/forum/viewtopic.php':
            return html('topic-6924363.html', !authed);
        case '/forum/bookmarks.php':
            return html('bookmarks-empty.html', !authed);
        case '/forum/dl.php':
            if (!authed) return html('index-guest.html');
            return { status: 200, headers: { 'Content-Type': 'application/x-bittorrent' }, body: TORRENT };
        case '/forum/login.php': {
            const p = req.postdata || {};
            if (p.logout) return { status: 302, headers: { Location: 'index.php' }, setCookies: [SESSION + '=deleted'] };
            state.logins.push({ username: p.login_username, hasPassword: !!p.login_password, cap: p.cap_sid });
            if (options.captcha && !p.cap_sid) {
                return { status: 200, headers: { 'Content-Type': 'text/html; charset=windows-1251' },
                    body: '<h4 class="warnColor1 tCenter mrg_16">Вы ввели неверный пароль</h4>' +
                        '<div><img src="https://static.t-ru.org/captcha/abc.jpg" alt="pic"></div>\n' +
                        '<input type="hidden" name="cap_sid" value="SID123">\n' +
                        '<input class="reg-input" type="text" name="cap_code_xyz" value="">' };
            }
            if (p.login_username === 'user' && p.login_password === 'secret-password') {
                return { status: 302, headers: { Location: 'index.php' }, setCookies: [SESSION + '=' + VALID + '; path=/forum/'] };
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
    CLEARANCE: CLEARANCE,
    BROWSER_UA: BROWSER_UA,
    TORRENT: TORRENT,
    browserCookie: function () { return 'bb_guid=g1; ' + SESSION + '=' + VALID + '; bb_ssl=1; cf_clearance=' + CLEARANCE; }
};

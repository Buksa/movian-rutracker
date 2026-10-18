#!/usr/bin/env node
/*
 * Orca-browser session push for the Movian Cookie Bridge.
 *
 * Why this exists
 * ---------------
 * The Chrome/Brave extension in ../extension reads cookies with
 * chrome.cookies. That only works in a real Chrome/Brave profile. Orca's
 * built-in browser is Chromium-based but has its *own* cookie store, which no
 * extension can see. On a machine without Chrome/Brave the extension simply
 * reports "No cookies for ...".
 *
 * This tool is the local fallback for exactly that case: it reads the Orca
 * browser cookie DB directly (read-only) and pushes the same two settings
 * over STPP that the extension pushes.
 *
 * Safety
 * ------
 * - Cookie values are NEVER printed. `--dry-run` shows metadata only.
 * - Only hosts matching the selected profile's allow-list domain are used.
 * - STPP is unauthenticated plaintext, so a non-loopback --stpp is refused,
 *   unless --allow-lan accepts that risk for a local-network address
 *   (never a public one).
 *
 * Usage
 * -----
 *   node m7-cookie-bridge/tools/orca-session-push.js --dry-run
 *   node m7-cookie-bridge/tools/orca-session-push.js
 *   node m7-cookie-bridge/tools/orca-session-push.js --profile hdrezka
 *   node m7-cookie-bridge/tools/orca-session-push.js --ua "Mozilla/5.0 ..."
 *
 * Log in on the site in the Orca browser first (the DB is read at push time).
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var BridgeCore = require('../extension/lib/bridge-core.js');

/* Chromium stores expires_utc as microseconds since 1601-01-01 UTC. */
var CHROME_EPOCH_OFFSET_SEC = 11644473600;

var DEFAULT_STPP = 'ws://127.0.0.1:42000/api/stpp';

/* Orca keeps browser cookies in a partition profile; the top-level file is
 * the app's own store. We probe both and use whichever holds the session. */
function candidateCookieDbs() {
    var config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return [
        path.join(config, 'orca', 'Partitions', 'orca-browser', 'Cookies'),
        path.join(config, 'orca', 'Cookies')
    ];
}

function parseArgs(argv) {
    var opts = {
        profile: 'rutracker',
        db: '',
        ua: '',
        stpp: DEFAULT_STPP,
        dryRun: false,
        allowLan: false,
        help: false,
        timeoutMs: 8000
    };
    for (var i = 0; i < argv.length; i++) {
        var a = argv[i];
        if (a === '--profile') opts.profile = argv[++i] || '';
        else if (a === '--db') opts.db = argv[++i] || '';
        else if (a === '--ua') opts.ua = argv[++i] || '';
        else if (a === '--stpp') opts.stpp = argv[++i] || '';
        else if (a === '--timeout') opts.timeoutMs = (parseInt(argv[++i], 10) || 8) * 1000;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--allow-lan') opts.allowLan = true;
        else if (a === '-h' || a === '--help') opts.help = true;
        else throw new Error('unknown argument: ' + a);
    }
    return opts;
}

function usage() {
    console.log([
        'usage: node m7-cookie-bridge/tools/orca-session-push.js [options]',
        '',
        '  --profile <id>   bridge profile: rutracker (default) | hdrezka',
        '  --db <path>      Orca cookie DB (default: auto-detect)',
        '  --ua <string>    User-Agent to send (default: ask the Orca browser)',
        '  --stpp <url>     STPP endpoint (default: ' + DEFAULT_STPP + ')',
        '  --timeout <sec>  connection timeout (default: 8)',
        '  --dry-run        read + report only, do not push',
        '  --allow-lan      allow a local-network --stpp host (unencrypted: accepted risk)',
        '  -h, --help       this text'
    ].join('\n'));
}

function hasNodeSqlite() {
    try {
        require('node:sqlite');
        return true;
    } catch (e) {
        return false;
    }
}

/* Load cookies for `domain` from one DB. Values stay inside this function's
 * return value; the caller only ever prints counts and names. */
function readCookiesFromDb(dbPath, domain) {
    var DatabaseSync = require('node:sqlite').DatabaseSync;
    /* Chromium's microsecond timestamps exceed Number.MAX_SAFE_INTEGER, so the
     * driver must hand them back as BigInt instead of throwing. */
    var db = new DatabaseSync(dbPath, { readOnly: true, readBigInts: true });
    try {
        /* Newer Chromium keeps partitioned (CHIPS) cookies in the same table,
         * marked by top_frame_site_key; older DBs lack the column. */
        var partitionCol = db.prepare('PRAGMA table_info(cookies)').all()
            .some(function (c) { return c.name === 'top_frame_site_key'; });
        var rows = db.prepare(
            'SELECT name, value, host_key, path, is_secure, is_httponly, ' +
            'has_expires, expires_utc, length(encrypted_value) AS enc_len' +
            (partitionCol ? ', top_frame_site_key' : '') + ' FROM cookies'
        ).all();

        var now = Math.floor(Date.now() / 1000);
        var matched = [];
        var partitioned = [];
        var encrypted = 0;

        rows.forEach(function (r) {
            var host = String(r.host_key || '').replace(/^\./, '');
            if (!BridgeCore.domainMatches(host, domain)) return;

            var name = String(r.name || '');
            if (!name) return;

            if (Number(r.has_expires) && Number(r.expires_utc)) {
                var expires = Math.floor(Number(r.expires_utc) / 1e6) - CHROME_EPOCH_OFFSET_SEC;
                if (expires > 0 && expires <= now) return; /* expired */
            }

            var value = String(r.value == null ? '' : r.value);
            if (!value) {
                if (Number(r.enc_len) > 0) encrypted++;
                return;
            }

            var cookie = { name: name, value: value, host: host, path: String(r.path || ''), secure: !!r.is_secure };
            (r.top_frame_site_key ? partitioned : matched).push(cookie);
        });

        /* One value per name, by the extension's rule: partitioned wins,
         * then the longest path. */
        return { cookies: BridgeCore.mergeCookieLists(matched, partitioned), encrypted: encrypted, total: rows.length };
    } finally {
        db.close();
    }
}

/* Try the explicit --db, else every candidate, and keep the best match. */
function collectCookies(opts, domain) {
    var paths = opts.db ? [opts.db] : candidateCookieDbs();
    var best = null;

    paths.forEach(function (p) {
        if (!fs.existsSync(p)) return;
        var res;
        try {
            res = readCookiesFromDb(p, domain);
        } catch (e) {
            if (opts.db) throw new Error('cannot read ' + p + ': ' + e.message);
            return;
        }
        if (!best || res.cookies.length > best.cookies.length) {
            best = { db: p, cookies: res.cookies, encrypted: res.encrypted, total: res.total };
        }
    });

    return best;
}

/* The User-Agent matters: Cloudflare's cf_clearance is bound to the UA that
 * earned it, so it must be the same browser that logged in. */
function detectOrcaUA(opts) {
    if (opts.ua) return { ua: opts.ua, source: 'argument' };

    var bin = process.env.ORCA_CLI_COMMAND || 'orca-ide';
    try {
        var out = childProcess.execFileSync(
            bin,
            ['eval', '--expression', 'navigator.userAgent', '--json'],
            { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        var parsed = JSON.parse(out);
        var ua = parsed && parsed.result && parsed.result.result;
        if (ua) return { ua: String(ua), source: 'orca browser' };
    } catch (e) {
        /* fall through */
    }
    return { ua: '', source: 'unavailable' };
}

function assertMovianHost(stppUrl, allowLan) {
    var host;
    try {
        host = new URL(stppUrl).hostname;
    } catch (e) {
        throw new Error('invalid --stpp URL: ' + stppUrl);
    }
    if (!BridgeCore.movianHostAllowed(host, allowLan)) {
        throw new Error(
            'refusing non-loopback STPP target (' + host + '): STPP has no ' +
            'authentication and the session would travel in cleartext' +
            (BridgeCore.isLanHost(host) ? ' (pass --allow-lan to accept that risk)' : '; public addresses are never allowed')
        );
    }
    if (!BridgeCore.isLoopbackHost(host)) {
        console.error('warning: sending the session to ' + host + ' over the LAN unencrypted (--allow-lan)');
    }
}

function sendStpp(url, messages, timeoutMs) {
    return new Promise(function (resolve, reject) {
        var ws = new WebSocket(url);
        var settled = false;

        function done(err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch (e) { /* ignore */ }
            if (err) reject(err); else resolve();
        }

        var timer = setTimeout(function () {
            done(new Error('timeout talking to ' + url));
        }, timeoutMs);

        ws.onopen = function () {
            ws.send(JSON.stringify([0, 1, 0])); /* HELLO */
            messages.forEach(function (m) { ws.send(JSON.stringify(m)); });
            setTimeout(function () { done(null); }, 400);
        };
        ws.onerror = function () {
            done(new Error('cannot connect to ' + url));
        };
    });
}

function main() {
    var opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        usage();
        process.exit(2);
        return;
    }

    if (opts.help) {
        usage();
        return;
    }

    if (!hasNodeSqlite()) {
        console.error('node:sqlite is unavailable — Node.js 22.5+ is required.');
        process.exit(2);
        return;
    }

    var profile = BridgeCore.profile(opts.profile);
    if (!opts.dryRun) assertMovianHost(opts.stpp, opts.allowLan);

    var found = collectCookies(opts, profile.defaultDomain);
    if (!found || !found.cookies.length) {
        console.error('No ' + profile.defaultDomain + ' cookies found' +
            (opts.db ? ' in ' + opts.db : ' in any Orca profile') +
            '. Log in at https://' + profile.defaultDomain + ' in the Orca browser first.');
        process.exit(1);
        return;
    }

    var header = BridgeCore.buildCookieHeader(found.cookies);
    var names = found.cookies.map(function (c) { return c.name; }).sort();
    var uaInfo = detectOrcaUA(opts);

    console.log('profile   : ' + profile.id + ' (' + profile.defaultDomain + ')');
    console.log('cookie db : ' + found.db);
    console.log('cookies   : ' + found.cookies.length + ' [' + names.join(', ') + ']');
    console.log('header    : ' + Buffer.byteLength(header) + ' bytes');
    if (found.encrypted) {
        console.log('encrypted : ' + found.encrypted + ' skipped (individually encrypted by Chromium)');
    }
    console.log('user-agent: ' + (uaInfo.ua
        ? Buffer.byteLength(uaInfo.ua) + ' bytes (from ' + uaInfo.source + ')'
        : 'NOT FOUND — pass --ua "<browser user-agent>"'));

    if (!uaInfo.ua) {
        console.error('Aborting: cf_clearance is bound to the login User-Agent; ' +
            'a mismatched UA gets a Cloudflare challenge.');
        process.exit(1);
        return;
    }

    if (opts.dryRun) {
        console.log('stpp      : ' + opts.stpp + ' (dry-run, nothing sent)');
        return;
    }

    var messages = BridgeCore.stppSetMessages(profile.id, header, uaInfo.ua);
    sendStpp(opts.stpp, messages, opts.timeoutMs).then(function () {
        console.log('stpp      : ' + opts.stpp + ' → sent');
        console.log('Now open ' + profile.movianRoute + ' in Movian to check the status.');
    }).catch(function (e) {
        console.error('stpp      : ' + e.message);
        process.exit(1);
    });
}

main();

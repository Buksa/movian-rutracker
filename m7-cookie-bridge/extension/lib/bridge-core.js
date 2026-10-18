/*
 * Movian Cookie Bridge - shared core.
 *
 * Free of browser and Movian APIs and written in ES5, so the same file runs
 * in the Chrome/Brave extension (popup + service worker, as a plain script
 * that defines self.BridgeCore), under Node.js (tools/, tests/) and inside
 * Movian's Duktape (CommonJS module.exports).
 *
 * This is the canonical copy. Movian plugins vendor it byte-for-byte in
 * vendor/movian-cookie-bridge/ next to movian-session.js; the tests fail when
 * the copies drift.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BridgeCore = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /*
     * Profiles are strictly isolated: each one has its own Movian settings
     * group and its own domains, so HDRezka and RuTracker cookies can never
     * cross over. A new site is one more entry here; the transport, the
     * popup and the Movian side (movian-session.js) need no changes.
     *
     *   settingsGroup  Movian settings group the session is written to. It
     *                  must not contain a dot: STPP prop paths are split on
     *                  '.' in Movian core (prop_setdn). RuTracker's group
     *                  'rutracker_bridge' dates from the plugin id
     *                  'RuTracker.org' and is kept for compatibility.
     *   domains        sites the profile may export cookies from; the Movian
     *                  side sends the cookies to exactly these (https only).
     *                  null = any domain the user names (HDRezka moves
     *                  between mirrors); the browser still asks the user to
     *                  grant access to that site.
     */
    function makeProfile(p) {
        p.cookiePath = 'settings.apps.nodes.' + p.settingsGroup + '.nodes.browserCookie.value';
        p.uaPath = 'settings.apps.nodes.' + p.settingsGroup + '.nodes.browserUA.value';
        return p;
    }

    var PROFILES = {
        hdrezka: makeProfile({
            id: 'hdrezka',
            title: 'HDRezka',
            defaultDomain: 'hdrezka.me',
            domains: null,
            settingsGroup: 'HDRezka',
            movianRoute: 'HDRezka:start'
        }),
        rutracker: makeProfile({
            id: 'rutracker',
            title: 'RuTracker',
            defaultDomain: 'rutracker.org',
            domains: ['rutracker.org', 'rutracker.net'],
            settingsGroup: 'rutracker_bridge',
            movianRoute: 'rutracker:start'
        })
    };

    var PROFILE_ORDER = Object.keys(PROFILES);

    function profile(id) {
        return PROFILES[id] || PROFILES.hdrezka;
    }

    function normalizeDomain(value, fallback) {
        var domain = String(value == null ? '' : value).trim();
        domain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        domain = domain.replace(/^www\./i, '');
        domain = domain.toLowerCase();
        return domain || (fallback || 'hdrezka.me');
    }

    function normalizeHost(value) {
        var host = String(value == null ? '' : value).trim();
        host = host.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
        var bracketed = /^\[(.+)\](?::\d+)?$/.exec(host);
        if (bracketed) {
            host = '[' + bracketed[1] + ']';
        } else if ((host.match(/:/g) || []).length === 1) {
            /* single colon = host:port; a bare IPv6 literal must keep its colons */
            host = host.replace(/:\d+$/, '');
        }
        return host || '127.0.0.1';
    }

    function normalizePort(value) {
        var port = String(value == null ? '' : value).trim().replace(/[^\d]/g, '');
        return port || '42000';
    }

    /*
     * STPP is plaintext ws:// with no authentication, and Movian listens on
     * every interface. Same-device (loopback) destinations are always fine;
     * another device is reached through an encrypted tunnel that ends on
     * loopback (ssh -L / adb forward). IPv4 only: Movian's HTTP server opens
     * an AF_INET socket (asyncio_tcp_bind_socket), so [::1] never reaches it.
     */
    function isLoopbackHost(value) {
        var host = normalizeHost(value).toLowerCase();
        return host === '127.0.0.1' || host === 'localhost';
    }

    /*
     * A device on the local network: private IPv4 (RFC 1918), link-local,
     * or a name that only resolves locally (no dot, .local, .lan,
     * .home.arpa, .internal). Public addresses never qualify.
     */
    function isLanHost(value) {
        var host = normalizeHost(value).toLowerCase();
        var ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
        if (ip) {
            var a = +ip[1], b = +ip[2];
            return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
                (a === 192 && b === 168) || (a === 169 && b === 254);
        }
        if (/^[\d.:\[\]]+$/.test(host)) return false;
        return /^[a-z0-9-]+$/.test(host) || /\.(local|lan|home\.arpa|internal)$/.test(host);
    }

    /*
     * Where a session may be sent: loopback always; a local-network device
     * only when the user explicitly accepted the risk (allowLan) - the
     * cookies then cross the network unencrypted and Movian accepts writes
     * from anyone. This is an opt-in to that risk, not a protection.
     */
    function movianHostAllowed(value, allowLan) {
        return isLoopbackHost(value) || (!!allowLan && isLanHost(value));
    }

    function hostFromUrl(url) {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch (e) {
            return '';
        }
    }

    function domainMatches(host, domain) {
        host = String(host || '').toLowerCase();
        domain = normalizeDomain(domain).toLowerCase();
        if (!host || !domain) return false;
        return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
    }

    /* May this profile export cookies of `domain`? */
    function domainAllowed(profileId, domain) {
        var list = profile(profileId).domains;
        if (!list) return true;
        domain = normalizeDomain(domain, '');
        for (var i = 0; i < list.length; i++) {
            if (list[i] === domain) return true;
        }
        return false;
    }

    /* Host-permission patterns for one site (chrome.permissions.request).
     * http as well: chrome.cookies only returns a cookie WITHOUT the Secure
     * flag when the extension may access the site's http:// origin, and
     * RuTracker's bb_guid/bb_ssl/bb_t are not Secure. Nothing is ever sent
     * over http; this is read access to the browser's own cookie jar. */
    function siteOrigins(domain) {
        domain = normalizeDomain(domain, '');
        return ['https://' + domain + '/*', 'https://*.' + domain + '/*',
            'http://' + domain + '/*', 'http://*.' + domain + '/*'];
    }

    /* Build a Cookie header from chrome.cookies objects. Values are only ever
     * used to build the header; callers must not display them. */
    function buildCookieHeader(cookies) {
        return (cookies || [])
            .filter(function (c) { return c && c.name; })
            .slice()
            .sort(function (a, b) {
                if (a.name < b.name) return -1;
                if (a.name > b.name) return 1;
                return 0;
            })
            .map(function (c) { return c.name + '=' + c.value; })
            .join('; ');
    }

    /*
     * Chrome keeps partitioned cookies (CHIPS) in a namespace separate from
     * unpartitioned ones, and the same name may legally exist in both.
     * chrome.cookies.getAll() returns only the unpartitioned set unless a
     * partitionKey is supplied, so callers have to ask twice and merge.
     *
     * Cloudflare marks cf_clearance as partitioned: dropping it makes every
     * later request look like an unknown client and Cloudflare answers with
     * a challenge, while the session cookie itself is perfectly valid.
     *
     * A Cookie header carries one value per name, so name clashes are
     * settled here: the partitioned entry wins (it is the more specific one
     * for this top-level site); within one namespace the longer path wins,
     * which is the cookie a browser lists first (RFC 6265, 5.4).
     */
    function mergeCookieLists(unpartitioned, partitioned) {
        var byName = {};
        var order = [];

        function beats(c, isPartitioned, prev) {
            if (prev.partitioned !== isPartitioned) return isPartitioned;
            return String(c.path || '').length > String(prev.cookie.path || '').length;
        }

        function keep(c, isPartitioned) {
            if (!c || !c.name) return;
            var prev = Object.prototype.hasOwnProperty.call(byName, c.name) ? byName[c.name] : null;
            if (!prev) order.push(c.name);
            else if (!beats(c, isPartitioned, prev)) return;
            byName[c.name] = { cookie: c, partitioned: isPartitioned };
        }

        (unpartitioned || []).forEach(function (c) { keep(c, false); });
        (partitioned || []).forEach(function (c) { keep(c, true); });

        return order.map(function (name) { return byName[name].cookie; });
    }

    /* Parse a Cookie header into {name, value} pairs, skipping malformed
     * parts. Values are for building requests only, never for display. */
    function parseCookieHeader(header) {
        var out = [];
        String(header || '').split(';').forEach(function (part) {
            var p = part.trim();
            if (!p) return;
            var eq = p.indexOf('=');
            if (eq <= 0) return;
            var name = p.slice(0, eq).trim();
            if (!name || /[\s;,]/.test(name)) return;
            out.push({ name: name, value: p.slice(eq + 1).trim() });
        });
        return out;
    }

    /* Cookie names only (never values), for status lines and logs. */
    function parseCookieNames(header) {
        return parseCookieHeader(header).map(function (c) { return c.name; });
    }

    /* STPP SET messages for a profile. [STPP_CMD_SET, propref, path, value] */
    function stppSetMessages(profileId, cookieHeader, ua) {
        var p = profile(profileId);
        return [
            [3, 0, p.cookiePath, String(cookieHeader || '')],
            [3, 0, p.uaPath, String(ua || '')]
        ];
    }

    /* Safe summary for the UI: counts and lengths only, never values. */
    function describeTransfer(profileId, cookies, ua) {
        var p = profile(profileId);
        return {
            profile: p.id,
            domain: p.defaultDomain,
            cookieCount: (cookies || []).length,
            uaLength: String(ua || '').length
        };
    }

    return {
        PROFILES: PROFILES,
        PROFILE_ORDER: PROFILE_ORDER,
        profile: profile,
        normalizeDomain: normalizeDomain,
        normalizeHost: normalizeHost,
        normalizePort: normalizePort,
        isLoopbackHost: isLoopbackHost,
        isLanHost: isLanHost,
        movianHostAllowed: movianHostAllowed,
        hostFromUrl: hostFromUrl,
        domainMatches: domainMatches,
        domainAllowed: domainAllowed,
        siteOrigins: siteOrigins,
        buildCookieHeader: buildCookieHeader,
        mergeCookieLists: mergeCookieLists,
        parseCookieHeader: parseCookieHeader,
        parseCookieNames: parseCookieNames,
        stppSetMessages: stppSetMessages,
        describeTransfer: describeTransfer
    };
}));

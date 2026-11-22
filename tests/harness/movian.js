/*
 * Node stand-in for the Movian M7 plugin runtime, for tests only.
 *
 * loadPlugin() executes the real plugin entry file in a vm context with the
 * Movian modules it needs replaced by small fakes, and returns a handle to
 * drive it: open routes, simulate STPP writes, inspect HTTP traffic and logs.
 *
 * Behaviour copied from M7 (file references are to the Movian M7 sources):
 *  - require(): relative ids resolve against the requiring module id, then
 *    <plugin dir>/<id>.js (es_modsearch in src/ecmascript/ecmascript.c).
 *  - HTTP inspectors: pattern gets a leading '^', a trailing '.*' is dropped,
 *    the longest pattern wins and only that ONE inspector runs
 *    (es_http_inspector_create / es_http_inspect in src/ecmascript/es_io.c).
 *  - Request-option headers are merged after inspector headers and win
 *    (http_header_merge in src/fileaccess/fa_http.c). An explicit Cookie
 *    header thereby replaces the whole Cookie header the core built from
 *    its cookie jar and the inspector's setCookie() calls.
 *  - noAuth: true skips the HTTP inspectors (FA_DISABLE_AUTH, http_req_do in
 *    src/fileaccess/fa_http.c); the cookie jar still applies.
 *  - Every response header, Set-Cookie included, reaches the plugin: the
 *    last value in headers/headers_lc, all of them in multiheaders(_lc)
 *    (res/ecmascript/modules/movian/http.js). Set-Cookie also lands in the
 *    jar whatever the request options.
 *  - movian/store is a Proxy with get/set/has only: `delete` never reaches
 *    the persisted keys (res/ecmascript/modules/movian/store.js).
 *  - settings callbacks fire once with the initial value, then on change only.
 *
 * Invariants checked on every request of every test (takeLeaks(), run by
 * tap.js after each test):
 *  - a bb_session or cf_clearance value that the plugin itself adds
 *    (inspector or explicit Cookie header, not the jar) goes over https
 *    only, and only to a host that set it or that first received it;
 *    rutracker.org and rutracker.net count as one host.
 *  - a request without noAuth that carries cf_clearance carries exactly the
 *    Clearance the plugin holds for that host (the plugin store's pair), with
 *    that Clearance's User-Agent; on a persistedCookies request, the Core
 *    record instead. A jar cf_clearance counts too (docs/adr/0003: the
 *    Clearance module holds the only copy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dom = require('./dom');

function resolveId(base, id) {
    if (id.indexOf('./') !== 0 && id.indexOf('../') !== 0) return id;
    const parts = base ? base.split('/').slice(0, -1) : [];
    id.split('/').forEach(function (seg) {
        if (seg === '.' || seg === '') return;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    });
    return parts.join('/');
}

function compileInspector(pattern) {
    let s = String(pattern);
    if (s[0] !== '^') s = '^' + s;
    const e = s.indexOf('.*');
    if (e !== -1 && e + 2 === s.length) s = s.slice(0, e);
    return { source: s, re: new RegExp(s), prio: s.length };
}

/* The Clearance module's rule (src/bridge/clearance.js: expired(), and
 * offer() on intake): any expires that is not undefined or null is a
 * timestamp, so 0 is in the past. Anything not finite is refused on intake,
 * so it counts as expired here too. */
function expiredAt(expires, now) {
    if (expires === undefined || expires === null) return false;
    return !(Number(expires) > now);
}

function parseCookieHeader(header) {
    const out = {};
    String(header || '').split(';').forEach(function (p) {
        const eq = p.indexOf('=');
        if (eq > 0) out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    });
    return out;
}

const SECRET = ['bb_session', 'cf_clearance'];
const leaks = [];

function siteOf(host) {
    return /(^|\.)rutracker\.(org|net)$/.test(host) ? 'rutracker' : host;
}

/* Session cookie values that left their host since the last call. */
function takeLeaks() {
    return leaks.splice(0, leaks.length);
}

function makeResponse(res) {
    const headers = Object.assign({}, res.headers || {});
    const headersLc = {};
    const multi = {};
    const multiLc = {};
    function add(k, v) {
        headers[k] = v;
        headersLc[k.toLowerCase()] = v;
        (multi[k] = multi[k] || []).push(v);
        (multiLc[k.toLowerCase()] = multiLc[k.toLowerCase()] || []).push(v);
    }
    Object.keys(res.headers || {}).forEach(function (k) { add(k, res.headers[k]); });
    (res.setCookies || []).forEach(function (c) { add('Set-Cookie', c); });
    const body = res.body == null ? '' : res.body;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    return {
        bytes: bytes,
        headers: headers,
        headers_lc: headersLc,
        multiheaders: multi,
        multiheaders_lc: multiLc,
        statuscode: res.status || 200,
        toString: function () { return bytes.toString('utf8'); },
        convertFromEncoding: function () { return bytes.toString('utf8'); }
    };
}

/* Movian's own action names (actionnames[], src/event.c). */
const ACTION_NAMES = ['Up', 'Down', 'Left', 'Right', 'Activate', 'Click', 'Enter', 'Submit', 'Ok', 'Cancel', 'Backspace', 'Delete', 'MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight', 'Forward', 'Back', 'FocusNext', 'FocusPrev', 'PageUp', 'PageDown', 'Top', 'Bottom', 'Increase', 'Decrease', 'Stop', 'PlayPause', 'Play', 'Pause', 'Eject', 'Record', 'PreviousTrack', 'NextTrack', 'SeekForward', 'SeekReverse', 'VolumeUp', 'VolumeDown', 'VolumeMuteToggle', 'Menu', 'ItemMenu', 'LogWindow', 'Select', 'MediaStats', 'Home', 'SysHome', 'Reset', 'Copy', 'Paste', 'ChangeView', 'FullscreenToggle', 'ZoomUIReset', 'ReloadUI', 'Restart', 'Quit', 'Standby', 'PowerOff', 'Reboot', 'Shuffle', 'Repeat', 'EnableScreenSaver', 'AudioTrack', 'SubtitleTrack', 'ReloadData', 'Playqueue', 'Sysinfo', 'RecordUI'];

function makePage() {
    return {
        metadata: {},
        model: {},
        items: [],
        redirects: [],
        errors: [],
        loading: false,
        type: '',
        entries: 0,
        more: undefined,
        appendItem: function (url, type, meta) { this.items.push({ url: url, type: type, meta: meta || {} }); },
        appendPassiveItem: function (type, data, meta) { this.items.push({ passive: true, type: type, meta: meta || {} }); },
        redirect: function (url) { this.redirects.push(url); },
        error: function (msg) { this.errors.push(msg); },
        haveMore: function (v) { this.more = v; },
        handlers: {},
        onEvent: function (type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    };
}

/* RichText objects keep their markup in .str; plain strings pass through. */
function text(v) {
    if (v == null) return '';
    return v.str !== undefined ? v.str : String(v);
}

function loadPlugin(opts) {
    opts = opts || {};
    const pluginDir = opts.pluginDir;
    const manifest = fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8');

    const h = {
        routes: [],
        searchers: [],
        services: [],
        itemhooks: [],
        inspectors: [],
        requests: [],
        logs: [],
        notifications: [],
        webpopups: [],
        authPrompts: [],
        coreStore: opts.coreStore || {},
        coreRecord: function () {
            const w = h.popup.web || {};
            if (w.core) return h.coreStore.cf_clearance || null;
            return w.persistedWebCookie && typeof w.persistedWebCookie === 'object' ? w.persistedWebCookie : null;
        },
        webcookieCalls: [],
        timers: [],
        now: 0,
        groups: {},
        settingsStore: opts.settings || {},
        stores: opts.stores || {},
        jar: opts.jar || {},
        cookieSites: {},
        popup: Object.assign({ credentials: [], text: [], message: true }, opts.popup || {}),
        server: opts.server || function () { return { status: 404, body: '' }; },
        storagePath: '/fake/storage/plugins/RuTracker.org'
    };

    function log(kind) {
        return function () {
            h.logs.push(kind + ': ' + Array.prototype.map.call(arguments, String).join(' '));
        };
    }

    /* ---- settings ----------------------------------------------------
     * Same shape as res/ecmascript/modules/movian/settings.js: globalSettings()
     * turns `this` into a group (proto = the create* functions) with its own
     * getvalue/setvalue. Called on the module object, a second call re-targets
     * the module: setvalue() is looked up when a value CHANGES, so earlier
     * items then persist into the newer group's file. `new` gives a fresh
     * group object instead. */
    function makeItem(group, type, id, title, initial, callback) {
        const item = { type: type, id: id, title: title, _value: initial, callback: callback };
        Object.defineProperty(item, 'value', {
            get: function () { return item._value; },
            set: function (v) {
                if (v === item._value) return;
                item._value = v;
                group.setvalue(id, v);
                if (callback) callback(v);
            }
        });
        h.groups[group.id].items[id] = item;
        return item;
    }
    const sp = {
        createInfo: function (id, icon, description) { h.groups[this.id].infos.push(description); },
        createDivider: function (title) { h.groups[this.id].infos.push('--' + title); },
        createBool: function (id, title, def, cb) {
            const v = this.getvalue(id, def);
            const it = makeItem(this, 'bool', id, title, v, cb);
            cb(v);
            return it;
        },
        createString: function (id, title, def, cb) {
            const v = this.getvalue(id, def);
            const it = makeItem(this, 'string', id, title, v, cb);
            cb(v);
            return it;
        },
        createInt: function (id, title, def, min, max, step, unit, cb) {
            const v = this.getvalue(id, def);
            const it = makeItem(this, 'int', id, title, v, cb);
            cb(v);
            return it;
        },
        createMultiOpt: function (id, title, options, cb) {
            let v = this.getvalue(id, null);
            if (v == null) options.forEach(function (o) { if (v == null && o[2]) v = String(o[0]); });
            if (v == null) v = String(options[0][0]);
            const it = makeItem(this, 'multiopt', id, title, v, cb);
            it.options = options;
            cb(v);
            return it;
        },
        createAction: function (id, title, cb) {
            const it = makeItem(this, 'action', id, title, null, null);
            it.action = cb;
            return it;
        }
    };
    const settingsModule = {
        globalSettings: function (id, title, icon, desc) {
            Object.setPrototypeOf(this, sp);
            this.id = id;
            h.groups[id] = { id: id, title: title, desc: desc, items: {}, infos: [] };
            const file = h.settingsStore[id] = h.settingsStore[id] || {};
            this.getvalue = function (k, def) { return k in file ? file[k] : def; };
            this.setvalue = function (k, v) { file[k] = v; };
        }
    };

    /* ---- store -------------------------------------------------------- */
    function createStore(name) {
        const keys = h.stores[name] = h.stores[name] || {};
        return new Proxy({ keys: keys }, {
            get: function (obj, k) { return obj.keys[k]; },
            set: function (obj, k, v) { obj.keys[k] = v; return true; },
            has: function (obj, k) { return k in obj.keys; }
        });
    }

    /* ---- http ----------------------------------------------------------- */
    function runInspector(url) {
        const sorted = h.inspectors.slice().sort(function (a, b) { return b.prio - a.prio; });
        for (let i = 0; i < sorted.length; i++) {
            if (sorted[i].re.test(url)) {
                const ctrl = {
                    url: url,
                    authFailed: false,
                    headers: {},
                    cookies: {},
                    setHeader: function (k, v) { this.headers[k.toLowerCase()] = String(v); },
                    setCookie: function (k, v) { this.cookies[k] = v; },
                    fail: function () { this.failed = true; },
                    proceed: function () {},
                    ignore: function () {}
                };
                sorted[i].fn(ctrl);
                return { inspector: sorted[i].source, headers: ctrl.headers, cookies: ctrl.cookies };
            }
        }
        return { inspector: null, headers: {}, cookies: {} };
    }

    function hostOf(url) {
        const m = /^https?:\/\/([^/:?#]+)/i.exec(url);
        return m ? m[1].toLowerCase() : '';
    }

    function allowSite(value, host) {
        (h.cookieSites[value] = h.cookieSites[value] || {})[siteOf(host)] = true;
    }

    function checkSecrets(url, host, cookies) {
        const jar = h.jar[host] || {};
        SECRET.forEach(function (name) {
            const v = cookies[name];
            if (!v || jar[name] === v) {
                if (v) allowSite(v, host);
                return;
            }
            const sites = h.cookieSites[v];
            if (!/^https:/i.test(url)) leaks.push(name + ' over plain http: ' + url);
            else if (!sites) allowSite(v, host);
            else if (!sites[siteOf(host)]) leaks.push(name + ' sent to ' + host + ', it belongs to ' + Object.keys(sites).join(', '));
        });
    }

    /* The Clearance the plugin holds for host: its store pair (exact host,
     * unexpired), or on a persistedCookies request the Core record. */
    function heldClearance(url, host, ctrl) {
        const now = Math.floor(Date.now() / 1000);
        if (ctrl.persistedCookies === true) {
            const rec = /^https:/.test(url) && (host === 'rutracker.org' || host === 'rutracker.net') && h.coreRecord();
            return rec && rec.value && !expiredAt(rec.expires, now) ? { value: rec.value, ua: rec.ua } : null;
        }
        const pair = h.stores.rutracker_clearance && h.stores.rutracker_clearance.pair;
        if (!pair || !pair.value || pair.host !== host || expiredAt(pair.expires, now)) return null;
        return { value: pair.value, ua: pair.ua };
    }

    /* Names and comparisons only: the values never reach the leak report. */
    function checkClearance(url, host, cookies, headers, ctrl) {
        const held = heldClearance(url, host, ctrl);
        if (!held) {
            leaks.push('cf_clearance sent to ' + host + ' with no Clearance held for it');
        }
        else if (cookies.cf_clearance !== held.value) {
            leaks.push('cf_clearance sent to ' + host + ' is not the held Clearance (' +
                (cookies.cf_clearance.length) + ' chars, held ' + held.value.length + ')');
        }
        else if (headers['user-agent'] !== held.ua) {
            leaks.push('cf_clearance sent to ' + host + ' with a User-Agent other than its Clearance\'s');
        }
    }

    function httpRequest(url, ctrl) {
        ctrl = ctrl || {};
        if (!/^https?:\/\//.test(url)) throw new Error('Invalid URL for HTTP request, begins with: ' + String(url).slice(0, 10));
        const insp = ctrl.noAuth ? { inspector: null, headers: {}, cookies: {} } : runInspector(url);
        const headers = Object.assign({}, insp.headers);
        Object.keys(ctrl.headers || {}).forEach(function (k) { headers[k.toLowerCase()] = String(ctrl.headers[k]); });
        const host = hostOf(url);
        const cookies = 'cookie' in headers ? parseCookieHeader(headers.cookie) :
            Object.assign({}, h.jar[host] || {}, insp.cookies);
        /* Core: the persisted clearance rides only on `persistedCookies: true`,
         * over https to an exact official host; its User-Agent is pinned. */
        const rec = ctrl.persistedCookies === true && /^https:/.test(url) && h.coreRecord();
        if (rec && rec.value && (host === 'rutracker.org' || host === 'rutracker.net') &&
            !expiredAt(rec.expires, Math.floor(Date.now() / 1000))) {
            cookies.cf_clearance = rec.value;
            if (rec.ua) headers['user-agent'] = rec.ua;
        }
        const req = {
            url: url,
            method: ctrl.method || (ctrl.postdata ? 'POST' : 'GET'),
            headers: headers,
            cookies: cookies,
            postdata: ctrl.postdata,
            opts: ctrl,
            inspector: insp.inspector
        };
        h.requests.push(req);
        checkSecrets(url, host, cookies);
        if (!ctrl.noAuth && cookies.cf_clearance) checkClearance(url, host, cookies, headers, ctrl);
        const res = h.server(req) || { status: 404, body: '' };
        if (res.error) throw new Error(res.error);
        (res.setCookies || []).forEach(function (c) {
            const kv = c.split(';')[0];
            const eq = kv.indexOf('=');
            (h.jar[host] = h.jar[host] || {})[kv.slice(0, eq)] = kv.slice(eq + 1);
            allowSite(kv.slice(eq + 1), host);
        });
        const status = res.status || 200;
        if (status >= 400 && !ctrl.noFail) throw new Error('HTTP error: ' + status);
        return makeResponse(res);
    }

    /* ---- module table --------------------------------------------------- */
    const pageModule = {
        Route: function (pattern, fn) { h.routes.push({ re: new RegExp('^' + pattern + '$'), pattern: pattern, fn: fn }); },
        Searcher: function (id, logo, fn) { h.searchers.push({ id: id, fn: fn }); }
    };
    const builtins = {
        'movian/service': function () {
            return { create: function (title, url, type, enabled) {
                h.services.push({ title: title, url: url, type: type, enabled: enabled });
                return { id: h.services.length };
            } };
        },
        'movian/store': function () { return { create: createStore }; },
        'movian/settings': function () { return settingsModule; },
        'movian/page': function () { return pageModule; },
        'movian/http': function () { return { request: httpRequest }; },
        'movian/html': function () { return dom; },
        'movian/prop': function () { return {}; },
        'movian/itemhook': function () { return { create: function (o) { h.itemhooks.push(o); } }; },
        'native/io': function () {
            return { httpInspectorCreate: function (pattern, fn) {
                const c = compileInspector(pattern);
                const ins = { source: c.source, re: c.re, prio: c.prio, fn: fn, raw: pattern };
                h.inspectors.push(ins);
                return { destroy: function () { h.inspectors.splice(h.inspectors.indexOf(ins), 1); } };
            } };
        },
        'native/popup': function () {
            const m = {
                /* popup.saved: the credentials Movian's keyring holds. Like
                 * Movian, showAuth false takes them without a dialog; any
                 * other call shows the dialog, answered by popup.credentials.
                 * h.authPrompts records each call: {showAuth, silent}. */
                getAuthCredentials: function (title, text, showAuth) {
                    const silent = showAuth === false && !!h.popup.saved;
                    h.authPrompts.push({ showAuth: showAuth, silent: silent });
                    if (silent) return h.popup.saved;
                    return h.popup.credentials.length ? h.popup.credentials.shift() : { rejected: true };
                },
                textDialog: function () { return h.popup.text.length ? h.popup.text.shift() : { rejected: true }; },
                message: function () { return h.popup.message; },
                notify: function (msg) { h.notifications.push(msg); }
            };
            /* popup.web: Movian Go's browser API (internal/ecmascript/es_misc.go):
             * {result, cookies: {name: value} or function (url), ua}. M7 has a
             * webpopup() but no webcookies(). */
            if (h.popup.web) {
                const web = h.popup.web;
                m.webpopup = function (url, title, trap, options) {
                    h.webpopups.push({ url: url, title: title, trap: trap, options: options });
                    return web.result === 'trapped' ? { result: 'trapped', trappedUrl: url, args: {} } : { result: web.result };
                };
                m.webcookies = function (url) {
                    h.webcookieCalls.push(url);
                    return typeof web.cookies === 'function' ? web.cookies(url) : Object.assign({}, web.cookies || {});
                };
                m.webuseragent = function () { return web.ua || ''; };
                /* web.supportsBrowserLogin: boolean, absent = function missing. The
                 * plugin no longer calls it (#22); a build that has it still gets
                 * the tests that say so. */
                if (typeof web.supportsBrowserLogin === 'boolean')
                    m.supportsBrowserLogin = function () { return web.supportsBrowserLogin; };
                /* web.core: a stateful Core cookie store (persist / get / delete),
                 * kept in h.coreStore so a second load({coreStore}) restarts on it. */
                if (web.core) {
                    m.persistWebCookie = function (url, name) {
                        h.persistWebCookieCalls = (h.persistWebCookieCalls || 0) + 1;
                        const jar = typeof web.cookies === 'function' ? web.cookies(url) : (web.cookies || {});
                        if (!jar[name] || !web.ua) return null;
                        h.coreStore[name] = { value: jar[name], ua: web.ua,
                            expires: Math.floor(Date.now() / 1000) + 30 * 86400, path: '/forum', origin: 'https://rutracker.org' };
                        return Object.assign({}, h.coreStore[name]);
                    };
                    m.getPersistedWebCookie = function (url, name) {
                        h.getPersistedWebCookieCalls = (h.getPersistedWebCookieCalls || 0) + 1;
                        return h.coreStore[name] ? Object.assign({}, h.coreStore[name]) : null;
                    };
                    m.deletePersistedWebCookie = function (url, name) {
                        h.deletePersistedCalls = (h.deletePersistedCalls || 0) + 1;
                        const had = !!h.coreStore[name];
                        delete h.coreStore[name];
                        return had;
                    };
                }
                else if (web.persistWebCookie !== undefined)
                    m.persistWebCookie = function (url, name) {
                        h.persistWebCookieCalls = (h.persistWebCookieCalls || 0) + 1;
                        if (web.persistWebCookie instanceof Error) throw web.persistWebCookie;
                        return typeof web.persistWebCookie === 'function' ?
                            web.persistWebCookie(url, name) : web.persistWebCookie;
                    };
                /* web.deletecookies: true records calls in h.deleteCookiesCalls
                 * ({url, names}); an Error is thrown; a function is called with
                 * (url, names) to change what webcookies() returns after it;
                 * absent = function missing. */
                if (web.deletecookies !== undefined) {
                    h.deleteCookiesCalls = [];
                    m.deletecookies = function (url, names) {
                        h.deleteCookiesCalls.push({ url: url, names: names });
                        if (web.deletecookies instanceof Error) throw web.deletecookies;
                        if (typeof web.deletecookies === 'function') return web.deletecookies(url, names);
                        return 1;
                    };
                }
                if (!web.core && web.persistedWebCookie !== undefined)
                    m.getPersistedWebCookie = function (url, name) {
                        h.getPersistedWebCookieCalls = (h.getPersistedWebCookieCalls || 0) + 1;
                        return typeof web.persistedWebCookie === 'function' ?
                            web.persistedWebCookie(url, name) : web.persistedWebCookie;
                    };
            }
            return m;
        },
        'url': function () { return { parse: function (u) { return new URL(u); } }; }
    };

    const sandbox = {
        Plugin: { manifest: manifest, path: pluginDir + '/', id: JSON.parse(manifest).id },
        Core: { storagePath: h.storagePath },
        Duktape: {
            enc: function (kind, buf) {
                if (kind !== 'base64') throw new Error('enc ' + kind);
                if (buf === undefined) return 'dW5kZWZpbmVk';
                return Buffer.from(buf).toString('base64');
            },
            dec: function (kind, s) { return Buffer.from(String(s), 'base64'); }
        },
        console: { log: log('log'), error: log('error'), info: log('info') },
        print: log('print'),
        setTimeout: function (fn, ms) { fn.due = h.now + (ms || 0); h.timers.push(fn); return h.timers.length; },
        clearTimeout: function () {},
        Buffer: undefined
    };
    sandbox.global = sandbox;
    const context = vm.createContext(sandbox);

    const cache = {};
    function makeRequire(baseId) {
        return function require(id) {
            const compat = id.indexOf('showtime/') === 0 ? 'movian/' + id.slice(9) : id;
            if (builtins[compat]) return cache[compat] || (cache[compat] = builtins[compat]());
            const full = resolveId(baseId, compat);
            if (cache[full]) return cache[full].exports;
            const file = path.join(pluginDir, full + '.js');
            if (!fs.existsSync(file)) throw new Error("Can't find module " + id);
            const module = { id: full, exports: {} };
            cache[full] = module;
            const src = fs.readFileSync(file, 'utf8');
            const fn = vm.runInContext('(function (require, exports, module) {' + src + '\n})', context, { filename: file });
            fn.call(module.exports, makeRequire(full), module.exports, module);
            return module.exports;
        };
    }
    sandbox.require = makeRequire('');

    /* entry: false gives a bare runtime for unit-testing single modules
     * through h.require(). */
    if (opts.entry !== false) {
        const entry = path.join(pluginDir, JSON.parse(manifest).file);
        vm.runInContext(fs.readFileSync(entry, 'utf8'), context, { filename: entry });
    }
    h.require = sandbox.require;

    /* ---- driver API ----------------------------------------------------- */
    h.context = context;
    /* flush() runs every pending timer whatever its delay; tick(ms) moves
     * the clock and runs only the timers due by then, earliest first.
     * Start-up timers (the Session Check of a stored Session) wait for
     * them; live they run before the first page, so call flush() right
     * after loading when the order matters. */
    h.flush = function () {
        let n = 0;
        while (h.timers.length && n++ < 100) h.timers.shift()();
    };
    h.tick = function (ms) {
        h.now += ms || 0;
        for (let n = 0; n < 100; n++) {
            let next = -1;
            h.timers.forEach(function (fn, i) { if (fn.due <= h.now && (next < 0 || fn.due < h.timers[next].due)) next = i; });
            if (next < 0) return;
            h.timers.splice(next, 1)[0]();
        }
    };
    h.open = function (url) {
        const page = makePage();
        for (let i = 0; i < h.routes.length; i++) {
            const m = h.routes[i].re.exec(url);
            if (m) {
                page.route = h.routes[i].pattern;
                h.routes[i].fn.apply(null, [page].concat(m.slice(1)));
                return page;
            }
        }
        throw new Error('no route for ' + url);
    };
    /* An action the page's view delivers to its eventSink (page.js onEvent). */
    /* A view's password field is page.metadata.password; once the event has
     * sent it or left the form, no metadata may keep it: an error page keeps
     * the metadata, and the navigator tree serves it. */
    h.fire = function (page, type) {
        const typed = page.metadata && page.metadata.password;
        const before = [h.requests.length, page.redirects.length, page.errors.length].join();
        (page.handlers[type] || []).forEach(function (fn) { fn(type); });
        const after = [h.requests.length, page.redirects.length, page.errors.length].join();
        if (typed && after !== before) {
            Object.keys(page.metadata).forEach(function (k) {
                if (page.metadata[k] === typed) leaks.push('the password stayed in page.metadata.' + k + ' after "' + type + '"');
            });
        }
        return page;
    };
    /* deliverEvent(sink, "name") as Movian sends it: a name that matches one of
     * its own actions, in any case, arrives as that action's name
     * (event_create_action_str, src/event.c; seen live on Movian Go). */
    h.deliver = function (page, name) {
        const own = ACTION_NAMES.filter(function (a) { return a.toLowerCase() === name.toLowerCase(); })[0];
        return h.fire(page, own || name);
    };
    h.more = function (page) { page.asyncPaginator(); return page; };
    h.search = function (query) {
        const page = makePage();
        h.searchers[0].fn(page, query);
        return page;
    };
    h.item = function (group, id) { return (h.groups[group] || { items: {} }).items[id]; };
    h.stppSet = function (propPath, value) {
        const m = /^settings\.apps\.nodes\.([^.]+)\.nodes\.([^.]+)\.value$/.exec(propPath);
        if (!m) throw new Error('unsupported STPP path ' + propPath);
        const it = h.item(m[1], m[2]);
        if (!it) throw new Error('no setting at ' + propPath);
        it.value = value;
    };
    h.text = text;
    return h;
}

module.exports = { loadPlugin: loadPlugin, text: text, compileInspector: compileInspector, takeLeaks: takeLeaks };

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
 *    (http_header_merge in src/fileaccess/fa_http.c).
 *  - movian/store is a Proxy with get/set/has only: `delete` never reaches
 *    the persisted keys (res/ecmascript/modules/movian/store.js).
 *  - settings callbacks fire once with the initial value, then on change only.
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

function parseCookieHeader(header) {
    const out = {};
    String(header || '').split(';').forEach(function (p) {
        const eq = p.indexOf('=');
        if (eq > 0) out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    });
    return out;
}

function makeResponse(res) {
    const headers = res.headers || {};
    const headersLc = {};
    Object.keys(headers).forEach(function (k) { headersLc[k.toLowerCase()] = headers[k]; });
    const body = res.body == null ? '' : res.body;
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    return {
        bytes: bytes,
        headers: headers,
        headers_lc: headersLc,
        statuscode: res.status || 200,
        toString: function () { return bytes.toString('utf8'); },
        convertFromEncoding: function () { return bytes.toString('utf8'); }
    };
}

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
        haveMore: function (v) { this.more = v; }
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
        timers: [],
        groups: {},
        settingsStore: opts.settings || {},
        stores: opts.stores || {},
        jar: {},
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
        const m = /^https?:\/\/([^\/:?#]+)/i.exec(url);
        return m ? m[1].toLowerCase() : '';
    }

    function httpRequest(url, ctrl) {
        ctrl = ctrl || {};
        if (!/^https?:\/\//.test(url)) throw new Error('Invalid URL for HTTP request, begins with: ' + String(url).slice(0, 10));
        const insp = runInspector(url);
        const headers = Object.assign({}, insp.headers);
        Object.keys(ctrl.headers || {}).forEach(function (k) { headers[k.toLowerCase()] = String(ctrl.headers[k]); });
        const host = hostOf(url);
        const cookies = Object.assign({}, h.jar[host] || {}, insp.cookies);
        if (headers.cookie) Object.assign(cookies, parseCookieHeader(headers.cookie));
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
        const res = h.server(req) || { status: 404, body: '' };
        if (res.error) throw new Error(res.error);
        (res.setCookies || []).forEach(function (c) {
            const kv = c.split(';')[0];
            const eq = kv.indexOf('=');
            (h.jar[host] = h.jar[host] || {})[kv.slice(0, eq)] = kv.slice(eq + 1);
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
            return { create: function (title, url, type, enabled, icon) {
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
            return { httpInspectorCreate: function (pattern, fn, async) {
                const c = compileInspector(pattern);
                const ins = { source: c.source, re: c.re, prio: c.prio, fn: fn, raw: pattern };
                h.inspectors.push(ins);
                return { destroy: function () { h.inspectors.splice(h.inspectors.indexOf(ins), 1); } };
            } };
        },
        'native/popup': function () {
            return {
                getAuthCredentials: function () { return h.popup.credentials.length ? h.popup.credentials.shift() : { rejected: true }; },
                textDialog: function () { return h.popup.text.length ? h.popup.text.shift() : { rejected: true }; },
                message: function () { return h.popup.message; },
                notify: function (msg) { h.notifications.push(msg); }
            };
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
        setTimeout: function (fn) { h.timers.push(fn); return h.timers.length; },
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
    h.flush = function () {
        let n = 0;
        while (h.timers.length && n++ < 100) h.timers.shift()();
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

module.exports = { loadPlugin: loadPlugin, text: text, compileInspector: compileInspector };

/*
 * Minimal stand-in for Movian's `movian/html` (gumbo) module, for tests only.
 *
 * It implements just what the plugin touches: parse() -> {root, document},
 * getElementByClassName() with gumbo's "every listed class must be present"
 * rule (src/ecmascript/es_gumbo.c), getElementById(), textContent and
 * attributes.getNamedItem(). The tree builder is tolerant rather than a full
 * HTML5 parser: unknown end tags are ignored, and an end tag closes every
 * element opened after its match.
 */
'use strict';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

function decode(text) {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x([0-9a-f]+);/gi, function (_m, h) { return String.fromCodePoint(parseInt(h, 16)); })
        .replace(/&#(\d+);/g, function (_m, d) { return String.fromCodePoint(parseInt(d, 10)); })
        .replace(/&amp;/g, '&');
}

function Element(name, attrs) {
    this.name = name;
    this.attrs = attrs;
    this.kids = [];
}

function parseAttrs(src) {
    const out = [];
    const re = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = re.exec(src))) {
        const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
        out.push({ name: m[1].toLowerCase(), value: decode(value) });
    }
    return out;
}

function build(html) {
    const root = new Element('#document', []);
    const stack = [root];
    const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
    let last = 0;
    let m;
    function top() { return stack[stack.length - 1]; }
    function text(t) { if (t) top().kids.push(decode(t)); }

    while ((m = tagRe.exec(html))) {
        text(html.slice(last, m.index));
        last = tagRe.lastIndex;
        if (m[1]) {
            const name = m[1].toLowerCase();
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name === name) { stack.length = i; break; }
            }
        } else if (m[2]) {
            const name = m[2].toLowerCase();
            const el = new Element(name, parseAttrs(m[3] || ''));
            top().kids.push(el);
            if (RAW.has(name)) {
                const end = html.toLowerCase().indexOf('</' + name, last);
                const stop = end === -1 ? html.length : end;
                if (name === 'title' || name === 'textarea') el.kids.push(decode(html.slice(last, stop)));
                const close = html.indexOf('>', stop);
                last = tagRe.lastIndex = close === -1 ? html.length : close + 1;
            } else if (!VOID.has(name) && !/\/\s*$/.test(m[3] || '')) {
                stack.push(el);
            }
        }
    }
    text(html.slice(last));
    return root;
}

function textOf(el) {
    let s = '';
    el.kids.forEach(function (k) { s += typeof k === 'string' ? k : textOf(k); });
    return s;
}

function walk(el, visit) {
    el.kids.forEach(function (k) {
        if (typeof k === 'string') return;
        visit(k);
        walk(k, visit);
    });
}

function Node(el) {
    this._el = el;
}

/* Movian's native textContent pushes one Duktape value per text node and
 * never grows the stack (es_gumbo_node_textContent in es_gumbo.c), so it
 * throws on elements with many text nodes. Same limit here. */
const TEXT_NODE_LIMIT = 60;
function textNodes(el) {
    let n = 0;
    el.kids.forEach(function (k) { n += typeof k === 'string' ? 1 : textNodes(k); });
    return n;
}

Object.defineProperties(Node.prototype, {
    nodeName: { get: function () { return this._el.name; } },
    textContent: {
        get: function () {
            if (textNodes(this._el) > TEXT_NODE_LIMIT) throw new Error('attempt to push beyond currently allocated stack');
            return textOf(this._el);
        }
    },
    children: {
        get: function () {
            return this._el.kids.filter(function (k) { return typeof k !== 'string'; })
                .map(function (k) { return new Node(k); });
        }
    },
    attributes: {
        get: function () {
            const a = this._el.attrs.map(function (x) { return { name: x.name, value: x.value }; });
            a.getNamedItem = function (n) {
                for (let i = 0; i < a.length; i++) if (a[i].name === n) return a[i];
                return null;
            };
            return a;
        }
    }
});

Node.prototype.getElementByClassName = function (cls) {
    const want = String(cls).split(' ').filter(Boolean);
    const out = [];
    walk(this._el, function (el) {
        const attr = el.attrs.find(function (a) { return a.name === 'class'; });
        if (!attr) return;
        const have = attr.value.split(' ');
        if (want.every(function (w) { return have.indexOf(w) !== -1; })) out.push(new Node(el));
    });
    return out;
};
Node.prototype.getElementsByClassName = Node.prototype.getElementByClassName;

Node.prototype.getElementById = function (id) {
    let found = null;
    walk(this._el, function (el) {
        if (found) return;
        if (el.attrs.some(function (a) { return a.name === 'id' && a.value === id; })) found = new Node(el);
    });
    return found;
};

Node.prototype.getElementByTagName = function (tag) {
    const out = [];
    tag = String(tag).toLowerCase();
    walk(this._el, function (el) { if (el.name === tag) out.push(new Node(el)); });
    return out;
};
Node.prototype.getElementsByTagName = Node.prototype.getElementByTagName;

exports.parse = function (html) {
    const doc = build(String(html == null ? '' : html));
    const htmlEl = doc.kids.find(function (k) { return typeof k !== 'string' && k.name === 'html'; }) || doc;
    return { document: new Node(doc), root: new Node(htmlEl) };
};

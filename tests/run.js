#!/usr/bin/env node
/*
 * Runs every automated check of the repository (no dependencies):
 *
 *     node tests/run.js
 *
 *   1. ES5.1 syntax of all code that runs inside Movian's Duktape
 *   2. tests/plugin.test.js           - no assertion message joins a title list
 *   2b. docs/agents/live-e2e.md       - every tool in tools/live/ is named there
 *   2c. CHANGELOG.md                  - released sections equal their release tags
 *   2d. tools/sync-public.sh          - no mirror marker, no #number in mirrored docs
 *   3. tests/modules.test.js          - the plugin's pure modules
 *   4. tests/session.test.js          - the Session Coordinator
 *   5. tests/plugin.test.js           - plugin behaviour under a Movian stand-in
 *   6. tests/live-kit.test.js         - the live-run helper kit
 *   7. m7-cookie-bridge/tests/run.js  - bridge core, extension, Orca tool
 *
 * The ES5 check parses with the acorn copy bundled in Node itself
 * (--expose-internals), so no package manager is needed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const spawnSync = require('child_process').spawnSync;

const ROOT = path.resolve(__dirname, '..');

/* Everything that M7 loads from the plugin ZIP. */
function duktapeSources() {
    const out = [JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8')).file];
    ['src', 'vendor'].forEach(function (dir) {
        (function walk(rel) {
            const abs = path.join(ROOT, rel);
            if (!fs.existsSync(abs)) return;
            fs.readdirSync(abs).forEach(function (name) {
                const r = path.join(rel, name);
                if (fs.statSync(path.join(ROOT, r)).isDirectory()) walk(r);
                else if (/\.js$/.test(name)) out.push(r);
            });
        })(dir);
    });
    return out;
}

function es5Check(files) {
    const script = [
        "const acorn = require('internal/deps/acorn/acorn/dist/acorn');",
        "const fs = require('fs');",
        'let bad = 0;',
        'for (const f of process.argv.slice(1)) {',
        "  try { acorn.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 5, sourceType: 'script' }); }",
        "  catch (e) { bad++; console.log('FAIL  ES5 ' + f + ': ' + e.message); }",
        '}',
        'process.exit(bad ? 1 : 0);'
    ].join('\n');
    const res = spawnSync(process.execPath, ['--expose-internals', '-e', script].concat(files),
        { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(res.stdout || '');
    if (res.status !== 0 && !res.stdout) process.stdout.write(res.stderr || '');
    return res.status === 0;
}

/* Issue #26: an assertion message is one short line, never the whole title list.
 * A line-based match: an assert.* line that calls .join( directly on a title
 * list. Receivers are matched by name: t, first, titles(...). A title list
 * under another name is not caught (shortcut: extend the names when one appears).
 * `titles(...).slice(0, 3).join(` has a .slice receiver, so it is not matched. */
function titleJoinCheck(rel) {
    console.log('=== assertion messages (' + rel + ')');
    const bad = [];
    fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').forEach(function (line, i) {
        if (/assert\./.test(line) && /\b(?:t|first|titles\([^)]*\))\.join\(/.test(line)) bad.push(i + 1);
    });
    bad.forEach(function (n) {
        console.log('FAIL  ' + rel + ':' + n + ': assertion message joins a title list (use brief(t))');
    });
    if (!bad.length) console.log('  ok  no title-list join in an assertion message');
    return bad.length === 0;
}

/* Every live tool is named in the live procedure, so nobody has to find one by
 * chance (retro 2026-11-21: tools/live/page.js was written because stpp.js page
 * was not documented). A tool is matched by its file name. */
const LIVE_DOC_EXEMPT = {
    'lib.sh': 'a helper sourced by the live scripts, not a tool'
};

function liveDocCheck() {
    console.log('\n=== live tools named in docs/agents/live-e2e.md');
    const doc = fs.readFileSync(path.join(ROOT, 'docs/agents/live-e2e.md'), 'utf8');
    const missing = fs.readdirSync(path.join(ROOT, 'tools/live')).filter(function (name) {
        return !LIVE_DOC_EXEMPT[name] && doc.indexOf(name) < 0;
    });
    missing.forEach(function (name) {
        console.log('FAIL  tools/live/' + name + ' is not named in docs/agents/live-e2e.md');
    });
    if (!missing.length) console.log('  ok  every tool in tools/live/ is named');
    return missing.length === 0;
}

/* A released CHANGELOG section equals its text at the release tag (retro of
 * PR #55: a released section was edited after its tag). The plugin part
 * "## Плагин" is tagged vX.Y.Z-m7-bridge, the extension part "## Расширение"
 * ext-vX.Y.Z. A section is from its "###" line to the next "###" or "##". */
const CHANGELOG = 'm7-cookie-bridge/CHANGELOG.md';

function gitOut(args) {
    const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return res.error || res.status !== 0 ? null : res.stdout;
}

function changelogSections(lines) {
    const out = {};
    let part = null;
    lines.forEach(function (line, i) {
        if (/^## /.test(line)) part = /^## Плагин/.test(line) ? 'plugin' : /^## Расширение/.test(line) ? 'ext' : null;
        const m = /^### (\d+\.\d+\.\d+)\b/.exec(line);
        if (!m || !part) return;
        const key = part + ' ' + m[1];
        const end = lines.findIndex(function (l, j) { return j > i && /^#{2,3} /.test(l); });
        out[key] = { start: i, lines: lines.slice(i, end < 0 ? lines.length : end) };
    });
    return out;
}

function changelogTagCheck() {
    console.log('\n=== released CHANGELOG sections equal their tags (' + CHANGELOG + ')');
    const tags = gitOut(['tag', '-l']);
    if (tags === null || !tags.trim()) {
        console.log('  skipped: git or the release tags are not available');
        return true;
    }
    const existing = tags.split('\n');
    const lines = fs.readFileSync(path.join(ROOT, CHANGELOG), 'utf8').split('\n');
    const sections = changelogSections(lines);
    let ok = true, checked = 0, unreleased = 0;
    Object.keys(sections).forEach(function (key) {
        const parts = key.split(' ');
        const tag = parts[0] === 'plugin' ? 'v' + parts[1] + '-m7-bridge' : 'ext-v' + parts[1];
        if (existing.indexOf(tag) < 0) { unreleased++; return; }
        const at = gitOut(['show', tag + ':' + CHANGELOG]);
        const tagged = at === null ? null : changelogSections(at.split('\n'))[key];
        if (!tagged) {
            console.log('FAIL  ' + CHANGELOG + ': section ' + parts[1] + ' is missing at tag ' + tag);
            ok = false;
            return;
        }
        checked++;
        const cur = sections[key].lines, want = tagged.lines;
        let i = 0;
        while (i < cur.length && i < want.length && cur[i] === want[i]) i++;
        if (i === cur.length && i === want.length) return;
        const line = i < cur.length ? cur[i] : '(section ends)';
        console.log('FAIL  ' + CHANGELOG + ':' + (sections[key].start + i + 1) + ': section ' + parts[1] +
            ' differs from tag ' + tag + ' at its line ' + (i + 1) + ': ' + line);
        ok = false;
    });
    // A released section deleted or renumbered would escape the loop above.
    existing.forEach(function (tag) {
        const m = /^v(\d+\.\d+\.\d+)-m7-bridge$/.exec(tag) || /^ext-v(\d+\.\d+\.\d+)$/.exec(tag);
        if (!m) return;
        const key = (tag[0] === 'v' ? 'plugin ' : 'ext ') + m[1];
        if (sections[key]) return;
        console.log('FAIL  ' + CHANGELOG + ': released section ' + m[1] + ' (tag ' + tag + ') is missing');
        ok = false;
    });
    if (ok) console.log('  ok  ' + checked + ' released section(s) equal their tags; ' + unreleased + ' unreleased skipped');
    return ok;
}

/* The mirror check reads CODE, DOCS and MARKERS from tools/sync-public.sh, the
 * single source, so the list is never copied here. A private issue/PR number
 * (#123) in a DOCS file fails: the public repository's numbers differ. */
function mirrorMarkersCheck() {
    console.log('\n=== mirrored files carry no private text (tools/sync-public.sh)');
    const scriptPath = path.join(ROOT, 'tools/sync-public.sh');
    if (!fs.existsSync(scriptPath)) {
        console.log('  skipped: tools/sync-public.sh is not in this tree (not mirrored)');
        return true;
    }
    const script = fs.readFileSync(scriptPath, 'utf8');
    const codeM = /^CODE="([^"]*)"/m.exec(script);
    const docsM = /^DOCS="([^"]*)"/m.exec(script);
    const markersM = /^MARKERS='([^']*)'/m.exec(script);
    if (!codeM || !docsM || !markersM) {
        console.log('FAIL  tools/sync-public.sh: CODE, DOCS or MARKERS is not a plain quoted assignment');
        return false;
    }
    const code = codeM[1].split(/\s+/).filter(Boolean);
    const docs = docsM[1].split(/\s+/).filter(Boolean);
    const markers = markersM[1].split('\n').filter(Boolean);
    const tracked = gitOut(['ls-files', '-z', '--', ...code, ...docs]);
    if (tracked === null) {
        console.log('  skipped: git is not available to list the tracked files');
        return true;
    }
    const files = tracked.split('\0').filter(Boolean);
    let ok = true, scanned = 0;
    files.forEach(function (rel) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) return;
        scanned++;
        const isDoc = docs.indexOf(rel) >= 0;
        fs.readFileSync(abs, 'utf8').split('\n').forEach(function (line, i) {
            markers.forEach(function (m) {
                if (line.indexOf(m) < 0) return;
                console.log('FAIL  ' + rel + ':' + (i + 1) + ': private marker "' + m + '"');
                ok = false;
            });
            if (!isDoc) return;
            // &#8595; is an HTML entity, not an issue number
            const ref = /#\d+/.exec(line.replace(/&#\d+;/g, ''));
            if (!ref) return;
            console.log('FAIL  ' + rel + ':' + (i + 1) + ': private issue/PR reference "' + ref[0] + '" in a mirrored doc');
            ok = false;
        });
    });
    if (ok) console.log('  ok  ' + scanned + ' tracked file(s) under CODE and DOCS: no marker, no #number in docs');
    return ok;
}

function suite(rel) {
    console.log('\n=== ' + rel);
    const res = spawnSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, stdio: 'inherit' });
    return res.status === 0;
}

const files = duktapeSources();
console.log('=== ES5 syntax (' + files.length + ' files run by Duktape)');
const results = [
    es5Check(files) && (console.log('  ok  ' + files.join(', ')), true),
    titleJoinCheck('tests/plugin.test.js'),
    liveDocCheck(),
    changelogTagCheck(),
    mirrorMarkersCheck(),
    suite('tests/modules.test.js'),
    suite('tests/session.test.js'),
    suite('tests/plugin.test.js'),
    suite('tests/live-kit.test.js'),
    suite('m7-cookie-bridge/tests/run.js')
];
const failed = results.filter(function (ok) { return !ok; }).length;
console.log('\n' + (failed ? failed + ' part(s) FAILED' : 'all parts passed'));
process.exit(failed ? 1 : 0);

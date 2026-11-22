#!/usr/bin/env node
/*
 * Runs every automated check of the repository (no dependencies):
 *
 *     node tests/run.js
 *
 *   1. ES5.1 syntax of all code that runs inside Movian's Duktape
 *   2. tests/plugin.test.js           - no assertion message joins a title list
 *   2b. docs/agents/live-e2e.md       - every tool in tools/live/ is named there
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
    suite('tests/modules.test.js'),
    suite('tests/session.test.js'),
    suite('tests/plugin.test.js'),
    suite('tests/live-kit.test.js'),
    suite('m7-cookie-bridge/tests/run.js')
];
const failed = results.filter(function (ok) { return !ok; }).length;
console.log('\n' + (failed ? failed + ' part(s) FAILED' : 'all parts passed'));
process.exit(failed ? 1 : 0);

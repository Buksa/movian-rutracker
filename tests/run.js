#!/usr/bin/env node
/*
 * Runs every automated check of the repository (no dependencies):
 *
 *     node tests/run.js
 *
 *   1. ES5.1 syntax of all code that runs inside Movian's Duktape
 *   2. tests/modules.test.js          - the plugin's pure modules
 *   3. tests/plugin.test.js           - plugin behaviour under a Movian stand-in
 *   4. m7-cookie-bridge/tests/run.js  - bridge core, extension, Orca tool
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

function suite(rel) {
    console.log('\n=== ' + rel);
    const res = spawnSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, stdio: 'inherit' });
    return res.status === 0;
}

const files = duktapeSources();
console.log('=== ES5 syntax (' + files.length + ' files run by Duktape)');
const results = [
    es5Check(files) && (console.log('  ok  ' + files.join(', ')), true),
    suite('tests/modules.test.js'),
    suite('tests/plugin.test.js'),
    suite('m7-cookie-bridge/tests/run.js')
];
const failed = results.filter(function (ok) { return !ok; }).length;
console.log('\n' + (failed ? failed + ' part(s) FAILED' : 'all parts passed'));
process.exit(failed ? 1 : 0);

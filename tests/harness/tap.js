/* Tiny test runner shared by the plugin suites (no dependencies). */
'use strict';

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ok  ' + name);
    } catch (err) {
        failures.push({ name: name, err: err });
        console.log('FAIL  ' + name + '\n      ' + (err && err.stack || err).toString().split('\n').slice(0, 3).join('\n      '));
    }
}

function section(title) {
    console.log('# ' + title);
}

function finish() {
    console.log('');
    console.log('passed: ' + passed + ', failed: ' + failures.length);
    failures.forEach(function (f) { console.log('- ' + f.name + ': ' + (f.err && f.err.message)); });
    if (failures.length) process.exitCode = 1;
}

module.exports = { test: test, section: section, finish: finish };

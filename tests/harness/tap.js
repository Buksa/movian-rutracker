/* Tiny test runner shared by the plugin suites (no dependencies). */
'use strict';

let passed = 0;
const failures = [];

function record(name, err) {
    if (!err) {
        passed++;
        console.log('  ok  ' + name);
        return;
    }
    failures.push({ name: name, err: err });
    console.log('FAIL  ' + name + '\n      ' + (err && err.stack || err).toString().split('\n').slice(0, 3).join('\n      '));
}

function test(name, fn) {
    require('./movian').takeLeaks(); // a failed test must not hand its leaks on
    try {
        fn();
        const leaks = require('./movian').takeLeaks();
        if (leaks.length) throw new Error('Secret leaked: ' + leaks.join('; '));
        record(name);
    } catch (err) {
        record(name, err);
    }
}

/* For tests that wait on a child process or a socket: await it, then finish(). */
async function testAsync(name, fn) {
    require('./movian').takeLeaks(); // the same leak check as test()
    try {
        await fn();
        const leaks = require('./movian').takeLeaks();
        if (leaks.length) throw new Error('Secret leaked: ' + leaks.join('; '));
        record(name);
    } catch (err) {
        record(name, err);
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

module.exports = { test: test, testAsync: testAsync, section: section, finish: finish };

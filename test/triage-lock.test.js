'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  triageLockPath, checkTriageLock, acquireTriageLock, touchTriageLock, releaseTriageLock,
} = require('../lib/triage-lock');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-triage-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh lock makes a second pass skip', t => {
  const ws = workspace(t), now = Date.now();
  assert.equal(acquireTriageLock(ws, { lane: 'pass-a', nowMs: now }).state, 'acquired');
  assert.equal(acquireTriageLock(ws, { lane: 'pass-b', nowMs: now + 60_000 }).state, 'held');
  assert.equal(JSON.parse(fs.readFileSync(triageLockPath(ws), 'utf8')).lane, 'pass-a');
});

test('stale lock is taken over', t => {
  const ws = workspace(t), now = Date.now();
  acquireTriageLock(ws, { lane: 'old', nowMs: now - 16 * 60_000 });
  assert.equal(acquireTriageLock(ws, { lane: 'new', nowMs: now }).state, 'taken-over');
  assert.equal(JSON.parse(fs.readFileSync(triageLockPath(ws), 'utf8')).lane, 'new');
});

test('corrupt lock content still expires by mtime', t => {
  const ws = workspace(t), now = Date.now(), file = triageLockPath(ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  const old = new Date(now - 16 * 60_000);
  fs.utimesSync(file, old, old);
  assert.equal(checkTriageLock(ws, { nowMs: now }).state, 'stale');
  assert.equal(acquireTriageLock(ws, { lane: 'new', nowMs: now }).state, 'taken-over');
});

test('touch extends the lease and release frees it', t => {
  const ws = workspace(t), now = Date.now();
  acquireTriageLock(ws, { lane: 'pass-a', nowMs: now - 14 * 60_000 });
  touchTriageLock(ws, { nowMs: now });
  assert.equal(checkTriageLock(ws, { nowMs: now + 14 * 60_000 }).state, 'held');
  releaseTriageLock(ws);
  assert.equal(checkTriageLock(ws, { nowMs: now }).state, 'free');
  assert.doesNotThrow(() => releaseTriageLock(ws));
});

test('two-pass race has exactly one winner', t => {
  const ws = workspace(t), now = Date.now();
  const states = [
    acquireTriageLock(ws, { lane: 'pass-a', nowMs: now }).state,
    acquireTriageLock(ws, { lane: 'pass-b', nowMs: now }).state,
  ];
  assert.deepEqual(states, ['acquired', 'held']);
});

test('CLI acquire exits loudly for a competing pass and release clears it', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });
  const cli = path.join(__dirname, '..', 'bin', 'tl.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, TL_ROOT: root }, encoding: 'utf8',
  });
  const first = run('triage-lock', 'acquire', 'demo', '--lane', 'pass-a');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /acquired by pass-a/);
  const second = run('triage-lock', 'acquire', 'demo', '--lane', 'pass-b');
  assert.equal(second.status, 1);
  assert.match(second.stderr, /triage already running \(age \d+m\)/);
  assert.equal(run('triage-lock', 'release', 'demo').status, 0);
  assert.equal(run('triage-lock', 'check', 'demo').stdout.trim(), 'triage lock free');
});

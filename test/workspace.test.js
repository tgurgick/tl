'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safePath } = require('../lib/workspace');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-safe-path-'));
const base = path.join(root, 'ws');
fs.mkdirSync(path.join(base, 'threads'), { recursive: true });

test('safePath: allows paths inside the base', () => {
  assert.equal(safePath(base, 'threads/x.md'), path.resolve(base, 'threads/x.md'));
  assert.equal(safePath(base, 'SPEC.md'), path.resolve(base, 'SPEC.md'));
});

test('safePath: the base itself resolves to the base', () => {
  assert.equal(safePath(base, ''), path.resolve(base));
  assert.equal(safePath(base, '.'), path.resolve(base));
});

test('safePath: rejects ../ traversal out of the base', () => {
  assert.equal(safePath(base, '../etc/passwd'), null);
  assert.equal(safePath(base, 'a/../../b'), null);
  assert.equal(safePath(base, '../../../../../../etc/passwd'), null);
});

test('safePath: a sibling prefix is not treated as inside', () => {
  // /tmp/ws-evil must not count as inside /tmp/ws
  assert.equal(safePath(base, '../ws-evil/x'), null);
});

test('safePath: rejects a symlinked file outside the base', () => {
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(base, 'linked.md'));
  assert.equal(safePath(base, 'linked.md'), null);
});

test('safePath: rejects reads and future writes below an escaping symlinked directory', () => {
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'existing.md'), 'secret');
  fs.symlinkSync(outside, path.join(base, 'linked-dir'));
  assert.equal(safePath(base, 'linked-dir/existing.md'), null);
  assert.equal(safePath(base, 'linked-dir/future/new.md'), null);
});

test('safePath: permits a symlink whose real target stays inside the base', () => {
  fs.mkdirSync(path.join(base, 'real-dir'));
  fs.symlinkSync(path.join(base, 'real-dir'), path.join(base, 'internal-link'));
  assert.equal(safePath(base, 'internal-link/future.md'), path.join(base, 'internal-link/future.md'));
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { safePath } = require('../lib/workspace');

const base = '/tmp/ws';

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

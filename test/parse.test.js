'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseYaml, parseFrontmatter } = require('../lib/parse');

test('parseYaml: nested goals with weights and key_results', () => {
  const y = `goals:
  - id: alpha
    description: "first"
    weight: 0.6
    key_results:
      - "ship it"
      - "measure it"
  - id: beta
    weight: 0.4
allocation:
  bugs: 0.5
  features: 0.5`;
  const o = parseYaml(y);
  assert.equal(o.goals.length, 2);
  assert.equal(o.goals[0].id, 'alpha');
  assert.equal(o.goals[0].weight, 0.6);
  assert.deepEqual(o.goals[0].key_results, ['ship it', 'measure it']);
  assert.equal(o.allocation.bugs, 0.5);
});

test('parseYaml: comments are stripped, quoted # survives', () => {
  const o = parseYaml(`title: "a # b"   # trailing comment\nweight: 1  # note`);
  assert.equal(o.title, 'a # b');
  assert.equal(o.weight, 1);
});

test('parseFrontmatter: block-list depends_on parses as an array', () => {
  const t = `---
title: "x"
depends_on:
  - "specs/foo/"
  - "specs/bar/"
tags: [a, b]
---

body`;
  const { meta, body } = parseFrontmatter(t);
  assert.deepEqual(meta.depends_on, ['specs/foo/', 'specs/bar/']);
  assert.deepEqual(meta.tags, ['a', 'b']);          // inline array still works
  assert.equal(body.trim(), 'body');
});

test('parseFrontmatter: inline-array depends_on parses the same way', () => {
  const { meta } = parseFrontmatter(`---\ndepends_on: ["specs/foo/"]\n---\n`);
  assert.deepEqual(meta.depends_on, ['specs/foo/']);
});

test('parseFrontmatter: indent-0 lists keep following provenance fields', () => {
  const { meta } = parseFrontmatter(`---
title: x
depends_on:
- specs/foo/
- specs/bar/
tags:
- parser
- provenance
claimed_by: cursor
awaiting_verifier: true
status: tests
---
body`);
  assert.deepEqual(meta.depends_on, ['specs/foo/', 'specs/bar/']);
  assert.deepEqual(meta.tags, ['parser', 'provenance']);
  assert.equal(meta.claimed_by, 'cursor');
  assert.equal(meta.awaiting_verifier, true);
  assert.equal(meta.status, 'tests');
});

test('parseYaml: nested indentless sequence returns to its containing map', () => {
  const o = parseYaml(`verification:
  allow_self_check_for:
  - research
  - tech_debt
  require_independent_verifier: true
enabled: false`);
  assert.deepEqual(o.verification.allow_self_check_for, ['research', 'tech_debt']);
  assert.equal(o.verification.require_independent_verifier, true);
  assert.equal(o.enabled, false);
});

test('parseFrontmatter: malformed block degrades to empty meta, never throws', () => {
  const { meta, body } = parseFrontmatter('no frontmatter here');
  assert.deepEqual(meta, {});
  assert.equal(body, 'no frontmatter here');
});

// Canonical operating-path terminology — docs teach one story; obsolete wording stays out.
'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('canonical-e2e-path.md teaches tl up + manifest recovery, not artifact-smell completion', () => {
  const doc = read('docs/canonical-e2e-path.md');
  assert.match(doc, /steer → tl up → builder/);
  assert.match(doc, /manifest-backed tests/);
  assert.match(doc, /Artifacts alone are insufficient/i);
  assert.match(doc, /open.*alias/i);
  assert.match(doc, /Experiment fixture proof/);
  assert.doesNotMatch(doc, /Draft for review/);
  assert.doesNotMatch(doc, /Incomplete handoff smell/);
});

test('README and headless-lanes teach tl up as happy path; open is alias-only', () => {
  const readme = read('README.md');
  assert.match(readme, /### \/tl up/);
  assert.match(readme, /open.*alias/i);
  assert.doesNotMatch(readme, /### \/tl open\b/);

  const lanes = read('docs/headless-lanes.md');
  assert.match(lanes, /## The happy path: `tl up`/);
  assert.match(lanes, /tl open` is an alias/);
  assert.doesNotMatch(lanes, /## The happy path: `tl open`/);
});

test('SCHEMA automation profile names tl up; recovery requires manifest + expired lease', () => {
  const schema = read('_templates/SCHEMA.md');
  assert.match(schema, /makes `tl up <workspace>` the one-command operating path/);
  assert.match(schema, /tl open` is an alias only/);
  assert.match(schema, /artifacts alone are insufficient/i);
  assert.match(schema, /reuse_only/);
});

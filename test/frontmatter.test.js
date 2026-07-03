'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fmValue, setFrontmatterField } = require('../lib/frontmatter');
const { parseFrontmatter } = require('../lib/parse');

test('fmValue: newlines and quotes are neutralized to one safe line', () => {
  const v = fmValue('hello "world"\nsecond line');
  assert.ok(!/\n/.test(v));
  assert.ok(!/"/.test(v));
  assert.equal(v, "hello 'world' second line");
});

test('setFrontmatterField: replaces an existing field, leaves body alone', () => {
  const t = `---\ntitle: "x"\nstatus: "ready"\n---\n\nbody mentions status: fake\n`;
  const out = setFrontmatterField(t, 'status', 'done');
  const { meta, body } = parseFrontmatter(out);
  assert.equal(meta.status, 'done');
  assert.match(body, /body mentions status: fake/);   // body untouched
});

test('setFrontmatterField: inserts when the field is absent', () => {
  const t = `---\ntitle: "x"\n---\nbody`;
  const { meta } = parseFrontmatter(setFrontmatterField(t, 'priority', 'p1'));
  assert.equal(meta.priority, 'p1');
});

test('setFrontmatterField: no frontmatter block → returned unchanged', () => {
  assert.equal(setFrontmatterField('just text', 'status', 'done'), 'just text');
});

test('unsafe user input cannot corrupt or inject a record', () => {
  // a hostile capture: newline + a forged closing fence + a forged field
  const nasty = 'legit title"\n---\nstatus: "hacked';
  const record = `---\ntitle: "${fmValue(nasty)}"\nstatus: "ready"\ntype: "idea"\n---\n\n# heading\n`;
  const { meta } = parseFrontmatter(record);
  assert.equal(meta.status, 'ready');                 // NOT "hacked"
  assert.equal(meta.type, 'idea');
  assert.ok(String(meta.title).includes('legit title')); // preserved, defanged
});

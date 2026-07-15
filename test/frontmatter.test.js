'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fmValue, setFrontmatterField, stampSpecFields, PROTECTED_FIELDS } = require('../lib/frontmatter');
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

// ---- release contract: status → ready strips hold_reason --------------------
// SCHEMA.md: hold_reason is "cleared on release to specs/". The cockpit
// release endpoint only calls setSpecStatus(dest, 'ready'), which routes here —
// so the strip must live in this helper or the released spec keeps a stale hold.

test('setFrontmatterField: status → ready clears hold_reason, body decoy survives', () => {
  const t = `---\ntitle: "x"\nstatus: "triage"\nhold_reason: "undeclared Files to touch"\npriority: "p2"\n---\n\nbody mentions hold_reason: "decoy"\n`;
  const out = setFrontmatterField(t, 'status', 'ready');
  const { meta, body } = parseFrontmatter(out);
  assert.equal(meta.status, 'ready');
  assert.equal(meta.hold_reason, undefined);          // hold cleared on release
  assert.equal(meta.priority, 'p2');                  // neighbors untouched
  assert.match(body, /body mentions hold_reason: "decoy"/); // body untouched
});

test('setFrontmatterField: hold_reason as the last frontmatter line still strips cleanly', () => {
  const t = `---\ntitle: "x"\nstatus: "triage"\nhold_reason: "waiting on research: foo"\n---\nbody`;
  const out = setFrontmatterField(t, 'status', 'ready');
  const { meta } = parseFrontmatter(out);
  assert.equal(meta.status, 'ready');
  assert.equal(meta.hold_reason, undefined);
  assert.ok(!/^\s*$/m.test(out.split('\n---')[0]), 'no blank line left inside the block');
});

test('setFrontmatterField: non-ready statuses keep hold_reason', () => {
  const t = `---\ntitle: "x"\nstatus: "triage"\nhold_reason: "flagged for review"\n---\nbody`;
  for (const st of ['triage', 'blocked', 'in-progress', 'done']) {
    const { meta } = parseFrontmatter(setFrontmatterField(t, 'status', st));
    assert.equal(meta.hold_reason, 'flagged for review', `hold_reason must survive status → ${st}`);
  }
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

// ---- stampSpecFields: the stale-snapshot clobber guard ----------------------
// Regression for the 2026-07-14 incidents: a triage/groom pass inventoried the
// board, a builder claimed a spec (specs/ → in-progress/) mid-pass, and the
// pass then wrote whole frontmatter blocks back from its stale snapshot —
// resetting the claimed spec to specs/ + status: ready.

const READY_SPEC = [
  '---',
  'title: "A spec about to be claimed"',
  'created: 2026-07-14',
  'project: "demo"',
  'type: "feature"',
  'status: "ready"',
  'priority: "p2"',
  'priority_set_by: "triage"',
  'depends_on: []',
  'tags: [one, two]',
  '---',
  '',
  '## Objective',
  '',
  'Body text that must survive untouched.',
  '',
].join('\n');

function makeBoard() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-stamp-'));
  fs.mkdirSync(path.join(ws, 'specs', 'demo-spec'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'in-progress'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'specs', 'demo-spec', 'SPEC.md'), READY_SPEC);
  return ws;
}

test('clobber regression: inventory → concurrent claim → pass write is skipped, claim survives', () => {
  const ws = makeBoard();
  // 1. Inventory: the pass snapshots the spec while it sits in specs/.
  const inventoriedDir = path.join(ws, 'specs', 'demo-spec');
  assert.ok(fs.existsSync(path.join(inventoriedDir, 'SPEC.md')));

  // 2. Concurrent claim: a builder moves it to in-progress/ and stamps the claim.
  const claimedDir = path.join(ws, 'in-progress', 'demo-spec');
  fs.renameSync(inventoriedDir, claimedDir);
  const f = path.join(claimedDir, 'SPEC.md');
  let t = fs.readFileSync(f, 'utf8');
  t = setFrontmatterField(t, 'status', 'in-progress');
  t = setFrontmatterField(t, 'claimed_by', 'claude');
  t = setFrontmatterField(t, 'claimed_at', '2026-07-14');
  fs.writeFileSync(f, t);

  // 3. The pass writes its computed priority at the inventoried (stale) path.
  const res = stampSpecFields(inventoriedDir, { priority: 'p1', priority_set_by: 'triage' });

  // 4. The write is skipped and reported; nothing is resurrected at the old path.
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'moved');
  assert.ok(!fs.existsSync(inventoriedDir), 'stale specs/ path must not be recreated');

  // 5. The claim survives, byte-for-byte: status, claim stamps, priority all intact.
  const { meta } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
  assert.equal(meta.status, 'in-progress');
  assert.equal(meta.claimed_by, 'claude');
  assert.equal(meta.claimed_at, '2026-07-14');
  assert.equal(meta.priority, 'p2'); // the stale pass's p1 never landed
});

test('stampSpecFields: unmoved spec gets targeted priority edits, nothing else changes', () => {
  const ws = makeBoard();
  const dir = path.join(ws, 'specs', 'demo-spec');
  const before = fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8');

  const res = stampSpecFields(dir, { priority: 'p1', priority_set_by: 'triage' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.written, ['priority', 'priority_set_by']);

  const after = fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8');
  const { meta, body } = parseFrontmatter(after);
  assert.equal(meta.priority, 'p1');
  // No re-serialization: only the priority line differs; quoting, field order,
  // untouched fields, and the body are byte-identical.
  assert.equal(after.replace('priority: "p1"', 'priority: "p2"'), before);
  assert.match(body, /Body text that must survive untouched\./);
  assert.equal(meta.status, 'ready');
  assert.equal(meta.tags && String(meta.tags), String(['one', 'two'])); // list fields survive
});

test('stampSpecFields: refuses lifecycle/claim fields outright', () => {
  const ws = makeBoard();
  const dir = path.join(ws, 'specs', 'demo-spec');
  const before = fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8');

  for (const k of PROTECTED_FIELDS) {
    const res = stampSpecFields(dir, { [k]: 'x', priority: 'p0' });
    assert.equal(res.ok, false, `${k} must be refused`);
    assert.equal(res.reason, 'protected-fields');
    assert.deepEqual(res.fields, [k]);
  }
  // Refusal is total: not even the allowed field in the same batch landed.
  assert.equal(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'), before);
});

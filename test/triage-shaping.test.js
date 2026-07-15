'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, '_templates/SCHEMA.md'), 'utf8');
const TRIAGE_SKILL = fs.readFileSync(path.join(ROOT, 'skills/triage/SKILL.md'), 'utf8');
const RUN_SKILL = fs.readFileSync(path.join(ROOT, 'skills/run/SKILL.md'), 'utf8');
const TL_JS = fs.readFileSync(path.join(ROOT, 'bin/tl.js'), 'utf8');
const UI_HTML = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8');

test('SCHEMA: triage/ is the shaping hold pen with hold_reason contract', () => {
  assert.match(SCHEMA, /Spec held for shaping — blocked on a human action/);
  assert.match(SCHEMA, /hold_reason.*optional.*short literal/i);
  assert.match(SCHEMA, /threads\/.*idea under evaluation/i);
  assert.match(SCHEMA, /clearing `hold_reason`/);
  assert.doesNotMatch(SCHEMA, /Ranked spec held for human release/);
});

test('triage skill: sole writer routes unauthorized specs with hold_reason', () => {
  assert.match(TRIAGE_SKILL, /Route unauthorized specs to `triage\/`/);
  assert.match(TRIAGE_SKILL, /flag for review/);
  assert.match(TRIAGE_SKILL, /undeclared Files to touch/);
  assert.match(TRIAGE_SKILL, /waiting on research/);
  assert.match(TRIAGE_SKILL, /repoHoldReason/);
  assert.match(TRIAGE_SKILL, /remove `hold_reason`/);
  assert.match(TRIAGE_SKILL, /Held for shaping/);
  assert.match(TRIAGE_SKILL, /never adds an extra approval gate/);
});

test('run skill guardrail: triage/ is the hold pen, run never authorizes', () => {
  assert.ok(RUN_SKILL.includes('belongs in `triage/`, not `ready/`'));
  assert.match(RUN_SKILL, /never authorizes work/);
});
test('bin/tl.js resume: shaping hold pen wording', () => {
  assert.match(TL_JS, /held for shaping in triage\//);
  assert.match(TL_JS, /shaping hold pen/);
  assert.doesNotMatch(TL_JS, /release gate; nothing runs until a human moves it to ready/);
});

test('release transition: the setSpecStatus seam clears hold_reason on status → ready', () => {
  // The cockpit release endpoint (ui/server.js hRelease) renames
  // triage/<slug>/ → specs/<slug>/ then calls setSpecStatus(dest, 'ready'),
  // which routes through lib/frontmatter.js setFrontmatterField. Exercise the
  // full on-disk transition through that exact seam.
  const { setFrontmatterField } = require('../lib/frontmatter');
  const { parseFrontmatter } = require('../lib/parse');
  const os = require('os');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-release-'));
  const src = path.join(ws, 'triage', 'held-spec');
  const dest = path.join(ws, 'specs', 'held-spec');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(ws, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(src, 'SPEC.md'),
    `---\ntitle: "held"\nstatus: "triage"\nhold_reason: "undeclared Files to touch"\n---\nbody\n`);

  // the release move, exactly as hRelease performs it
  fs.renameSync(src, dest);
  const f = path.join(dest, 'SPEC.md');
  fs.writeFileSync(f, setFrontmatterField(fs.readFileSync(f, 'utf8'), 'status', 'ready'));

  const { meta } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
  assert.equal(meta.status, 'ready');
  assert.equal(meta.hold_reason, undefined, 'release must clear hold_reason on the move back');
});

test('cockpit: shaping lane label and hold_reason chip rendering', () => {
  assert.match(UI_HTML, /\['triage', 'SHAPING'/);
  assert.match(UI_HTML, /function holdReasonChip/);
  assert.match(UI_HTML, /needs shaping/);
  assert.match(UI_HTML, /lc-hold/);
  assert.match(UI_HTML, /shaped → ready/);
  assert.doesNotMatch(UI_HTML, /\['triage', 'TRIAGE'/);
});

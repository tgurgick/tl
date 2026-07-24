'use strict';
// test/benchmark-log.test.js — the benchmark-log.jsonl writer core.
//
// Contract under test (_templates/SCHEMA.md ### `benchmark-log.jsonl`, and
// threads/2026-07-12-benchmark-log-writer-and-spec-hash-capture.md):
// - spec_hash = SHA-256 hex first 12 of the SPEC.md BODY (frontmatter
//   excluded), stamped at CLAIM time; in-flight body edits and lifecycle
//   frontmatter mutations never change the stamped identity.
// - Records carry exactly the schema's fields; unknown values are null, never
//   fake zeros; malformed FEEDBACK degrades to nulls, never corrupts the file.
// - Append is append-only and idempotent (repeat acceptance = one line).

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BENCHMARK_FIELDS, SCORE_KEYS,
  specBodyHash, claimSpecHash, isSpecHash, stampClaimSpecHash, intentGoalIds,
  buildBenchmarkRecord, validateBenchmarkRecord,
  benchmarkLogPath, readBenchmarkRecords, appendBenchmarkRecord,
} = require('../lib/benchmark-log');
const { parseFrontmatter } = require('../lib/parse');
const { setFrontmatterField } = require('../lib/frontmatter');

const ROOT = path.join(__dirname, '..');

// ---------- fixtures ----------

const SPEC_BODY = `
# Sync JIRA both ways

## Objective

Two-way sync.

## Acceptance criteria

- [ ] imports issues
`;

const SPEC = `---
title: Sync JIRA both ways
type: feature
status: "ready"
intent: intents/enterprise-offering.md
priority: "p2"
---
${SPEC_BODY}`;

const FEEDBACK_FULL = `---
spec: "in-review/jira-sync-skill/SPEC.md"
completed: 2026-07-10
agent_model: "claude-fable-5"
agent_tool: "claude-code"
duration_minutes: 18
cost_usd: 0.84
tokens_used: 52000
scores:
  correctness: 5                # 1-5 — did it work?
  completeness: 5
  scope_discipline: 4
priority_was_right: true
---

# Feedback
`;

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tl-benchlog-'));
}

// ---------- hashing: claim-time semantics ----------

test('claimSpecHash is 12 lowercase hex chars and a prefix of the full experiment-record hash', () => {
  const short = claimSpecHash(SPEC);
  assert.ok(isSpecHash(short), `not a spec hash: ${short}`);
  // join with experiment records: tlSpecToTask stores sha256(body) full hex —
  // the benchmark value must be its first-12 prefix over the SAME body
  const full = crypto.createHash('sha256').update(parseFrontmatter(SPEC).body).digest('hex');
  assert.strictEqual(specBodyHash(SPEC), full);
  assert.strictEqual(short, full.slice(0, 12));
});

test('frontmatter mutations (status, claimed_*) never change the hash — body-only', () => {
  let mutated = setFrontmatterField(SPEC, 'status', 'in-progress');
  mutated = setFrontmatterField(mutated, 'claimed_by', 'claude');
  mutated = setFrontmatterField(mutated, 'claimed_at', '2026-07-18');
  assert.notStrictEqual(mutated, SPEC);
  assert.strictEqual(claimSpecHash(mutated), claimSpecHash(SPEC));
});

test('stamp at claim survives in-flight body edits — stamped value stays the claim-time hash', () => {
  // claim: stamp spec_hash in the same pass as claimed_by/claimed_at
  const claimed = stampClaimSpecHash(setFrontmatterField(SPEC, 'status', 'in-progress'));
  assert.strictEqual(claimed.stamped, true);
  assert.strictEqual(claimed.spec_hash, claimSpecHash(SPEC));

  // in flight: a "## Blocked" note is a legitimate body edit
  const edited = claimed.text + '\n## Blocked\n\nwaiting on upstream fix\n';
  const stampInEdited = parseFrontmatter(edited).meta.spec_hash;
  assert.strictEqual(stampInEdited, claimed.spec_hash, 'stamp must survive body edits');
  // ...while a review-time recompute would diverge — which is exactly why the
  // writer copies the stamp and never recomputes
  assert.notStrictEqual(claimSpecHash(edited), claimed.spec_hash);
});

test('stamping is idempotent; restamp recomputes; no frontmatter block means no stamp', () => {
  const first = stampClaimSpecHash(SPEC);
  const again = stampClaimSpecHash(first.text);
  assert.strictEqual(again.stamped, false, 'existing valid stamp must be preserved');
  assert.strictEqual(again.spec_hash, first.spec_hash);
  assert.strictEqual(again.text, first.text);

  // kickback → ready → fresh claim of a changed body: restamp recomputes
  const changed = first.text + '\nmore acceptance detail\n';
  const restamped = stampClaimSpecHash(changed, { restamp: true });
  assert.strictEqual(restamped.stamped, true);
  assert.strictEqual(restamped.spec_hash, claimSpecHash(changed));
  assert.notStrictEqual(restamped.spec_hash, first.spec_hash);

  const bare = stampClaimSpecHash('# no frontmatter here\n');
  assert.strictEqual(bare.stamped, false);
  assert.strictEqual(bare.text, '# no frontmatter here\n');
  assert.ok(isSpecHash(bare.spec_hash), 'computed hash still reported');
});

// ---------- record assembly: shape and field parity ----------

test('assembled record carries exactly the schema fields, in schema order', () => {
  const stamped = stampClaimSpecHash(SPEC);
  const record = buildBenchmarkRecord({
    specText: stamped.text,
    specSlug: 'jira-sync-skill',
    project: 'throughline',
    feedbackText: FEEDBACK_FULL,
    goalIds: ['cross-agent-reach'],
    date: '2026-07-10',
  });
  assert.deepStrictEqual(Object.keys(record), [...BENCHMARK_FIELDS]);
  assert.deepStrictEqual(record, {
    date: '2026-07-10',
    spec_slug: 'jira-sync-skill',
    spec_hash: stamped.spec_hash,
    spec_type: 'feature',
    project: 'throughline',
    intent: 'intents/enterprise-offering.md',
    goal_ids: ['cross-agent-reach'],
    agent_model: 'claude-fable-5',
    agent_tool: 'claude-code',
    duration_minutes: 18,
    cost_usd: 0.84,
    tokens_used: 52000,
    scores: { correctness: 5, completeness: 5, scope_discipline: 4 },
    priority_was_right: true,
    auto_reviewed: false,
  });
  assert.deepStrictEqual(validateBenchmarkRecord(record), { ok: true, errors: [] });
});

test('field parity with the SCHEMA.md worked example (done/benchmark-analytics-schema)', () => {
  const schema = fs.readFileSync(path.join(ROOT, '_templates', 'SCHEMA.md'), 'utf8');
  const block = schema.match(/```jsonl\n([\s\S]*?)```/);
  assert.ok(block, 'SCHEMA.md benchmark-log worked example (```jsonl block) not found');
  const lines = block[1].split('\n').filter(l => l.trim());
  assert.ok(lines.length >= 2, 'worked example should have two lines');
  for (const line of lines) {
    const example = JSON.parse(line);
    assert.deepStrictEqual(
      Object.keys(example).sort(),
      [...BENCHMARK_FIELDS].sort(),
      'writer fields must match the shipped worked example exactly',
    );
    assert.deepStrictEqual(validateBenchmarkRecord(example), { ok: true, errors: [] },
      'shipped worked-example lines must validate against the writer');
  }
});

test('auto_reviewed reflects the spec stamp; intentGoalIds reads intent goals', () => {
  const fastTracked = setFrontmatterField(stampClaimSpecHash(SPEC).text, 'auto_reviewed', true);
  assert.strictEqual(buildBenchmarkRecord({ specText: fastTracked, specSlug: 's', project: 'p' }).auto_reviewed, true);
  assert.strictEqual(buildBenchmarkRecord({ specText: SPEC, specSlug: 's', project: 'p' }).auto_reviewed, false);

  assert.deepStrictEqual(intentGoalIds('---\ntitle: x\ngoals: [cross-agent-reach, adoption]\n---\nbody'),
    ['cross-agent-reach', 'adoption']);
  assert.deepStrictEqual(intentGoalIds('---\ntitle: x\n---\nbody'), []);
  assert.deepStrictEqual(intentGoalIds(null), []);
});

// ---------- null semantics: honest unknowns, never fake values ----------

test('missing/placeholder optional fields degrade to null — never zero, never guessed', () => {
  // the real shape older FEEDBACK files have: empty cost fields, 0 score placeholders
  const sparse = `---
spec: "tests/benchmark-analytics-schema"
completed: 2026-07-12
agent_model: "claude-fable-5"
agent_tool: "claude-code"
duration_minutes: 9
cost_usd:
tokens_used:
scores:
  correctness: 0                # 1-5 — did it work?
  completeness: 0
  scope_discipline: 0
priority_was_right: true
---
# Feedback
`;
  const r = buildBenchmarkRecord({ specText: SPEC, specSlug: 's', project: 'p', feedbackText: sparse });
  assert.strictEqual(r.cost_usd, null);
  assert.strictEqual(r.tokens_used, null);
  assert.strictEqual(r.duration_minutes, 9);
  // 0 is the template's "unscored" placeholder — null, never a real 0 score
  assert.deepStrictEqual(r.scores, { correctness: null, completeness: null, scope_discipline: null });
  assert.deepStrictEqual(validateBenchmarkRecord(r), { ok: true, errors: [] });
});

test('unstamped spec yields spec_hash null — the writer never recomputes at review time', () => {
  const r = buildBenchmarkRecord({ specText: SPEC, specSlug: 's', project: 'p', feedbackText: FEEDBACK_FULL });
  assert.strictEqual(r.spec_hash, null);
});

test('missing FEEDBACK, bogus enums, and non-bool flags all null out', () => {
  const noFeedback = buildBenchmarkRecord({ specText: stampClaimSpecHash(SPEC).text, specSlug: 's', project: 'p' });
  assert.strictEqual(noFeedback.agent_model, null);
  assert.strictEqual(noFeedback.agent_tool, null);
  assert.strictEqual(noFeedback.duration_minutes, null);
  assert.strictEqual(noFeedback.priority_was_right, null);
  assert.deepStrictEqual(noFeedback.scores, { correctness: null, completeness: null, scope_discipline: null });
  assert.deepStrictEqual(validateBenchmarkRecord(noFeedback), { ok: true, errors: [] });

  const weird = `---
agent_tool: "my-cool-agent"
priority_was_right: "yes"
duration_minutes: "twelve"
---
`;
  const r = buildBenchmarkRecord({ specText: SPEC, specSlug: 's', project: 'p', feedbackText: weird });
  assert.strictEqual(r.agent_tool, null, 'non-enum agent_tool is null, not coerced to other');
  assert.strictEqual(r.priority_was_right, null);
  assert.strictEqual(r.duration_minutes, null);
});

test('malformed FEEDBACK never throws and never produces an invalid record', () => {
  for (const junk of ['', 'no frontmatter at all', '---\n:::: not yaml {{{\n---\nbody', '---\nunclosed', null]) {
    const r = buildBenchmarkRecord({ specText: SPEC, specSlug: 's', project: 'p', feedbackText: junk });
    const check = validateBenchmarkRecord(r);
    assert.deepStrictEqual(check, { ok: true, errors: [] }, `junk feedback broke the record: ${JSON.stringify(junk)}`);
    // and the line it would write is one valid JSON line
    const line = JSON.stringify(r);
    assert.ok(!line.includes('\n'));
    assert.deepStrictEqual(JSON.parse(line), r);
  }
});

// ---------- validation ----------

test('validateBenchmarkRecord rejects missing fields, bad enums, and 0 scores', () => {
  const good = buildBenchmarkRecord({ specText: SPEC, specSlug: 's', project: 'p' });
  const drop = { ...good }; delete drop.spec_hash;
  assert.strictEqual(validateBenchmarkRecord(drop).ok, false);
  assert.strictEqual(validateBenchmarkRecord({ ...good, spec_type: 'chore' }).ok, false);
  assert.strictEqual(validateBenchmarkRecord({ ...good, agent_tool: 'copilot' }).ok, false);
  assert.strictEqual(validateBenchmarkRecord({ ...good, scores: { ...good.scores, correctness: 0 } }).ok, false);
  assert.strictEqual(validateBenchmarkRecord({ ...good, extra_field: 1 }).ok, false);
  assert.strictEqual(validateBenchmarkRecord(null).ok, false);
});

// ---------- append: append-only + idempotent ----------

test('repeat acceptance appends exactly one line; a changed measurement appends its own', () => {
  const ws = tmpWs();
  const stamped = stampClaimSpecHash(SPEC);
  const mk = over => buildBenchmarkRecord({
    specText: stamped.text, specSlug: 'jira-sync-skill', project: 'throughline',
    feedbackText: FEEDBACK_FULL, goalIds: ['cross-agent-reach'], date: '2026-07-10', ...over,
  });

  const first = appendBenchmarkRecord(ws, mk({}));
  assert.deepStrictEqual({ ok: first.ok, appended: first.appended }, { ok: true, appended: true });
  // repeat accept, even on a later day: same measurement, no second line
  const repeat = appendBenchmarkRecord(ws, mk({ date: '2026-07-11' }));
  assert.deepStrictEqual({ ok: repeat.ok, appended: repeat.appended, reason: repeat.reason },
    { ok: true, appended: false, reason: 'duplicate' });
  assert.strictEqual(readBenchmarkRecords(ws).length, 1);

  // a genuine re-run (kickback → rebuild → re-accept with new cost) is a new line
  const rerunFeedback = FEEDBACK_FULL.replace('duration_minutes: 18', 'duration_minutes: 11')
    .replace('agent_model: "claude-fable-5"', 'agent_model: "gpt-5"')
    .replace('agent_tool: "claude-code"', 'agent_tool: "codex"');
  const rerun = appendBenchmarkRecord(ws, mk({ feedbackText: rerunFeedback, date: '2026-07-11' }));
  assert.strictEqual(rerun.appended, true);

  const rows = readBenchmarkRecords(ws);
  assert.strictEqual(rows.length, 2);
  // the H2H join: same task, two agents, same spec_hash
  assert.strictEqual(rows[0].spec_hash, rows[1].spec_hash);
  assert.notStrictEqual(rows[0].agent_model, rows[1].agent_model);
});

test('append is append-only: existing lines are byte-preserved, invalid records are refused', () => {
  const ws = tmpWs();
  const file = benchmarkLogPath(ws);
  // pre-existing content, including a foreign malformed line — never touched
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const preexisting = '{"date":"2026-01-01","legacy_row":true}\nnot json at all\n';
  fs.writeFileSync(file, preexisting);

  const record = buildBenchmarkRecord({
    specText: stampClaimSpecHash(SPEC).text, specSlug: 's2', project: 'p', feedbackText: FEEDBACK_FULL,
  });
  const res = appendBenchmarkRecord(ws, record);
  assert.strictEqual(res.appended, true);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(preexisting), 'existing lines must never be edited or reordered');
  assert.strictEqual(after.split('\n').filter(Boolean).length, 3);

  // an invalid record is refused before it can reach the file
  const bad = appendBenchmarkRecord(ws, { ...record, scores: { correctness: 0 } });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), after, 'refused record must not touch the file');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  REPLAY_FINGERPRINT_FIELDS,
  replayRuntimeFingerprint,
  fingerprintDiff,
  parseCandidate,
  locateSpec,
  listExperiments,
  replayExperiment,
  createSuite,
  readSuite,
  listSuites,
  selectSuiteExperiments,
  replaySuite,
  replayReport,
} = require('../lib/experiment-replay');
const { queueExperiment, drainQueue, readQueueRows, readExperimentMeta } = require('../lib/experiment-queue');
const { shouldPromoteFromReplays } = require('../lib/experiment-policy');
const { parseFrontmatter } = require('../lib/parse');

// ---------- fixtures ----------

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A tiny real repo — only used by the spec-mode test (base_commit from HEAD).
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-replay-repo-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'untouched\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  return dir;
}

function specText(title, tags, body) {
  return [
    '---',
    `title: "${title}"`,
    'type: "feature"',
    'status: "ready"',
    'priority: "p2"',
    `tags: [${tags.join(', ')}]`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Objective',
    '',
    body,
    '',
  ].join('\n');
}

// A workspace with two specs; canonical stage folders are snapshot-checked.
function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-replay-ws-'));
  fs.mkdirSync(path.join(ws, 'specs', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'specs', 'demo', 'SPEC.md'), specText('Demo spec', ['experiments'], 'Do the demo thing.'));
  fs.mkdirSync(path.join(ws, 'specs', 'other'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'specs', 'other', 'SPEC.md'), specText('Other spec', ['ui'], 'Do the other thing.'));
  return ws;
}

function stageSnapshot(ws) {
  const out = {};
  for (const stage of ['specs', 'in-progress', 'tests', 'in-review', 'done']) {
    const dir = path.join(ws, stage);
    out[stage] = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null;
  }
  return out;
}

// Queue + fully drain (candidates and judge) one fixture experiment.
function judgedExperiment(ws, opts = {}) {
  const { experimentId } = queueExperiment(ws, {
    spec: opts.spec || 'specs/demo/',
    baseCommit: opts.baseCommit || 'origbase123',
    candidates: opts.candidates,
    experimentId: opts.experimentId,
    now: opts.now,
  });
  drainQueue(ws, { agent: 'fixture', judges: true });
  return experimentId;
}

// A fake "tl checkout" whose rules/skills the fingerprint hashes.
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-replay-root-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'rules v1\n');
  fs.mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), 'skill v1\n');
  return root;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ---------- exact replay metadata ----------

test('exact replay records replay_of, the original spec_hash + base_commit, and a full runtime fingerprint', () => {
  const ws = mkWorkspace();
  const root = mkRoot();
  const before = stageSnapshot(ws);
  const originalId = judgedExperiment(ws);
  const original = readExperimentMeta(ws, originalId);

  const result = replayExperiment(ws, originalId, { candidate: 'fixture', rootDir: root });
  assert.equal(result.mode, 'exact');
  assert.equal(result.replayOf, originalId);

  // New experiment carries the controlled-comparison key of the ORIGINAL.
  const meta = readExperimentMeta(ws, result.experimentId);
  assert.equal(meta.replay_of, originalId);
  assert.equal(meta.spec_hash, original.spec_hash);
  assert.equal(meta.base_commit, 'origbase123');
  assert.equal(meta.status, 'queued');
  assert.equal(meta.judge_agent, original.judge_agent); // judge reused by default

  // One queued primary row in the candidate's lane.
  const rows = readQueueRows(ws).filter(r => r.experiment_id === result.experimentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'primary');
  assert.equal(rows[0].agent_tool, 'fixture');
  assert.equal(rows[0].status, 'queued');

  // REPLAY.json: mode, original identity + previous winner, fingerprint.
  const replay = JSON.parse(fs.readFileSync(result.replayPath, 'utf8'));
  assert.equal(replay.mode, 'exact');
  assert.equal(replay.replay_of, originalId);
  assert.equal(replay.original.spec_hash, original.spec_hash);
  assert.equal(replay.original.base_commit, 'origbase123');
  assert.equal(replay.original.previous_winner, 'fixture-a');
  for (const f of REPLAY_FINGERPRINT_FIELDS) {
    assert.ok(replay.runtime_fingerprint[f] !== undefined, `fingerprint field ${f} present`);
  }
  assert.equal(replay.runtime_fingerprint.tl_version, require('../package.json').version);
  assert.match(replay.runtime_fingerprint.rules_hash, /^[0-9a-f]{12}$/);
  assert.match(replay.runtime_fingerprint.skills_hash, /^[0-9a-f]{12}$/);

  // Canonical stages untouched by replay.
  assert.deepEqual(stageSnapshot(ws), before);
});

test('rules/skills hashes move when the rules or skills move', () => {
  const root = mkRoot();
  const a = replayRuntimeFingerprint({ agent_tool: 'fixture' }, { rootDir: root });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'rules v2\n');
  const b = replayRuntimeFingerprint({ agent_tool: 'fixture' }, { rootDir: root });
  assert.notEqual(a.rules_hash, b.rules_hash);
  assert.equal(a.skills_hash, b.skills_hash);
  fs.writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), 'skill v2\n');
  const c = replayRuntimeFingerprint({ agent_tool: 'fixture' }, { rootDir: root });
  assert.notEqual(b.skills_hash, c.skills_hash);
  assert.deepEqual(fingerprintDiff(a, b), ['rules_hash']);
  assert.deepEqual(fingerprintDiff(b, c).sort(), ['skills_hash']);
});

// ---------- mode handling ----------

test('exact replay refuses a changed spec; auto degrades to spec mode with current hash + HEAD', () => {
  const ws = mkWorkspace();
  const repo = mkRepo();
  const originalId = judgedExperiment(ws);
  const original = readExperimentMeta(ws, originalId);

  fs.writeFileSync(path.join(ws, 'specs', 'demo', 'SPEC.md'), specText('Demo spec', ['experiments'], 'The task text CHANGED.'));

  assert.throws(
    () => replayExperiment(ws, originalId, { candidate: 'fixture' }),
    /has changed since the original run/,
  );

  const result = replayExperiment(ws, originalId, { candidate: 'fixture', mode: 'auto', repoDir: repo });
  assert.equal(result.mode, 'spec');
  const meta = readExperimentMeta(ws, result.experimentId);
  assert.notEqual(meta.spec_hash, original.spec_hash); // rehashed now
  assert.equal(meta.base_commit, git(repo, 'rev-parse', 'HEAD').trim()); // current tree
  assert.equal(meta.replay_of, originalId);
  const replay = JSON.parse(fs.readFileSync(result.replayPath, 'utf8'));
  assert.equal(replay.original.spec_hash_matches, false);
});

test('replay follows a spec that moved lifecycle stages since the original run', () => {
  const ws = mkWorkspace();
  const originalId = judgedExperiment(ws);
  fs.mkdirSync(path.join(ws, 'done'), { recursive: true });
  fs.renameSync(path.join(ws, 'specs', 'demo'), path.join(ws, 'done', 'demo'));

  assert.deepEqual(locateSpec(ws, 'specs/demo/'), { rel: 'done/demo/', file: path.join(ws, 'done', 'demo', 'SPEC.md') });
  const result = replayExperiment(ws, originalId, { candidate: 'fixture' });
  assert.equal(result.mode, 'exact'); // same body, same hash — moved is not changed
  assert.equal(readExperimentMeta(ws, result.experimentId).tl_spec, 'done/demo/');
});

test('unknown mode, unknown experiment, and a missing candidate all fail loudly', () => {
  const ws = mkWorkspace();
  const originalId = judgedExperiment(ws);
  assert.throws(() => replayExperiment(ws, originalId, { candidate: 'fixture', mode: 'vibes' }), /Unknown replay mode/);
  assert.throws(() => replayExperiment(ws, 'exp-nope', { candidate: 'fixture' }), /Experiment not found/);
  assert.throws(() => replayExperiment(ws, originalId, {}), /requires a candidate/);
  assert.throws(() => replayExperiment(ws, '../etc', { candidate: 'fixture' }), /Invalid experiment id/);
});

test('parseCandidate handles tool, tool:model, and structured objects', () => {
  assert.deepEqual(parseCandidate('codex'), { agent_tool: 'codex', agent_model: null, id: 'codex' });
  assert.deepEqual(parseCandidate('codex:gpt-5'), { agent_tool: 'codex', agent_model: 'gpt-5', id: 'codex-gpt-5' });
  const obj = parseCandidate({ agent_tool: 'shell', command: 'true' });
  assert.equal(obj.agent_tool, 'shell');
  assert.equal(obj.command, 'true');
  assert.throws(() => parseCandidate(''), /requires a candidate/);
  assert.throws(() => parseCandidate({}), /requires agent_tool/);
});

// ---------- suites ----------

test('suite create/read/list record selectors; duplicates and bad names refuse', () => {
  const ws = mkWorkspace();
  const { suite, file } = createSuite(ws, 'nightly', { specs: ['specs/demo/'], tags: ['experiments'], sampleSize: 5, notes: 'demo bench' });
  assert.ok(fs.existsSync(file));
  assert.equal(suite.sample_size, 5);
  assert.deepEqual(readSuite(ws, 'nightly').selectors.specs, ['specs/demo/']);
  assert.equal(listSuites(ws).length, 1);
  assert.throws(() => createSuite(ws, 'nightly', {}), /already exists/);
  assert.throws(() => createSuite(ws, '../evil', {}), /Invalid suite name/);
  assert.throws(() => readSuite(ws, 'missing'), /Suite not found/);
});

test('suite selection: judged originals only, selector matching, newest-per-spec_hash, sample cap', () => {
  const ws = mkWorkspace();
  // Two judged runs of the same demo spec (same spec_hash) …
  judgedExperiment(ws, { experimentId: 'exp-demo-old', now: new Date('2026-07-01T00:00:00Z') });
  judgedExperiment(ws, { experimentId: 'exp-demo-new', now: new Date('2026-07-02T00:00:00Z') });
  // … one judged run of the other spec …
  judgedExperiment(ws, { spec: 'specs/other/', experimentId: 'exp-other', now: new Date('2026-07-03T00:00:00Z') });
  // … an UNjudged experiment (its lane has no worker, so it never terminates
  // and the judge never queues — the drain below cannot reach it) …
  queueExperiment(ws, {
    spec: 'specs/demo/', baseCommit: 'x', experimentId: 'exp-unjudged',
    candidates: [{ id: 'g', role: 'primary', agent_tool: 'ghost' }],
    now: new Date('2026-07-04T00:00:00Z'),
  });
  // … and a replay experiment (never a benchmark source), judged too.
  const rep = replayExperiment(ws, 'exp-demo-new', { candidate: 'fixture', now: new Date('2026-07-05T00:00:00Z') });
  drainQueue(ws, { agent: 'fixture', judges: true });
  assert.ok(readExperimentMeta(ws, rep.experimentId).replay_of);

  const all = { selectors: { specs: [], tags: [], task_types: [] }, sample_size: null };
  const ids = sel => selectSuiteExperiments(ws, sel).map(m => m.experiment_id);

  // Everything judged + original + deduped: newest demo run wins, replay excluded.
  assert.deepEqual(ids(all).sort(), ['exp-demo-new', 'exp-other']);
  // Spec selector.
  assert.deepEqual(ids({ selectors: { specs: ['specs/demo/'] } }), ['exp-demo-new']);
  assert.deepEqual(ids({ selectors: { specs: ['other'] } }), ['exp-other']);
  // Tag selector reads the spec's frontmatter tags.
  assert.deepEqual(ids({ selectors: { tags: ['ui'] } }), ['exp-other']);
  // Task-type selector.
  assert.deepEqual(ids({ selectors: { task_types: ['no-such-type'] } }), []);
  // Sample cap keeps the newest.
  assert.deepEqual(ids({ selectors: {}, sample_size: 1 }), ['exp-other']);
});

test('suite replay queues one replay per selected task, tagged with the suite id', () => {
  const ws = mkWorkspace();
  judgedExperiment(ws, { experimentId: 'exp-demo', now: new Date('2026-07-01T00:00:00Z') });
  judgedExperiment(ws, { spec: 'specs/other/', experimentId: 'exp-other', now: new Date('2026-07-02T00:00:00Z') });
  createSuite(ws, 'bench', {});

  const result = replaySuite(ws, 'bench', { candidate: 'fixture:deterministic' });
  assert.deepEqual(result.selected.sort(), ['exp-demo', 'exp-other']);
  assert.equal(result.queued.length, 2);
  assert.deepEqual(result.skipped, []);
  for (const q of result.queued) {
    const meta = readExperimentMeta(ws, q.experimentId);
    assert.equal(meta.suite_id, 'bench');
    assert.ok(['exp-demo', 'exp-other'].includes(meta.replay_of));
    const rows = readQueueRows(ws).filter(r => r.experiment_id === q.experimentId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_model_requested, 'deterministic');
  }
});

// ---------- replay report (replay-log.jsonl) ----------

test('replay report compares new candidate to the previous winner and appends exactly once', () => {
  const ws = mkWorkspace();
  const originalId = judgedExperiment(ws);
  const rep = replayExperiment(ws, originalId, { candidate: 'fixture' });
  drainQueue(ws, { agent: 'fixture', judges: true }); // run + judge the replay

  const result = replayReport(ws);
  assert.equal(result.appended, 1);
  const row = result.rows[0];
  assert.equal(row.experiment_id, rep.experimentId);
  assert.equal(row.replay_of, originalId);
  assert.equal(row.previous_winner, 'fixture-a');
  assert.equal(row.new_winner, 'fixture'); // sole candidate wins its own experiment
  assert.ok(Number.isFinite(row.utility_delta), 'utility delta is a number');
  assert.ok(Number.isFinite(row.quality_delta), 'quality delta is a number');
  assert.ok(Number.isFinite(row.cost_delta), 'cost delta is a number');
  assert.ok(Number.isFinite(row.latency_delta), 'latency delta is a number');
  assert.equal(row.replay_status, 'succeeded');
  assert.equal(row.fault, null);
  // One replay is never enough evidence to promote.
  assert.equal(row.promotion_recommendation, 'hold');
  assert.match(row.promotion_reason, /insufficient replay samples/);

  // Idempotent: the same judged replay never folds twice.
  assert.equal(replayReport(ws).appended, 0);
  assert.equal(readJsonl(path.join(ws, '_metrics', 'replay-log.jsonl')).length, 1);
});

test('a faulted replay run is logged and compared as a reliability signal', () => {
  const ws = mkWorkspace();
  const originalId = judgedExperiment(ws);
  const rep = replayExperiment(ws, originalId, { candidate: 'ghost' }); // no local runner for this lane
  drainQueue(ws, { agent: 'ghost' });                                  // → unavailable (terminal), judge queued
  drainQueue(ws, { agent: 'fixture', judges: true });                  // judge lane executes: no eligible winner

  const result = replayReport(ws);
  assert.equal(result.appended, 1);
  const row = result.rows[0];
  assert.equal(row.experiment_id, rep.experimentId);
  assert.equal(row.replay_status, 'unavailable');
  assert.equal(row.fault, 'unavailable');
  assert.equal(row.new_winner, null);
  assert.equal(row.previous_winner, 'fixture-a');
  assert.equal(row.promotion_recommendation, 'hold');
});

test('promotion recommendation flips only with enough replay evidence over the utility threshold', () => {
  const ws = mkWorkspace();
  // A weak original: the sole candidate never completes the task, so its
  // winning utility is low and a completing replay candidate shows a
  // positive delta. (Two identical weak candidates would tie → no winner.)
  const originalId = judgedExperiment(ws, {
    candidates: [{ id: 'weak-a', role: 'primary', agent_tool: 'fixture', complete: false }],
  });
  replayExperiment(ws, originalId, { candidate: { agent_tool: 'fixture', complete: true, id: 'strong-1' }, now: new Date('2026-07-10T00:00:00Z') });
  replayExperiment(ws, originalId, { candidate: { agent_tool: 'fixture', complete: true, id: 'strong-2' }, now: new Date('2026-07-10T00:00:01Z') });
  drainQueue(ws, { agent: 'fixture', judges: true });

  // min_samples_to_promote 3 (default): two positive replays still hold.
  const held = replayReport(ws, { config: { min_samples_to_promote: 3 } });
  assert.equal(held.appended, 2);
  assert.ok(held.rows.every(r => r.utility_delta > 0), 'completing candidate beats the weak winner');
  assert.ok(held.rows.every(r => r.promotion_recommendation === 'hold'));

  // Same evidence, threshold 2: the cumulative fold recommends promotion.
  const ws2rows = readJsonl(path.join(ws, '_metrics', 'replay-log.jsonl'));
  assert.equal(ws2rows.length, 2);
  const rec = shouldPromoteFromReplays(ws2rows.map(r => r.utility_delta), { min_samples_to_promote: 2 });
  assert.equal(rec.promote, true);
  assert.equal(rec.samples, 2);
});

test('shouldPromoteFromReplays enforces both sample count and mean delta', () => {
  // Low samples: never promote, whatever the delta.
  assert.equal(shouldPromoteFromReplays([5.0], {}).promote, false);
  assert.match(shouldPromoteFromReplays([5.0], {}).reason, /min_samples_to_promote/);
  // Enough samples but a mean below the threshold: hold.
  const low = shouldPromoteFromReplays([0.05, 0.05, 0.05], {});
  assert.equal(low.promote, false);
  assert.match(low.reason, /promote_utility_delta/);
  // Enough samples and a real edge: promote.
  const yes = shouldPromoteFromReplays([0.5, 0.2, 0.3], {});
  assert.equal(yes.promote, true);
  assert.equal(yes.samples, 3);
  // Junk deltas are filtered, not counted as samples.
  assert.equal(shouldPromoteFromReplays([null, undefined, 'x', 0.5], {}).samples, 1);
  // Config dials are honored.
  assert.equal(shouldPromoteFromReplays([0.5, 0.5], { min_samples_to_promote: 2, promote_utility_delta: 0.4 }).promote, true);
});

// ---------- safety invariants ----------

test('replay module never touches winner application, and replay ops never move canonical stages', () => {
  // Architectural rule as a failing build: replay evaluates, never applies.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'experiment-replay.js'), 'utf8');
  assert.ok(!/require\((['"`]).*experiment-apply\1\)/.test(src), 'lib/experiment-replay.js must not import lib/experiment-apply.js');

  const ws = mkWorkspace();
  const before = stageSnapshot(ws);
  const specBytes = fs.readFileSync(path.join(ws, 'specs', 'demo', 'SPEC.md'), 'utf8');
  const originalId = judgedExperiment(ws);
  replayExperiment(ws, originalId, { candidate: 'fixture' });
  createSuite(ws, 'safety', {});
  replaySuite(ws, 'safety', { candidate: 'fixture' });
  drainQueue(ws, { agent: 'fixture', judges: true });
  replayReport(ws);
  assert.deepEqual(stageSnapshot(ws), before);
  assert.equal(fs.readFileSync(path.join(ws, 'specs', 'demo', 'SPEC.md'), 'utf8'), specBytes);
});

test('listExperiments skips queue/ and suites/ infrastructure folders', () => {
  const ws = mkWorkspace();
  const originalId = judgedExperiment(ws);
  createSuite(ws, 'infra', {});
  const ids = listExperiments(ws).map(m => m.experiment_id);
  assert.deepEqual(ids, [originalId]);
});

// ---------- CLI surface (argument validation only — no writes) ----------

test('tl experiment replay/suite print usage and fail non-zero without required arguments', () => {
  const tl = path.join(__dirname, '..', 'bin', 'tl.js');
  const replay = spawnSync(process.execPath, [tl, 'experiment', 'replay'], { encoding: 'utf8' });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /Usage: tl experiment replay/);
  const suite = spawnSync(process.execPath, [tl, 'experiment', 'suite'], { encoding: 'utf8' });
  assert.notEqual(suite.status, 0);
  assert.match(suite.stderr, /Usage: tl experiment suite <create\|list\|replay>/);
});

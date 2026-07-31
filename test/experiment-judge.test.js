'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  queueExperiment,
  readQueueRows,
  judgeLaneRows,
  claimRow,
  markRow,
  drainQueue,
} = require('../lib/experiment-queue');
const { runJudge, MODEL_JUDGMENT_DIMENSIONS, DEFAULT_UTILITY_WEIGHTS } = require('../lib/experiment-judge');

// ---------- fixtures (same shapes as test/experiment-queue.test.js) ----------

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-judge-repo-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'untouched\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  return dir;
}

function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-judge-ws-'));
  const specDir = path.join(ws, 'specs', 'demo');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'SPEC.md'), [
    '---',
    'title: "Demo spec"',
    'type: "feature"',
    'status: "ready"',
    'priority: "p2"',
    '---',
    '',
    '# Demo spec',
    '',
    '## Objective',
    '',
    'Do the demo thing.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The thing is done.',
    '',
  ].join('\n'));
  return ws;
}

// Byte-level snapshot of a directory tree — the no-mutation assertion tool.
function treeHash(dir) {
  const entries = {};
  if (!fs.existsSync(dir)) return entries;
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else entries[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return entries;
}

function wsStageSnapshot(ws) {
  const snap = {};
  for (const s of ['specs', 'in-progress', 'tests', 'in-review', 'done']) {
    const dir = path.join(ws, s);
    snap[s] = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null;
  }
  snap.specText = fs.readFileSync(path.join(ws, 'specs', 'demo', 'SPEC.md'), 'utf8');
  return snap;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

const NOW = new Date('2026-07-12T12:00:00Z');

function queueDemo(ws, repo, candidates, extra = {}) {
  return queueExperiment(ws, {
    spec: 'specs/demo/',
    repoDir: repo,
    experimentId: extra.experimentId || 'exp-t',
    candidates,
    now: NOW,
    ...extra,
  });
}

// Drain candidates only, leaving the queued judge row for the scenario.
function drainCandidatesOnly(ws, agent, opts = {}) {
  return drainQueue(ws, { agent, now: NOW, judges: false, ...opts });
}

// ---------- happy path: fixture evaluation lands headlessly ----------

test('drain executes the queued judge row in its lane: verdict, schema artifacts, judge-log, statuses', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo); // fixture defaults: fixture-a primary (complete), fixture-b shadow (incomplete), judge lane fixture

  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo });

  // Candidates ran, the judge was queued AND executed in the same pass —
  // no human prompt anywhere in the loop.
  assert.equal(result.ran.length, 2);
  assert.equal(result.judges.length, 1);
  assert.deepEqual(result.judged.map(j => [j.row.candidate_id, j.status, j.winner]), [
    ['fixture-judge', 'succeeded', 'fixture-a'],
  ]);

  // Evaluation artifacts per the shipped schema, plus the lane-agnostic brief.
  const evalDir = path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge');
  for (const f of ['EVALUATION.md', 'SCORES.json', 'JUDGE-BRIEF.md']) {
    assert.ok(fs.existsSync(path.join(evalDir, f)), `${f} missing`);
  }
  const scores = JSON.parse(fs.readFileSync(path.join(evalDir, 'SCORES.json'), 'utf8'));
  assert.equal(scores.judge_id, 'fixture-judge');
  assert.equal(scores.judge_agent, 'fixture');
  assert.equal(scores.status, 'succeeded');
  assert.equal(scores.self_judge, false);
  assert.equal(scores.winner, 'fixture-a');
  assert.equal(scores.winner_set_by, 'judge');
  assert.deepEqual(scores.utility_weights, DEFAULT_UTILITY_WEIGHTS);
  assert.deepEqual(scores.model_judgment_pending, MODEL_JUDGMENT_DIMENSIONS);
  for (const cid of ['fixture-a', 'fixture-b']) {
    const c = scores.candidates[cid];
    assert.ok(c, `no scores entry for ${cid}`);
    assert.deepEqual(Object.keys(c.scores).sort(), [
      'completeness', 'correctness', 'explanation_quality', 'maintainability', 'scope_discipline', 'test_quality',
    ]);
    for (const v of Object.values(c.scores)) assert.ok(v >= 1 && v <= 5);
    assert.equal(typeof c.utility, 'number');
    assert.equal(c.gates.valid_output, true);
    assert.equal(c.gates.patch_applies, true);      // checked against the real repo in isolation
    assert.equal(c.gates.tests_pass, null);         // no test command — declared unavailable, not a silent pass
  }
  // The complete primary outranks the incomplete shadow.
  assert.ok(scores.candidates['fixture-a'].utility > scores.candidates['fixture-b'].utility);

  // The brief carries the model-judgment dimensions for any lane to refine.
  const brief = fs.readFileSync(path.join(evalDir, 'JUDGE-BRIEF.md'), 'utf8');
  for (const d of MODEL_JUDGMENT_DIMENSIONS) assert.match(brief, new RegExp(d));
  assert.match(brief, /skills\/experiment-judge\/SKILL\.md/);

  // Judge identity is recorded in the append-only log.
  const log = readJsonl(path.join(ws, '_metrics', 'judge-log.jsonl'));
  assert.equal(log.length, 1);
  assert.equal(log[0].judge_id, 'fixture-judge');
  assert.equal(log[0].judge_agent, 'fixture');
  assert.equal(log[0].winner, 'fixture-a');
  assert.equal(log[0].winner_set_by, 'judge');
  assert.equal(log[0].hard_gates_passed, true);
  assert.equal(log[0].scores_path, '_experiments/exp-t/evaluation/fixture-judge/SCORES.json');
  assert.equal(log[0].evaluation_path, '_experiments/exp-t/evaluation/fixture-judge/EVALUATION.md');

  // The experiment advanced past awaiting_evaluation; the judge row is terminal.
  assert.match(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md'), 'utf8'), /status: "succeeded"/);
  assert.equal(readQueueRows(ws).find(r => r.role === 'judge').status, 'succeeded');

  // A second drain has nothing left: no re-judging, no duplicate log rows.
  const again = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo });
  assert.equal(again.judged.length, 0);
  assert.equal(readJsonl(path.join(ws, '_metrics', 'judge-log.jsonl')).length, 1);
});

// ---------- the never-mutate invariant ----------

test('judging leaves candidates, the canonical repo, and canonical stage folders byte-untouched', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'sh-p', role: 'primary', agent_tool: 'shell', repo, command: 'echo changed >> existing.txt && echo brand-new > added.txt' },
  ], { judge: { id: 'sh-judge', agent_tool: 'shell' } });

  // Run the candidate first, then snapshot everything the judge must not touch.
  // (Unsandboxed shell rows need the explicit drain-level trust opt-in.)
  drainCandidatesOnly(ws, 'shell', { allowUnsafeHostExec: true });
  const candidatesBefore = treeHash(path.join(ws, '_experiments', 'exp-t', 'candidates'));
  const repoBefore = treeHash(repo);
  const stagesBefore = wsStageSnapshot(ws);

  const result = drainQueue(ws, { agent: 'shell', now: NOW, judges: true, repoDir: repo, testCommand: 'test -f added.txt && grep -q changed existing.txt' });
  assert.deepEqual(result.judged.map(j => [j.status, j.winner]), [['succeeded', 'sh-p']]);

  // The patch-apply + test gates ran against a real repo — in isolation.
  const scores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'sh-judge', 'SCORES.json'), 'utf8'));
  assert.equal(scores.candidates['sh-p'].gates.patch_applies, true);
  assert.equal(scores.candidates['sh-p'].gates.tests_pass, true);
  assert.equal(scores.candidates['sh-p'].scores.test_quality, 4);

  // Byte-untouched: candidate artifacts, canonical repo, canonical stages.
  assert.deepEqual(treeHash(path.join(ws, '_experiments', 'exp-t', 'candidates')), candidatesBefore);
  assert.deepEqual(treeHash(repo), repoBefore);
  assert.deepEqual(wsStageSnapshot(ws), stagesBefore);

  // No leaked isolation: no judge workdirs, no stray worktrees.
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-t', 'work', 'judge--sh-p')), false);
  assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1);
});

test('a failing test command fails the tests_pass gate and the candidate cannot win', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'sh-p', role: 'primary', agent_tool: 'shell', repo, command: 'echo brand-new > added.txt' },
  ], { judge: { id: 'sh-judge', agent_tool: 'shell' } });
  drainCandidatesOnly(ws, 'shell', { allowUnsafeHostExec: true });

  const result = drainQueue(ws, { agent: 'shell', now: NOW, judges: true, testCommand: 'test -f does-not-exist.txt' });
  assert.equal(result.judged[0].status, 'succeeded'); // the judge RUN succeeded; the verdict is "no winner"
  assert.equal(result.judged[0].winner, null);
  const scores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'sh-judge', 'SCORES.json'), 'utf8'));
  assert.equal(scores.candidates['sh-p'].gates.tests_pass, false);
  assert.equal(scores.candidates['sh-p'].hard_gates_passed, false);
  assert.match(scores.rationale, /No candidate passed the hard gates/);
  // No eligible winner → the experiment records the unsuccessful outcome.
  assert.match(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md'), 'utf8'), /status: "failed"/);
});

// ---------- auto-initiated experiments: live test commands default OFF ----------

test('auto-initiated judges refuse a drain-wide test command by default — tests_pass stays null, never a silent execution', () => {
  const repo = mkRepo();
  const ws = mkWorkspace(); // no TRIAGE.yml at all — the fail-closed default
  const sentinel = path.join(os.tmpdir(), `tl-judge-auto-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
  queueDemo(ws, repo, undefined, { initiatedBy: 'policy' }); // fixture defaults, policy provenance
  drainCandidatesOnly(ws, 'fixture');

  const result = drainQueue(ws, {
    agent: 'fixture', now: NOW, judges: true, repoDir: repo,
    testCommand: `echo ran > ${sentinel}`,
  });
  assert.deepEqual(result.judged.map(j => [j.status, j.winner]), [['succeeded', 'fixture-a']]);

  // The command never executed; the refusal is recorded honestly as null +
  // note — declared unavailable, which does not fail the gate.
  assert.equal(fs.existsSync(sentinel), false, 'auto-path judge test command must never execute');
  const scores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'SCORES.json'), 'utf8'));
  for (const cid of ['fixture-a', 'fixture-b']) {
    assert.equal(scores.candidates[cid].gates.patch_applies, true); // apply --check still runs — it executes nothing
    assert.equal(scores.candidates[cid].gates.tests_pass, null);
  }
  const evaluation = fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'EVALUATION.md'), 'utf8');
  assert.match(evaluation, /auto-initiated experiment \(initiated_by: policy\): live test command refused/);
  assert.match(evaluation, /auto_initiate_allow_test_command/); // the concrete opt-in is named
});

test('the explicit dial widens it: auto_initiate_allow_test_command: true lets an auto judge run the test command', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  fs.writeFileSync(path.join(ws, 'TRIAGE.yml'), [
    'experiments:',
    '  enabled: true',
    '  auto_initiate: true',
    '  auto_initiate_allow_test_command: true',
    '',
  ].join('\n'));
  queueDemo(ws, repo, undefined, { initiatedBy: 'policy' });
  drainCandidatesOnly(ws, 'fixture');

  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo, testCommand: 'true' });
  assert.deepEqual(result.judged.map(j => [j.status, j.winner]), [['succeeded', 'fixture-a']]);
  const scores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'SCORES.json'), 'utf8'));
  assert.equal(scores.candidates['fixture-a'].gates.tests_pass, true); // the command actually ran
});

test('the opt-in dial requires literal true — a garbage value stays fail-closed; human experiments are untouched by all of it', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  fs.writeFileSync(path.join(ws, 'TRIAGE.yml'), [
    'experiments:',
    '  enabled: true',
    '  auto_initiate: true',
    '  auto_initiate_allow_test_command: "yes"', // truthy garbage, not literal true
    '',
  ].join('\n'));
  queueDemo(ws, repo, undefined, { initiatedBy: 'policy' });
  drainCandidatesOnly(ws, 'fixture');
  const auto = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo, testCommand: 'true' });
  assert.equal(auto.judged[0].status, 'succeeded');
  const autoScores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'SCORES.json'), 'utf8'));
  assert.equal(autoScores.candidates['fixture-a'].gates.tests_pass, null);

  // A human-queued experiment in the SAME workspace runs the test command as shipped.
  queueDemo(ws, repo, undefined, { experimentId: 'exp-human' });
  drainCandidatesOnly(ws, 'fixture');
  const human = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo, testCommand: 'true' });
  assert.equal(human.judged[0].status, 'succeeded');
  const humanScores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-human', 'evaluation', 'fixture-judge', 'SCORES.json'), 'utf8'));
  assert.equal(humanScores.candidates['fixture-a'].gates.tests_pass, true);
});

// ---------- hard gates: patch that won't apply ----------

test('a patch that fails git apply --check is invalid_output — gate-failed, still scored, never the winner', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo);
  drainCandidatesOnly(ws, 'fixture');

  // Corrupt the PRIMARY's patch after its run — the judge must judge the
  // artifact, not the candidate's claim of success.
  fs.writeFileSync(path.join(ws, '_experiments', 'exp-t', 'candidates', 'fixture-a', 'PATCH.diff'),
    'this is not a unified diff at all\n');

  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo });
  assert.equal(result.judged[0].status, 'succeeded');
  assert.equal(result.judged[0].winner, 'fixture-b');

  const scores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'SCORES.json'), 'utf8'));
  assert.equal(scores.candidates['fixture-a'].hard_gates_passed, false);
  assert.equal(scores.candidates['fixture-a'].gates.patch_applies, false);
  assert.equal(scores.candidates['fixture-a'].fault, 'invalid_output');
  // Gate-failed candidates are still scored and logged — learning data, never dropped.
  assert.ok(scores.candidates['fixture-a'].scores.correctness >= 1);
  assert.equal(scores.candidates['fixture-b'].hard_gates_passed, true);
});

// ---------- faulted candidates are learning data ----------

test('a candidate that never ran is judged unavailable; the terminal shadow still wins', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'cur-p', role: 'primary', agent_tool: 'cursor' },   // no local runner → unavailable
    { id: 'fix-s', role: 'shadow', agent_tool: 'fixture', complete: true },
  ]);
  drainQueue(ws, { agent: 'cursor', now: NOW });              // cur-p → unavailable (terminal fault)
  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo });

  assert.deepEqual(result.judged.map(j => [j.status, j.winner]), [['succeeded', 'fix-s']]);
  const scores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'SCORES.json'), 'utf8'));
  assert.equal(scores.candidates['cur-p'].hard_gates_passed, false);
  assert.equal(scores.candidates['cur-p'].fault, 'unavailable');
  assert.ok(scores.candidates['cur-p'].scores, 'faulted candidate is still scored');
  assert.match(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md'), 'utf8'), /status: "succeeded"/);
});

// ---------- claim race ----------

test('judge claim race: the exclusive marker decides — the losing drain skips, nothing double-writes', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo);
  drainCandidatesOnly(ws, 'fixture'); // candidates terminal → judge row queued, left unexecuted

  const jrow = readQueueRows(ws).find(r => r.role === 'judge');
  assert.equal(jrow.status, 'queued');
  assert.deepEqual(judgeLaneRows(readQueueRows(ws), 'fixture').map(r => r.candidate_id), ['fixture-judge']);
  assert.deepEqual(judgeLaneRows(readQueueRows(ws), 'shell'), []); // lane discipline holds for judges too

  // The race window: another worker has created the exclusive claim marker
  // but its `running` append has not landed yet — both workers read the row
  // as queued, only the marker decides.
  const claimsDir = path.join(ws, '_experiments', 'queue', 'claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(path.join(claimsDir, 'exp-t--fixture-judge--1.claim'),
    JSON.stringify({ agent: 'other-fixture-worker', ts: NOW.toISOString() }) + '\n', { flag: 'wx' });

  // Our drain loses the race and moves on — no crash, no evaluation write.
  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo });
  assert.deepEqual(result.judged.map(j => [j.status, j.reason]), [
    ['skipped', 'claim lost — another worker holds it'],
  ]);
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-t', 'evaluation')), false);
  assert.equal(fs.existsSync(path.join(ws, '_metrics', 'judge-log.jsonl')), false);

  // The marker holder finishes the job through the same helpers.
  const stolen = markRow(ws, { ...jrow, attempt: 1, claimed_by: 'other-fixture-worker' }, 'running', { now: NOW });
  const outcome = runJudge(ws, stolen, { now: NOW, repoDir: repo });
  assert.equal(outcome.status, 'succeeded');
  markRow(ws, stolen, 'succeeded', { now: NOW });
  assert.equal(readQueueRows(ws).find(r => r.role === 'judge').status, 'succeeded');
});

// ---------- fault release: mid-run failure never half-writes ----------

test('a judge that fails mid-run marks the row failed, releases the claim, and leaves no partial evaluation', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo);
  drainCandidatesOnly(ws, 'fixture');

  // Crash injection through the same seam tests use for runCandidate.
  const boom = () => { throw new Error('judge exploded mid-run'); };
  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, runJudge: boom });
  assert.deepEqual(result.judged.map(j => [j.status]), [['failed']]);
  assert.match(result.judged[0].reason, /judge crashed: judge exploded mid-run/);

  // Fault status on the row, claim marker released, no half-written artifacts.
  const jrow = readQueueRows(ws).find(r => r.role === 'judge');
  assert.equal(jrow.status, 'failed');
  assert.equal(jrow.fault, 'failed');
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'queue', 'claims', 'exp-t--fixture-judge--1.claim')), false);
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-t', 'evaluation')), false);
  assert.equal(fs.existsSync(path.join(ws, '_metrics', 'judge-log.jsonl')), false);
  // The experiment is still awaiting evaluation — nothing advanced on a fault.
  assert.match(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md'), 'utf8'), /status: "awaiting_evaluation"/);

  // A retry is a NEW attempt, claimed explicitly — and it completes cleanly.
  const retry = claimRow(ws, jrow, 'fixture', { now: NOW });
  assert.equal(retry.attempt, 2);
  const outcome = runJudge(ws, retry, { now: NOW, repoDir: repo });
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.winner, 'fixture-a');
  markRow(ws, retry, 'succeeded', { now: NOW });
  assert.ok(fs.existsSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'SCORES.json')));
});

test('an internal write failure inside runJudge reports a fault and leaves no staging debris', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo);
  drainCandidatesOnly(ws, 'fixture');

  // Sabotage: evaluation/ exists as a FILE, so staging cannot even mkdir.
  fs.writeFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation'), 'in the way\n');

  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo });
  assert.equal(result.judged[0].status, 'failed');
  assert.match(result.judged[0].reason, /judge run failed:/);

  // No half-written evaluation, no judge-log row, claim released, row faulted.
  assert.equal(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation'), 'utf8'), 'in the way\n');
  assert.equal(fs.existsSync(path.join(ws, '_metrics', 'judge-log.jsonl')), false);
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'queue', 'claims', 'exp-t--fixture-judge--1.claim')), false);
  assert.equal(readQueueRows(ws).find(r => r.role === 'judge').status, 'failed');
});

// ---------- guardrails ----------

test('the judge refuses to be the primary candidate unless self_judge is set', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo);
  drainCandidatesOnly(ws, 'fixture');

  // Simulate a hand-edited experiment where the judge IS the primary.
  const expFile = path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md');
  fs.writeFileSync(expFile, fs.readFileSync(expFile, 'utf8').replace('primary_agent: "fixture-a"', 'primary_agent: "fixture-judge"'));

  const result = drainQueue(ws, { agent: 'fixture', now: NOW, judges: true, repoDir: repo });
  assert.equal(result.judged[0].status, 'failed');
  assert.match(result.judged[0].reason, /self_judge is not set/);
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-t', 'evaluation')), false);
});

test('judges never touch winner application: experiment-judge does not import or call experiment-apply', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'experiment-judge.js'), 'utf8');
  assert.equal(/applyWinner/.test(src), false, 'experiment-judge references applyWinner');
  assert.equal(/require\(['"]\.\/experiment-apply['"]\)/.test(src), false, 'experiment-judge imports experiment-apply');
});

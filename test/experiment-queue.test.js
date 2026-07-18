'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  QUEUE_ROW_FIELDS,
  TERMINAL_STATUSES,
  queueExperiment,
  readQueueRows,
  laneRows,
  claimRow,
  markRow,
  queueJudge,
  processQueueRequests,
  drainQueue,
} = require('../lib/experiment-queue');
const { runCandidate, hasRunner, createIsolatedWorkdir, removeIsolatedWorkdir } = require('../lib/experiment-runner');

// ---------- fixtures ----------

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A tiny canonical repo with one committed file — the tree candidates run against.
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-queue-repo-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'untouched\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  return dir;
}

function repoSnapshot(dir) {
  const files = fs.readdirSync(dir).filter(f => f !== '.git').sort();
  return { files, existing: fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8') };
}

// A workspace holding one ready spec (never moved by any experiment).
function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-queue-ws-'));
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
    '## Scope',
    '',
    '### Files to touch',
    '',
    '- `lib/demo.js`',
    '',
  ].join('\n'));
  return ws;
}

function wsSnapshot(ws) {
  // Canonical stage folders — experiments must never move or mutate them.
  const stages = ['specs', 'in-progress', 'tests', 'in-review', 'done'];
  const snap = {};
  for (const s of stages) {
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

// ---------- queue creation ----------

test('queueExperiment writes the experiment index, hashes the spec, records base_commit, and writes complete queue rows', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  const head = git(repo, 'rev-parse', 'HEAD').trim();

  const { experimentId, rows } = queueDemo(ws, repo);
  assert.equal(experimentId, 'exp-t');

  // Fixture defaults: one primary, one shadow.
  assert.deepEqual(rows.map(r => [r.candidate_id, r.role, r.agent_tool]), [
    ['fixture-a', 'primary', 'fixture'],
    ['fixture-b', 'shadow', 'fixture'],
  ]);

  // Every row carries the full contract field set.
  for (const row of rows) {
    for (const field of QUEUE_ROW_FIELDS) {
      assert.ok(field in row, `row is missing ${field}`);
    }
    assert.equal(row.status, 'queued');
    assert.equal(row.attempt, 0);
  }

  // The index records identity: spec hash + base commit make comparisons controlled.
  const exp = fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md'), 'utf8');
  assert.match(exp, /spec_hash: "[0-9a-f]{64}"/);
  assert.match(exp, new RegExp(`base_commit: "${head}"`));
  assert.match(exp, /status: "queued"/);
  assert.match(exp, /tl_spec: "specs\/demo\/"/);
  assert.match(exp, /judge_agent: "fixture-judge"/);

  // Rows landed in the per-experiment queue file; the lifecycle log has the queued row.
  assert.equal(readJsonl(path.join(ws, '_experiments', 'queue', 'exp-t.jsonl')).length, 2);
  const log = readJsonl(path.join(ws, '_metrics', 'experiment-log.jsonl'));
  assert.equal(log[0].status, 'queued');
  assert.equal(log[0].previous_status, null);

  // Explicit-config validation: exactly one primary, unique ids, safe segments.
  assert.throws(() => queueDemo(ws, repo, [{ id: 'a', role: 'shadow' }], { experimentId: 'exp-x1' }), /Exactly one primary/);
  assert.throws(() => queueDemo(ws, repo, [{ id: 'a', role: 'primary' }, { id: 'a', role: 'shadow' }], { experimentId: 'exp-x2' }), /unique/);
  assert.throws(() => queueDemo(ws, repo, [{ id: 'no/slash', role: 'primary' }], { experimentId: 'exp-x3' }), /Invalid candidate id/);
  assert.throws(() => queueExperiment(ws, { spec: 'specs/nope/', repoDir: repo }), /Spec not found/);
  assert.throws(() => queueDemo(ws, repo), /already exists/);
});

// ---------- lane filtering ----------

test('laneRows filters queued rows to one agent_tool lane and never surfaces judge rows', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'fix-p', role: 'primary', agent_tool: 'fixture' },
    { id: 'sh-s', role: 'shadow', agent_tool: 'shell', command: 'true', repo },
    { id: 'cur-s', role: 'shadow', agent_tool: 'cursor' },
  ]);

  const rows = readQueueRows(ws);
  assert.equal(rows.length, 3);
  assert.deepEqual(laneRows(rows, 'fixture').map(r => r.candidate_id), ['fix-p']);
  assert.deepEqual(laneRows(rows, 'shell').map(r => r.candidate_id), ['sh-s']);
  assert.deepEqual(laneRows(rows, 'SHELL').map(r => r.candidate_id), ['sh-s']); // case-insensitive lane
  assert.deepEqual(laneRows(rows, 'codex'), []);

  // A claimed row leaves the lane view.
  claimRow(ws, rows[0], 'fixture', { now: NOW });
  assert.deepEqual(laneRows(readQueueRows(ws), 'fixture'), []);
});

// ---------- claim transition ----------

test('claimRow appends an atomic running transition; a second claim of the same attempt loses', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo);
  const row = readQueueRows(ws).find(r => r.candidate_id === 'fixture-a');

  const claimed = claimRow(ws, row, 'fixture-worker-1', { now: NOW });
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempt, 1);
  assert.equal(claimed.claimed_by, 'fixture-worker-1');
  assert.ok(claimed.config, 'config from the queued row is carried on the claim');

  // The losing racer gets null — the exclusive-create marker decides.
  assert.equal(claimRow(ws, row, 'fixture-worker-2', { now: NOW }), null);

  // The current view reflects the transition, and history is append-only.
  const current = readQueueRows(ws).find(r => r.candidate_id === 'fixture-a');
  assert.equal(current.status, 'running');
  assert.equal(current.attempt, 1);
  const history = readJsonl(path.join(ws, '_experiments', 'queue', 'exp-t.jsonl'))
    .filter(r => r.candidate_id === 'fixture-a');
  assert.deepEqual(history.map(r => r.status), ['queued', 'running']);

  // Terminal transition serializes fault-or-null consistently.
  const done = markRow(ws, claimed, 'succeeded', { now: NOW });
  assert.equal(done.fault, null);
  const faulted = markRow(ws, { ...claimed, candidate_id: 'fixture-b', attempt: 1 }, 'timed_out', { now: NOW, reason: 'too slow' });
  assert.equal(faulted.fault, 'timed_out');
  assert.equal(faulted.reason, 'too slow');
});

// ---------- drain end-to-end (fixture lane) ----------

test('drainQueue runs a fixture lane end-to-end: artifacts, log rows, judge queued, canonical specs untouched', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  const before = wsSnapshot(ws);
  queueDemo(ws, repo);

  const result = drainQueue(ws, { agent: 'fixture', now: NOW });
  assert.deepEqual(result.ran.map(r => [r.row.candidate_id, r.status]), [
    ['fixture-a', 'succeeded'],
    ['fixture-b', 'succeeded'],
  ]);

  // The invariant artifact set exists for every candidate.
  for (const cid of ['fixture-a', 'fixture-b']) {
    const dir = path.join(ws, '_experiments', 'exp-t', 'candidates', cid);
    for (const f of ['PATCH.diff', 'FEEDBACK.md', 'METRICS.json', 'TRACE.jsonl']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${cid}/${f} missing`);
    }
  }
  const metricsA = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'candidates', 'fixture-a', 'METRICS.json'), 'utf8'));
  assert.equal(metricsA.task_complete, true);   // primary completes
  const metricsB = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'candidates', 'fixture-b', 'METRICS.json'), 'utf8'));
  assert.equal(metricsB.task_complete, false);  // shadow doesn't (fixture proof shape)

  // candidate-run-log rows carry task identity from EXPERIMENT.md.
  const runLog = readJsonl(path.join(ws, '_metrics', 'candidate-run-log.jsonl'));
  assert.equal(runLog.length, 2);
  assert.equal(runLog[0].tl_spec, 'specs/demo/');
  assert.match(runLog[0].spec_hash, /^[0-9a-f]{64}$/);

  // All candidates terminal → the judge row is queued and status advances.
  assert.equal(result.judges.length, 1);
  const judgeRow = readQueueRows(ws).find(r => r.role === 'judge');
  assert.equal(judgeRow.status, 'queued');
  assert.equal(judgeRow.candidate_id, 'fixture-judge');
  assert.match(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md'), 'utf8'), /status: "awaiting_evaluation"/);

  // A second drain has nothing to do and does not double-queue the judge.
  const again = drainQueue(ws, { agent: 'fixture', now: NOW });
  assert.equal(again.ran.length, 0);
  assert.equal(again.judges.length, 0);
  assert.equal(readQueueRows(ws).filter(r => r.role === 'judge').length, 1);

  // Shadow attempts: canonical stage folders and the spec text are untouched.
  assert.deepEqual(wsSnapshot(ws), before);
});

test('drain claims only its own lane; other lanes stay queued and the judge waits', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'fix-p', role: 'primary', agent_tool: 'fixture' },
    { id: 'sh-s', role: 'shadow', agent_tool: 'shell', command: 'echo hi > new.txt', repo, unsafe_host_exec: true },
  ]);

  const result = drainQueue(ws, { agent: 'fixture', now: NOW });
  assert.deepEqual(result.ran.map(r => r.row.candidate_id), ['fix-p']);

  // The shell row was not claimed — an unavailable worker leaves rows queued.
  const shell = readQueueRows(ws).find(r => r.candidate_id === 'sh-s');
  assert.equal(shell.status, 'queued');

  // And the judge is NOT queued while a candidate run is pending.
  assert.equal(result.judges.length, 0);
  assert.equal(readQueueRows(ws).some(r => r.role === 'judge'), false);

  // The shell worker drains its lane; now everything is terminal and the judge queues.
  const shellPass = drainQueue(ws, { agent: 'shell', now: NOW });
  assert.deepEqual(shellPass.ran.map(r => [r.row.candidate_id, r.status]), [['sh-s', 'succeeded']]);
  assert.equal(shellPass.judges.length, 1);
});

// ---------- fault statuses ----------

test('fault handling: unavailable tool, budget stop, timeout, non-zero exit, empty patch — all terminal, all with artifacts', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'cur-p', role: 'primary', agent_tool: 'cursor' },                                        // no local runner
    // `costly` carries no trust opt-in on purpose: over_budget stops BEFORE
    // the runner, so the budget stop must precede even the trust gate.
    { id: 'costly', role: 'shadow', agent_tool: 'shell', command: 'true', repo, estimated_cost_usd: 5 }, // over budget
    { id: 'slow', role: 'shadow', agent_tool: 'shell', command: 'sleep 5', repo, unsafe_host_exec: true },   // times out
    { id: 'broken', role: 'shadow', agent_tool: 'shell', command: 'exit 3', repo, unsafe_host_exec: true },  // fails
    { id: 'empty', role: 'shadow', agent_tool: 'shell', command: 'true', repo, unsafe_host_exec: true },     // no diff
  ], { budgetUsd: 1, timeoutMinutes: 0.02 }); // 1.2s timeout

  // A cursor worker lane exists but has no local runner → unavailable, not a crash.
  const cursorPass = drainQueue(ws, { agent: 'cursor', now: NOW });
  assert.deepEqual(cursorPass.ran.map(r => [r.row.candidate_id, r.status]), [['cur-p', 'unavailable']]);

  const shellPass = drainQueue(ws, { agent: 'shell', now: NOW });
  const byId = Object.fromEntries(shellPass.ran.map(r => [r.row.candidate_id, r]));
  assert.equal(byId.costly.status, 'over_budget');
  assert.match(byId.costly.reason, /exceeds budget/);
  assert.equal(byId.slow.status, 'timed_out');
  assert.equal(byId.broken.status, 'failed');
  assert.match(byId.broken.reason, /exited 3/);
  assert.equal(byId.empty.status, 'invalid_output');
  assert.match(byId.empty.reason, /empty or missing patch/);

  // Every fault is terminal and serialized on the row as status AND fault.
  const rows = readQueueRows(ws).filter(r => r.role !== 'judge');
  for (const row of rows) {
    assert.ok(TERMINAL_STATUSES.includes(row.status), `${row.candidate_id} not terminal: ${row.status}`);
    assert.equal(row.fault, row.status === 'succeeded' ? null : row.status);
  }

  // Even on failure every candidate wrote the full artifact set + a log row.
  const runLog = readJsonl(path.join(ws, '_metrics', 'candidate-run-log.jsonl'));
  for (const cid of ['cur-p', 'costly', 'slow', 'broken', 'empty']) {
    const dir = path.join(ws, '_experiments', 'exp-t', 'candidates', cid);
    for (const f of ['PATCH.diff', 'FEEDBACK.md', 'METRICS.json', 'TRACE.jsonl']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${cid}/${f} missing after fault`);
    }
    const logged = runLog.find(r => r.candidate_id === cid);
    assert.ok(logged, `no candidate-run-log row for ${cid}`);
    assert.equal(logged.fault, logged.status === 'succeeded' ? null : logged.status);
  }

  // The budget stop never executed — its trace has no command event.
  const costlyTrace = readJsonl(path.join(ws, '_experiments', 'exp-t', 'candidates', 'costly', 'TRACE.jsonl'));
  assert.equal(costlyTrace.some(t => t.type === 'command'), false);

  // All candidates terminal (all faulted but terminal) → judge still queues:
  // faults are learning data and evaluation proceeds.
  assert.equal(readQueueRows(ws).some(r => r.role === 'judge' && r.status === 'queued'), true);
});

test('primary failure does not cancel shadows — a shadow still runs, succeeds, and reaches the judge', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'p-fails', role: 'primary', agent_tool: 'shell', command: 'exit 1', repo, unsafe_host_exec: true },
    { id: 's-wins', role: 'shadow', agent_tool: 'fixture', complete: true },
  ]);

  const shellPass = drainQueue(ws, { agent: 'shell', now: NOW });
  assert.deepEqual(shellPass.ran.map(r => [r.row.candidate_id, r.status]), [['p-fails', 'failed']]);

  // The shadow row is still queued — not cancelled by the primary's failure.
  assert.equal(readQueueRows(ws).find(r => r.candidate_id === 's-wins').status, 'queued');

  const fixturePass = drainQueue(ws, { agent: 'fixture', now: NOW });
  assert.deepEqual(fixturePass.ran.map(r => [r.row.candidate_id, r.status]), [['s-wins', 'succeeded']]);
  assert.equal(fixturePass.judges.length, 1);
  const statuses = Object.fromEntries(readQueueRows(ws).filter(r => r.role !== 'judge').map(r => [r.candidate_id, r.status]));
  assert.deepEqual(statuses, { 'p-fails': 'failed', 's-wins': 'succeeded' });
  assert.equal(Object.values(statuses).includes('cancelled'), false);
});

// ---------- forced partial evaluation ----------

test('queueJudge waits for terminal candidates unless a human forces partial evaluation', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'fix-p', role: 'primary', agent_tool: 'fixture' },
    { id: 'never-runs', role: 'shadow', agent_tool: 'cursor' },
  ]);
  drainQueue(ws, { agent: 'fixture', now: NOW });

  // One candidate still queued → no judge.
  assert.equal(readQueueRows(ws).some(r => r.role === 'judge'), false);
  assert.match(queueJudge(ws, 'exp-t', { now: NOW }).reason, /not terminal/);

  // Explicit force — evaluate partial results.
  const forced = queueJudge(ws, 'exp-t', { force: true, now: NOW });
  assert.equal(forced.queued, true);
  assert.match(forced.row.reason, /forced partial evaluation/);
  assert.match(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'EXPERIMENT.md'), 'utf8'), /status: "awaiting_evaluation"/);
});

// ---------- isolation ----------

test('shell candidates run in an isolated worktree: patch captured, canonical repo untouched, workdir removed', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  const before = repoSnapshot(repo);
  queueDemo(ws, repo, [{
    id: 'iso', role: 'primary', agent_tool: 'shell', repo,
    command: 'echo changed >> existing.txt && echo brand-new > added.txt',
    unsafe_host_exec: true, // row-level trust opt-in survives queueExperiment onto the row config
  }]);

  const result = drainQueue(ws, { agent: 'shell', now: NOW });
  assert.deepEqual(result.ran.map(r => [r.row.candidate_id, r.status]), [['iso', 'succeeded']]);

  // The patch captures both the edit and the new file.
  const patch = fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'candidates', 'iso', 'PATCH.diff'), 'utf8');
  assert.match(patch, /\+changed/);
  assert.match(patch, /added\.txt/);
  assert.match(patch, /\+brand-new/);

  // The canonical repo working tree is byte-identical, and the workdir is gone.
  assert.deepEqual(repoSnapshot(repo), before);
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-t', 'work', 'iso')), false);
  assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1); // no leaked worktrees

  // The seam itself: worktree in, worktree out.
  const dest = path.join(ws, '_experiments', 'exp-t', 'work', 'seam');
  const iso = createIsolatedWorkdir(repo, 'HEAD', dest);
  assert.equal(iso.ok, true);
  assert.ok(['worktree', 'clone'].includes(iso.mode));
  assert.ok(fs.existsSync(path.join(dest, 'existing.txt')));
  removeIsolatedWorkdir(repo, dest, iso.mode);
  assert.equal(fs.existsSync(dest), false);
});

// ---------- request configs (the UI bridge) ----------

test('processQueueRequests folds a queued fixture request into an experiment and marks incomplete local requests invalid', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  const qdir = path.join(ws, '_experiments', 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, '20260712120000-demo.json'), JSON.stringify({
    requested_at: '2026-07-12T11:59:00.000Z',
    status: 'queued', source: 'ui-dashboard', runtime: 'fixture',
    tl_spec: 'specs/demo', primary: 'fixture-a', shadows: ['fixture-b'], judge: 'fixture-judge',
    budget_usd: 2, timeout_minutes: 30, models: { 'fixture-a': 'small-model' },
  }, null, 2));
  fs.writeFileSync(path.join(qdir, '20260712120001-local.json'), JSON.stringify({
    status: 'queued', runtime: 'local', tl_spec: 'specs/demo', primary: 'claude-p', shadows: [], judge: 'judge',
  }, null, 2));

  const results = processQueueRequests(ws, { now: NOW });
  const accepted = results.find(r => r.file === '20260712120000-demo.json');
  assert.equal(accepted.status, 'accepted');
  // A local request without the bridge fields (runner + repo) is malformed —
  // marked invalid with the reason, never silently dropped (provider-adapters
  // slice; see test/experiment-adapters.test.js for the full bridge contract).
  const malformed = results.find(r => r.file === '20260712120001-local.json');
  assert.equal(malformed.status, 'invalid');
  assert.match(malformed.reason, /requires "runner"/);

  // The fixture request became a real experiment with rows in its lanes.
  const rows = readQueueRows(ws).filter(r => r.experiment_id === accepted.experimentId);
  assert.deepEqual(rows.map(r => [r.candidate_id, r.role, r.agent_model_requested]), [
    ['fixture-a', 'primary', 'small-model'],
    ['fixture-b', 'shadow', null],
  ]);
  assert.equal(rows[0].budget_usd, 2);
  assert.equal(rows[0].timeout_minutes, 30);

  // The request file is the audit trail: rewritten, not deleted.
  const rewritten = JSON.parse(fs.readFileSync(path.join(qdir, '20260712120000-demo.json'), 'utf8'));
  assert.equal(rewritten.status, 'accepted');
  assert.equal(rewritten.experiment_id, accepted.experimentId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(qdir, '20260712120001-local.json'), 'utf8')).status, 'invalid');

  // A second pass is idempotent — accepted requests are not re-queued.
  assert.equal(processQueueRequests(ws, { now: NOW }).some(r => r.status === 'accepted'), false);
});

// ---------- worker safety invariants ----------

test('workers never touch winner application: queue and runner do not import or call applyWinner', () => {
  for (const f of ['experiment-queue.js', 'experiment-runner.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    assert.equal(/applyWinner/.test(src), false, `${f} references applyWinner`);
    assert.equal(/require\(['"]\.\/experiment-apply['"]\)/.test(src), false, `${f} imports experiment-apply`);
  }
  assert.equal(hasRunner('fixture'), true);
  assert.equal(hasRunner('shell'), true);
  assert.equal(hasRunner('claude-code'), false); // future adapters register explicitly
});

test('runCandidate on an unknown tool writes the artifact set and reports unavailable without throwing', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  queueDemo(ws, repo, [{ id: 'ghost', role: 'primary', agent_tool: 'windsurf' }]);
  const row = readQueueRows(ws)[0];
  const claimed = claimRow(ws, row, 'windsurf', { now: NOW });

  const result = runCandidate(ws, claimed, { now: NOW });
  assert.equal(result.status, 'unavailable');
  const metrics = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'candidates', 'ghost', 'METRICS.json'), 'utf8'));
  assert.equal(metrics.status, 'unavailable');
  assert.equal(metrics.fault, 'unavailable');
  assert.equal(metrics.task_complete, false);
});

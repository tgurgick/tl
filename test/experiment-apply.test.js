'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  WINNER_STATES,
  readWinnerRecord,
  checkPatchApplies,
  selectWinner,
  applyWinner,
  rejectWinner,
  sendWinnerToReview,
} = require('../lib/experiment-apply');

// ---------- fixtures ----------

const GOOD_PATCH = [
  'diff --git a/winner.txt b/winner.txt',
  'new file mode 100644',
  'index 0000000..2cf24d8',
  '--- /dev/null',
  '+++ b/winner.txt',
  '@@ -0,0 +1 @@',
  '+applied winner',
  '',
].join('\n');

// Modifies a file that does not exist in the repo — git apply --check fails.
const BAD_PATCH = [
  'diff --git a/missing.txt b/missing.txt',
  'index 2cf24d8..b6fc4c6 100644',
  '--- a/missing.txt',
  '+++ b/missing.txt',
  '@@ -1 +1 @@',
  '-old line that is not there',
  '+new line',
  '',
].join('\n');

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A tiny canonical repo with one committed file.
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-apply-repo-'));
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

// A workspace holding one experiment with two candidates.
function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-apply-ws-'));
  const exp = path.join(ws, '_experiments', 'exp-1');
  fs.mkdirSync(path.join(exp, 'candidates', 'cand-good'), { recursive: true });
  fs.mkdirSync(path.join(exp, 'candidates', 'cand-bad'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(exp, 'EXPERIMENT.md'), [
    '---',
    'experiment_id: "exp-1"',
    'task_type: "tl_spec"',
    'tl_spec: "specs/example/"',
    'base_commit: "abc123"',
    'status: "succeeded"',
    '---',
    '',
    '# exp-1',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(exp, 'candidates', 'cand-good', 'PATCH.diff'), GOOD_PATCH);
  fs.writeFileSync(path.join(exp, 'candidates', 'cand-good', 'FEEDBACK.md'), '# ok\n');
  fs.writeFileSync(path.join(exp, 'candidates', 'cand-bad', 'PATCH.diff'), BAD_PATCH);
  fs.writeFileSync(path.join(exp, 'candidates', 'cand-bad', 'FEEDBACK.md'), '# bad\n');
  return ws;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

const OPTS = { decidedBy: 'tester', now: new Date('2026-07-12T12:00:00Z') };

// ---------- dry-run check ----------

test('checkPatchApplies dry-run reports cleanly-applying vs failing patches without mutating', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  const before = repoSnapshot(repo);

  const good = checkPatchApplies(repo, path.join(ws, '_experiments', 'exp-1', 'candidates', 'cand-good', 'PATCH.diff'));
  const bad = checkPatchApplies(repo, path.join(ws, '_experiments', 'exp-1', 'candidates', 'cand-bad', 'PATCH.diff'));

  assert.equal(good.ok, true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /missing\.txt/);
  assert.deepEqual(repoSnapshot(repo), before); // dry-run never touches the tree
});

// ---------- apply success ----------

test('applyWinner applies the patch, records applied, and writes the review artifact', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();

  const result = applyWinner(ws, 'exp-1', 'cand-good', { ...OPTS, repoDir: repo });

  assert.equal(result.applied, true);
  assert.equal(result.state, 'applied');
  assert.equal(fs.readFileSync(path.join(repo, 'winner.txt'), 'utf8'), 'applied winner\n');

  const record = readWinnerRecord(ws, 'exp-1');
  assert.equal(record.state, 'applied');
  assert.equal(record.candidate_id, 'cand-good');
  assert.equal(record.decided_by, 'tester');
  assert.equal(record.decision_source, 'human');
  assert.equal(record.patch_path, '_experiments/exp-1/candidates/cand-good/PATCH.diff');
  assert.match(record.patch_sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.decided_at, '2026-07-12T12:00:00.000Z');

  // Append-only log row with task context from EXPERIMENT.md.
  const rows = readJsonl(path.join(ws, '_metrics', 'winner-log.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'applied');
  assert.equal(rows[0].tl_spec, 'specs/example/');
  assert.equal(rows[0].base_commit, 'abc123');

  // Review artifact points back to the experiment and candidate.
  const artifact = fs.readFileSync(path.join(ws, '_experiments', 'exp-1', 'APPLICATION.md'), 'utf8');
  assert.match(artifact, /experiment_id: "exp-1"/);
  assert.match(artifact, /candidate_id: "cand-good"/);
  assert.match(artifact, /state: "applied"/);
  assert.match(artifact, /_experiments\/exp-1\/candidates\/cand-good\//);
  assert.equal(record.review_artifact, '_experiments/exp-1/APPLICATION.md');

  // Re-applying an already-applied winner is refused.
  assert.throws(() => applyWinner(ws, 'exp-1', 'cand-good', { ...OPTS, repoDir: repo }), /already applied/);
});

// ---------- apply failure ----------

test('failed apply leaves canonical files unchanged and records apply-failed with the error', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  const before = repoSnapshot(repo);

  const result = applyWinner(ws, 'exp-1', 'cand-bad', { ...OPTS, repoDir: repo });

  assert.equal(result.applied, false);
  assert.equal(result.state, 'apply-failed');
  assert.deepEqual(repoSnapshot(repo), before); // canonical files untouched

  const record = readWinnerRecord(ws, 'exp-1');
  assert.equal(record.state, 'apply-failed');
  assert.match(record.error_summary, /missing\.txt/);

  const rows = readJsonl(path.join(ws, '_metrics', 'winner-log.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'apply-failed');
  assert.match(rows[0].error_summary, /missing\.txt/);

  // No review artifact for a failed application.
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-1', 'APPLICATION.md')), false);
});

// ---------- explicit human action only ----------

test('applyWinner refuses non-human decision sources — the explicit-human invariant', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  const before = repoSnapshot(repo);

  assert.throws(
    () => applyWinner(ws, 'exp-1', 'cand-good', { ...OPTS, repoDir: repo, decisionSource: 'agent' }),
    /only an explicit human action/,
  );
  assert.deepEqual(repoSnapshot(repo), before);
  assert.equal(readWinnerRecord(ws, 'exp-1'), null);
  assert.equal(fs.existsSync(path.join(ws, '_metrics', 'winner-log.jsonl')), false);

  // And every decision must name who took it.
  assert.throws(() => selectWinner(ws, 'exp-1', 'cand-good', {}), /decidedBy is required/);
});

// ---------- rejection ----------

test('rejectWinner records the reason and keeps candidate artifacts', () => {
  const ws = mkWorkspace();

  assert.throws(() => rejectWinner(ws, 'exp-1', 'cand-good', OPTS), /requires opts\.reason/);

  const record = rejectWinner(ws, 'exp-1', 'cand-good', { ...OPTS, reason: 'quality too low for the risk' });
  assert.equal(record.state, 'rejected');
  assert.equal(record.reason, 'quality too low for the risk');

  const rows = readJsonl(path.join(ws, '_metrics', 'winner-log.jsonl'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'rejected');
  assert.equal(rows[0].reason, 'quality too low for the risk');

  // Candidate artifacts are evidence — never deleted by a rejection.
  const dir = path.join(ws, '_experiments', 'exp-1', 'candidates', 'cand-good');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['FEEDBACK.md', 'PATCH.diff']);
});

// ---------- select and supersede ----------

test('selectWinner records selection; re-selecting a different candidate supersedes the first', () => {
  const ws = mkWorkspace();

  const first = selectWinner(ws, 'exp-1', 'cand-good', OPTS);
  assert.equal(first.state, 'selected');
  assert.equal(first.previous_state, null);

  const second = selectWinner(ws, 'exp-1', 'cand-bad', OPTS);
  assert.equal(second.state, 'selected');
  assert.equal(readWinnerRecord(ws, 'exp-1').candidate_id, 'cand-bad');

  const rows = readJsonl(path.join(ws, '_metrics', 'winner-log.jsonl'));
  assert.deepEqual(rows.map(r => [r.candidate_id, r.state]), [
    ['cand-good', 'selected'],
    ['cand-good', 'superseded'],
    ['cand-bad', 'selected'],
  ]);
  assert.equal(rows[1].reason, 'superseded by cand-bad');

  // Superseding never deletes the first candidate's artifacts.
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-1', 'candidates', 'cand-good', 'PATCH.diff')), true);
});

test('an applied winner cannot be silently superseded', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();

  applyWinner(ws, 'exp-1', 'cand-good', { ...OPTS, repoDir: repo });
  assert.throws(() => selectWinner(ws, 'exp-1', 'cand-bad', OPTS), /cannot be superseded automatically/);
  assert.equal(readWinnerRecord(ws, 'exp-1').candidate_id, 'cand-good');
});

// ---------- send to review ----------

test('sendWinnerToReview writes the review artifact without applying the patch', () => {
  const ws = mkWorkspace();

  const record = sendWinnerToReview(ws, 'exp-1', 'cand-good', OPTS);
  assert.equal(record.state, 'sent-to-review');
  assert.equal(record.review_artifact, '_experiments/exp-1/APPLICATION.md');

  const artifact = fs.readFileSync(path.join(ws, '_experiments', 'exp-1', 'APPLICATION.md'), 'utf8');
  assert.match(artifact, /state: "sent-to-review"/);
  assert.match(artifact, /has NOT been applied/);

  // A later rejection updates the existing artifact's state, deletes nothing.
  rejectWinner(ws, 'exp-1', 'cand-good', { ...OPTS, reason: 'review found a scope violation' });
  const updated = fs.readFileSync(path.join(ws, '_experiments', 'exp-1', 'APPLICATION.md'), 'utf8');
  assert.match(updated, /state: "rejected"/);
  assert.match(updated, /review found a scope violation/);
  assert.equal(fs.existsSync(path.join(ws, '_experiments', 'exp-1', 'candidates', 'cand-good', 'PATCH.diff')), true);
});

// ---------- guards ----------

test('actions validate ids, experiment, candidate, and patch presence', () => {
  const ws = mkWorkspace();

  assert.throws(() => selectWinner(ws, '../escape', 'cand-good', OPTS), /Invalid experiment id/);
  assert.throws(() => selectWinner(ws, 'exp-1', 'no/slash', OPTS), /Invalid candidate id/);
  assert.throws(() => selectWinner(ws, 'exp-missing', 'cand-good', OPTS), /Experiment not found/);
  assert.throws(() => selectWinner(ws, 'exp-1', 'cand-missing', OPTS), /Candidate not found/);

  // Empty patch cannot be selected/applied.
  fs.writeFileSync(path.join(ws, '_experiments', 'exp-1', 'candidates', 'cand-good', 'PATCH.diff'), '   \n');
  assert.throws(() => selectWinner(ws, 'exp-1', 'cand-good', OPTS), /patch is empty/);

  assert.deepEqual(WINNER_STATES, ['selected', 'applied', 'rejected', 'sent-to-review', 'apply-failed', 'superseded']);
});

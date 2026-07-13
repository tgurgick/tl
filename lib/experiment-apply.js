'use strict';

// Winner application — the explicit human-controlled path for applying,
// rejecting, or sending a winning experiment patch into normal TL review.
//
// Key invariant: candidate artifacts are evidence; only an explicit human
// action applies a winning candidate to the canonical repo. Nothing in this
// module runs automatically — every function is invoked by a human-run
// command (`tl experiment apply|reject|select|send-to-review`), and
// `applyWinner` additionally refuses any decision_source other than "human".
//
// Artifacts (all under the workspace, mirroring lib/experiment-fixture.js):
//   _experiments/<id>/WINNER.json      current winner/application state
//   _experiments/<id>/APPLICATION.md   review artifact pointing back at the
//                                      experiment + candidate (apply / review)
//   _metrics/winner-log.jsonl          append-only decision trail
//
// Patch application is dry-run first (`git apply --check`), so a failed apply
// leaves canonical files unchanged and records `apply-failed` with the error.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseFrontmatter } = require('./parse');

const WINNER_STATES = ['selected', 'applied', 'rejected', 'sent-to-review', 'apply-failed', 'superseded'];

// ---------- small shared helpers (same shapes as lib/experiment-fixture.js) ----------

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function datePart(iso) {
  return iso.slice(0, 10);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
}

function appendJsonl(file, row) {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

// ---------- id / path validation ----------

// Ids are single path segments — no separators, no traversal, no dotfiles.
function assertSegment(kind, id) {
  if (typeof id !== 'string' || !id.length || id.startsWith('.') || /[\\/]/.test(id)) {
    throw new Error(`Invalid ${kind}: ${JSON.stringify(id)} — must be a single folder-safe segment`);
  }
  return id;
}

function experimentDir(workspaceDir, experimentId) {
  assertSegment('experiment id', experimentId);
  const dir = path.join(workspaceDir, '_experiments', experimentId);
  if (!fs.existsSync(path.join(dir, 'EXPERIMENT.md')) && !fs.existsSync(dir)) {
    throw new Error(`Experiment not found: _experiments/${experimentId}/`);
  }
  return dir;
}

function candidateDir(workspaceDir, experimentId, candidateId) {
  assertSegment('candidate id', candidateId);
  const dir = path.join(experimentDir(workspaceDir, experimentId), 'candidates', candidateId);
  if (!fs.existsSync(dir)) {
    throw new Error(`Candidate not found: _experiments/${experimentId}/candidates/${candidateId}/`);
  }
  return dir;
}

// EXPERIMENT.md frontmatter, tolerated missing — log rows carry task context
// (tl_spec, base_commit) when the index exists, empty strings when it doesn't.
function readExperimentMeta(workspaceDir, experimentId) {
  try {
    const text = fs.readFileSync(path.join(workspaceDir, '_experiments', experimentId, 'EXPERIMENT.md'), 'utf8');
    return parseFrontmatter(text).meta || {};
  } catch {
    return {};
  }
}

// ---------- winner record ----------

function winnerFile(workspaceDir, experimentId) {
  return path.join(workspaceDir, '_experiments', experimentId, 'WINNER.json');
}

function readWinnerRecord(workspaceDir, experimentId) {
  assertSegment('experiment id', experimentId);
  try {
    return JSON.parse(fs.readFileSync(winnerFile(workspaceDir, experimentId), 'utf8'));
  } catch {
    return null;
  }
}

// Candidate patch info. `required` = the action needs a non-empty PATCH.diff.
function patchInfo(workspaceDir, experimentId, candidateId, required) {
  const dir = candidateDir(workspaceDir, experimentId, candidateId);
  const abs = path.join(dir, 'PATCH.diff');
  const rel = `_experiments/${experimentId}/candidates/${candidateId}/PATCH.diff`;
  if (!fs.existsSync(abs)) {
    if (required) throw new Error(`Candidate has no PATCH.diff: ${rel}`);
    return { patch_path: null, patch_sha256: null, abs: null };
  }
  const text = fs.readFileSync(abs, 'utf8');
  if (required && !text.trim().length) throw new Error(`Candidate patch is empty: ${rel}`);
  return { patch_path: rel, patch_sha256: sha256(text), abs };
}

// ---------- decision recording (WINNER.json + append-only log) ----------

function logRow(workspaceDir, experimentId, record, decidedAt) {
  const meta = readExperimentMeta(workspaceDir, experimentId);
  appendJsonl(path.join(workspaceDir, '_metrics', 'winner-log.jsonl'), {
    date: datePart(decidedAt),
    experiment_id: experimentId,
    tl_spec: meta.tl_spec || '',
    base_commit: meta.base_commit || '',
    candidate_id: record.candidate_id,
    state: record.state,
    previous_state: record.previous_state,
    decided_by: record.decided_by,
    decision_source: record.decision_source,
    decided_at: record.decided_at,
    patch_path: record.patch_path,
    patch_sha256: record.patch_sha256,
    reason: record.reason,
    error_summary: record.error_summary,
    review_artifact: record.review_artifact,
  });
}

// Write the new current-state record. If an earlier decision names a different
// candidate, that decision is superseded first (append-only row; artifacts are
// never deleted). An applied record cannot be silently superseded.
function recordDecision(workspaceDir, experimentId, next) {
  const prev = readWinnerRecord(workspaceDir, experimentId);
  if (prev && prev.candidate_id !== next.candidate_id) {
    if (prev.state === 'applied') {
      throw new Error(`Winner ${prev.candidate_id} is already applied for ${experimentId} — an applied decision cannot be superseded automatically; revert it in the repo first.`);
    }
    logRow(workspaceDir, experimentId, {
      ...prev,
      state: 'superseded',
      previous_state: prev.state,
      decided_by: next.decided_by,
      decision_source: next.decision_source,
      decided_at: next.decided_at,
      reason: `superseded by ${next.candidate_id}`,
    }, next.decided_at);
    next.previous_state = null;
  } else {
    next.previous_state = prev ? prev.state : null;
  }
  writeFile(winnerFile(workspaceDir, experimentId), JSON.stringify(next, null, 2) + '\n');
  logRow(workspaceDir, experimentId, next, next.decided_at);
  return next;
}

function baseRecord(experimentId, candidateId, patch, opts) {
  const decidedBy = opts.decidedBy;
  if (typeof decidedBy !== 'string' || !decidedBy.trim().length) {
    throw new Error('decidedBy is required — every winner decision must name who took it');
  }
  return {
    experiment_id: experimentId,
    candidate_id: candidateId,
    state: null,
    previous_state: null,
    decided_by: decidedBy.trim(),
    decision_source: opts.decisionSource || 'human',
    decided_at: isoNow(opts.now),
    patch_path: patch.patch_path,
    patch_sha256: patch.patch_sha256,
    reason: null,
    error_summary: null,
    review_artifact: null,
  };
}

// ---------- review artifact ----------

function reviewArtifactRel(experimentId) {
  return `_experiments/${experimentId}/APPLICATION.md`;
}

function writeReviewArtifact(workspaceDir, experimentId, record) {
  const meta = readExperimentMeta(workspaceDir, experimentId);
  const rel = reviewArtifactRel(experimentId);
  writeFile(path.join(workspaceDir, rel), [
    '---',
    `experiment_id: "${experimentId}"`,
    `candidate_id: "${record.candidate_id}"`,
    `state: "${record.state}"`,
    `decided_by: "${record.decided_by}"`,
    `decision_source: "${record.decision_source}"`,
    `decided_at: "${record.decided_at}"`,
    `tl_spec: "${meta.tl_spec || ''}"`,
    `base_commit: "${meta.base_commit || ''}"`,
    `patch_path: "${record.patch_path || ''}"`,
    `patch_sha256: "${record.patch_sha256 || ''}"`,
    '---',
    '',
    `# Winner application: ${experimentId} / ${record.candidate_id}`,
    '',
    `State: \`${record.state}\`. This artifact points normal TL review back at the evidence:`,
    '',
    `- Experiment index: \`_experiments/${experimentId}/EXPERIMENT.md\``,
    `- Winning candidate: \`_experiments/${experimentId}/candidates/${record.candidate_id}/\` (patch, feedback, metrics, trace)`,
    `- Judge evaluation: \`_experiments/${experimentId}/evaluation/\``,
    `- Decision trail: \`_metrics/winner-log.jsonl\``,
    '',
    record.state === 'applied'
      ? 'The patch has been applied to the canonical repo working tree. Normal TL review still owns acceptance: review the applied diff exactly like any other in-review change before anything moves toward done.'
      : record.state === 'rejected'
        ? `This winner was rejected without applying its patch. Reason: ${record.reason || '(none recorded)'}. Candidate artifacts are retained as evidence.`
        : 'The patch has NOT been applied. It is handed to normal TL review as a proposal: a reviewer applies it (or kicks it back) through the ordinary review flow.',
    '',
  ].join('\n'));
  return rel;
}

// ---------- dry-run patch check ----------

function summarizeGitError(r) {
  const text = String((r.stderr || '') + (r.stdout || '')).trim() || (r.error ? String(r.error.message) : 'git apply failed');
  return text.split('\n').slice(0, 3).join(' | ').slice(0, 400);
}

// Dry-run: would this patch apply cleanly to repoDir? Never mutates anything.
function checkPatchApplies(repoDir, patchAbs) {
  const r = spawnSync('git', ['apply', '--check', patchAbs], { cwd: repoDir, encoding: 'utf8' });
  return r.status === 0 ? { ok: true, error: null } : { ok: false, error: summarizeGitError(r) };
}

// ---------- actions ----------

// Record that a human selected this candidate as the winner. No patch is
// applied; this is the legible "which winner, chosen by whom, when" step.
function selectWinner(workspaceDir, experimentId, candidateId, opts = {}) {
  const patch = patchInfo(workspaceDir, experimentId, candidateId, true);
  const record = baseRecord(experimentId, candidateId, patch, opts);
  record.state = 'selected';
  return recordDecision(workspaceDir, experimentId, record);
}

// Apply the selected candidate's PATCH.diff to the canonical repo. This is
// the explicit apply action — dry-run checked first, human-only by contract.
function applyWinner(workspaceDir, experimentId, candidateId, opts = {}) {
  const repoDir = opts.repoDir;
  if (!repoDir || !fs.existsSync(repoDir)) {
    throw new Error('applyWinner requires opts.repoDir — the canonical repo to apply the patch to');
  }
  const patch = patchInfo(workspaceDir, experimentId, candidateId, true);
  const record = baseRecord(experimentId, candidateId, patch, opts);
  if (record.decision_source !== 'human') {
    throw new Error('Refusing to apply: only an explicit human action applies a winning candidate (decision_source must be "human")');
  }
  const prev = readWinnerRecord(workspaceDir, experimentId);
  if (prev && prev.candidate_id === candidateId && prev.state === 'applied') {
    throw new Error(`Winner ${candidateId} is already applied for ${experimentId}`);
  }

  // Dry-run first, then apply. Either failure leaves canonical files
  // unchanged (`git apply` validates before touching the tree) and records
  // `apply-failed` with the error summary.
  const dryRun = checkPatchApplies(repoDir, patch.abs);
  let failure = dryRun.ok ? null : dryRun.error;
  if (!failure) {
    const r = spawnSync('git', ['apply', patch.abs], { cwd: repoDir, encoding: 'utf8' });
    if (r.status !== 0) failure = summarizeGitError(r);
  }

  if (failure) {
    record.state = 'apply-failed';
    record.error_summary = failure;
    recordDecision(workspaceDir, experimentId, record);
    return { ...record, applied: false };
  }

  record.state = 'applied';
  record.review_artifact = writeReviewArtifact(workspaceDir, experimentId, record);
  recordDecision(workspaceDir, experimentId, record);
  return { ...record, applied: true };
}

// Reject a winner: record the reason, keep every candidate artifact.
function rejectWinner(workspaceDir, experimentId, candidateId, opts = {}) {
  if (typeof opts.reason !== 'string' || !opts.reason.trim().length) {
    throw new Error('rejectWinner requires opts.reason — rejections must record why');
  }
  const patch = patchInfo(workspaceDir, experimentId, candidateId, false);
  const record = baseRecord(experimentId, candidateId, patch, opts);
  record.state = 'rejected';
  record.reason = opts.reason.trim();
  // Update the review artifact only if one already exists — a rejection never
  // deletes evidence, it just flips the visible state.
  if (fs.existsSync(path.join(workspaceDir, reviewArtifactRel(experimentId)))) {
    record.review_artifact = writeReviewArtifact(workspaceDir, experimentId, record);
  }
  return recordDecision(workspaceDir, experimentId, record);
}

// Hand the winning patch to normal TL review as a proposal, without applying.
function sendWinnerToReview(workspaceDir, experimentId, candidateId, opts = {}) {
  const patch = patchInfo(workspaceDir, experimentId, candidateId, true);
  const record = baseRecord(experimentId, candidateId, patch, opts);
  record.state = 'sent-to-review';
  record.review_artifact = writeReviewArtifact(workspaceDir, experimentId, record);
  return recordDecision(workspaceDir, experimentId, record);
}

module.exports = {
  WINNER_STATES,
  readWinnerRecord,
  checkPatchApplies,
  selectWinner,
  applyWinner,
  rejectWinner,
  sendWinnerToReview,
};

'use strict';

// Experiment judge — executes ONE claimed judge queue row headlessly and
// lands the verdict per the shipped schema, so a shadow experiment completes
// end-to-end without a human driving the judge step.
//
// Contract (rubric: _patterns/experiment-judge.md; schema: _templates/SCHEMA.md):
//   _experiments/<id>/evaluation/<judge_id>/EVALUATION.md    the comparison
//   _experiments/<id>/evaluation/<judge_id>/SCORES.json      machine verdict
//   _experiments/<id>/evaluation/<judge_id>/JUDGE-BRIEF.md   lane-agnostic
//       brief for the rubric dimensions that need MODEL judgment — any lane's
//       agent (or a human via skills/experiment-judge) can pick it up and
//       refine the deterministic baseline; the interactive skill path stays
//       valid.
//   _metrics/judge-log.jsonl                                 one append-only row
//
// Split of labor, per the rubric:
//   - Deterministic checks run IN CODE here: artifact completeness
//     (valid_output), patch applies cleanly against base_commit (in an
//     isolated worktree — the canonical repo is never mutated), and tests
//     pass when a test command is configured (else "declared unavailable",
//     recorded honestly as null, which does not fail the gate).
//   - Model-judgment dimensions get a deterministic BASELINE score anchored
//     to observable evidence, are listed in `model_judgment_pending`, and are
//     laid out in JUDGE-BRIEF.md for any lane to refine.
//
// Safety invariants:
//   - The judge is an EVALUATOR. It reads candidate artifacts and writes only
//     under evaluation/ and _metrics/. Candidates and the canonical repo stay
//     byte-untouched (patch checks run in throwaway isolated worktrees).
//   - A configured test command executes the candidate's PATCHED code on this
//     host. The throwaway worktree is an isolated checkout, NOT a security
//     sandbox — filesystem read, network, and host access remain. Setting
//     --test-command is therefore an explicit trust decision, and the command
//     always runs with a scrubbed environment (lib/env-policy.js) so ambient
//     credentials never reach candidate-authored code. No test command
//     configured = nothing executes (declared unavailable — fails closed).
//   - Judges never apply winners — this module must not import
//     lib/experiment-apply.js (a test enforces it); winner application stays
//     an explicit human CLI action.
//   - No half-written evaluations: all artifacts are staged in a temp dir and
//     land via a single rename; a mid-run failure removes the staging dir and
//     reports a fault so the queue row can record it and release the claim.
//
// Node stdlib only; zero dependencies.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createIsolatedWorkdir, removeIsolatedWorkdir } = require('./experiment-runner');
const { scrubEnvironment } = require('./env-policy');
// experiment-queue lazy-requires this module inside drainQueue, so a
// top-level require here never cycles at load time.
const { readQueueRows, readExperimentMeta, setExperimentStatus } = require('./experiment-queue');

// Starting default weights from the rubric — configurable per experiment
// later; a verdict is only reproducible if the weights used are recorded.
const DEFAULT_UTILITY_WEIGHTS = {
  quality: 1.0,
  cost_penalty: 0.2,
  latency_penalty: 0.1,
  feedback_penalty: 0.2,
  failure_penalty: 0.3,
  scope_penalty: 0.2,
};

// The rubric dimensions a deterministic judge can only baseline, not settle.
// test_quality and explanation_quality have direct observable evidence
// (test run result, FEEDBACK.md substance); these four need model judgment.
const MODEL_JUDGMENT_DIMENSIONS = ['correctness', 'completeness', 'scope_discipline', 'maintainability'];

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function datePart(iso) {
  return iso.slice(0, 10);
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// ---------- deterministic hard-gate checks ----------

// Gate: patch applies cleanly at base_commit, checked in an isolated
// worktree/clone so the canonical repo working tree is never touched. When a
// test command is configured, the patch is then actually applied INSIDE the
// throwaway workdir and the command runs there — tests_pass true/false.
// Returns { patch_applies, tests_pass, note } where null means "unchecked /
// declared unavailable" (no repo to check against, or no test command) —
// null never fails a gate, but it is recorded honestly.
function checkPatchInIsolation(workspaceDir, row, meta, patch, opts = {}) {
  const config = row.config || {};
  const repo = config.repo ? path.resolve(config.repo)
    : opts.repoDir ? path.resolve(opts.repoDir) : null;
  if (!repo || !fs.existsSync(path.join(repo, '.git'))) {
    return { patch_applies: null, tests_pass: null, note: 'no repo available for patch-apply check' };
  }
  const workdir = path.join(workspaceDir, '_experiments', row.experiment_id, 'work', `judge--${row.candidate_id}`);
  const iso = createIsolatedWorkdir(repo, meta.base_commit || 'unknown', workdir);
  if (!iso.ok) {
    return { patch_applies: null, tests_pass: null, note: `could not create isolated workdir: ${iso.error}` };
  }
  try {
    const patchFile = workdir + '.judge-patch.diff';
    fs.writeFileSync(patchFile, patch);
    try {
      const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', patchFile], { cwd: workdir, encoding: 'utf8' });
      if (check.status !== 0) {
        return { patch_applies: false, tests_pass: null, note: `git apply --check failed: ${String(check.stderr || '').trim().slice(0, 200)}` };
      }
      const testCommand = opts.testCommand ? String(opts.testCommand) : null;
      if (!testCommand) return { patch_applies: true, tests_pass: null, note: 'no test command configured — tests declared unavailable' };

      const applied = spawnSync('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: workdir, encoding: 'utf8' });
      if (applied.status !== 0) {
        return { patch_applies: false, tests_pass: null, note: `git apply failed after a clean --check: ${String(applied.stderr || '').trim().slice(0, 200)}` };
      }
      const timeoutMs = row.timeout_minutes != null && Number.isFinite(+row.timeout_minutes)
        ? Math.max(1, Math.round(+row.timeout_minutes * 60000)) : 10 * 60000;
      // Trust boundary: the test command runs the CANDIDATE'S PATCHED CODE on
      // this host — the worktree isolates the checkout, not the machine.
      // Configuring --test-command is the explicit trust decision to run it;
      // the environment is scrubbed regardless (lib/env-policy.js), so no
      // ambient credential reaches candidate-authored code.
      const t = spawnSync('/bin/sh', ['-c', testCommand], { cwd: workdir, encoding: 'utf8', timeout: timeoutMs, env: scrubEnvironment(process.env) });
      const pass = !t.error && t.status === 0;
      return {
        patch_applies: true,
        tests_pass: pass,
        note: pass ? `tests passed: ${testCommand.slice(0, 120)}`
          : `tests failed (${t.error ? t.error.message : 'exit ' + t.status}): ${testCommand.slice(0, 120)}`,
      };
    } finally {
      try { fs.rmSync(patchFile, { force: true }); } catch { /* best effort */ }
    }
  } finally {
    removeIsolatedWorkdir(repo, workdir, iso.mode);
  }
}

// Evaluate one candidate deterministically: gates, baseline scores, utility
// inputs. Never writes anything — pure evidence collection over the
// candidate's artifact folder plus its (already terminal) queue row.
function evaluateCandidate(workspaceDir, row, meta, opts = {}) {
  const dir = path.join(workspaceDir, '_experiments', row.experiment_id, 'candidates', row.candidate_id);
  const patch = readIfExists(path.join(dir, 'PATCH.diff'));
  const feedback = readIfExists(path.join(dir, 'FEEDBACK.md'));
  let metrics = null;
  try { metrics = JSON.parse(fs.readFileSync(path.join(dir, 'METRICS.json'), 'utf8')); } catch { /* recorded below */ }

  // A non-terminal row reaching the judge (forced partial evaluation) is
  // `unavailable` per the rubric: the runtime/worker never ran to completion.
  const fault = row.status === 'succeeded' ? null
    : (row.fault || (metrics && metrics.fault)
      || (row.status === 'queued' || row.status === 'running' ? 'unavailable' : row.status));
  const notes = [];

  // Gate: valid output — artifact completeness, parseable metrics, a
  // succeeded terminal run, and a non-empty patch.
  const validOutput = Boolean(
    row.status === 'succeeded' && !fault
    && patch !== null && patch.trim().length > 0
    && feedback !== null && metrics && metrics.status === 'succeeded'
  );
  if (!validOutput) {
    notes.push(fault ? `run faulted: ${fault}` : 'artifacts incomplete or unparseable');
  }

  // Gates: patch applies + tests pass — only meaningful on valid output.
  let patchApplies = null;
  let testsPass = null;
  let gateFault = fault;
  if (validOutput) {
    const check = checkPatchInIsolation(workspaceDir, row, meta, patch, opts);
    patchApplies = check.patch_applies;
    testsPass = check.tests_pass;
    if (check.note) notes.push(check.note);
    // Rubric: a patch that won't apply is `invalid_output`, not a low score.
    if (patchApplies === false) gateFault = 'invalid_output';
  }

  const gates = { valid_output: validOutput, patch_applies: patchApplies, tests_pass: testsPass };
  // null = unchecked/declared unavailable, which does not fail the gate.
  const hardGatesPassed = validOutput && patchApplies !== false && testsPass !== false;

  // Deterministic BASELINE scores, anchored to observable evidence. The four
  // MODEL_JUDGMENT_DIMENSIONS are proxies pending a model/human pass (see
  // JUDGE-BRIEF.md); test_quality and explanation_quality have direct evidence.
  const taskComplete = Boolean(metrics && metrics.task_complete === true);
  const feedbackSubstance = feedback ? feedback.trim().length : 0;
  const scores = hardGatesPassed
    ? {
        correctness: testsPass === true ? 5 : taskComplete ? 4 : 3,
        completeness: taskComplete ? 4 : 3,
        scope_discipline: 3,
        maintainability: 3,
        test_quality: testsPass === true ? 4 : testsPass === false ? 1 : 2,
        explanation_quality: feedbackSubstance > 200 ? 4 : feedbackSubstance > 80 ? 3 : feedbackSubstance > 0 ? 2 : 1,
      }
    : {
        correctness: patchApplies === false ? 1 : 2,
        completeness: 2,
        scope_discipline: 3,
        maintainability: 3,
        test_quality: testsPass === false ? 1 : 2,
        explanation_quality: feedbackSubstance > 80 ? 3 : feedbackSubstance > 0 ? 2 : 1,
      };

  return {
    candidate_id: row.candidate_id,
    role: row.role,
    hard_gates_passed: hardGatesPassed,
    fault: hardGatesPassed ? null : gateFault,
    gates,
    scores,
    notes,
    cost_usd: metrics && Number.isFinite(+metrics.cost_usd) ? +metrics.cost_usd : 0,
    duration_minutes: metrics && Number.isFinite(+metrics.duration_minutes) ? +metrics.duration_minutes : 0,
    attempt: Number(row.attempt) || 0,
  };
}

// ---------- utility + winner selection ----------

// Utility: quality minus normalized soft penalties, per the rubric shape.
// Penalties separate eligible candidates; a hard-gate failure is not a
// penalty — it removes eligibility entirely.
function computeUtility(ev, row, weights) {
  const w = { ...DEFAULT_UTILITY_WEIGHTS, ...weights };
  const scoreValues = Object.values(ev.scores);
  const quality = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
  const budget = Number.isFinite(+row.budget_usd) && +row.budget_usd > 0 ? +row.budget_usd : 1;
  const timeout = Number.isFinite(+row.timeout_minutes) && +row.timeout_minutes > 0 ? +row.timeout_minutes : 60;
  const penalties = {
    cost_penalty: w.cost_penalty * Math.min(1, ev.cost_usd / budget),
    latency_penalty: w.latency_penalty * Math.min(1, ev.duration_minutes / timeout),
    feedback_penalty: w.feedback_penalty * ((5 - ev.scores.explanation_quality) / 4),
    failure_penalty: w.failure_penalty * Math.min(1, Math.max(0, ev.attempt - 1) / 3),
    scope_penalty: 0, // deterministic pass has no scope-churn evidence yet
  };
  const utility = round2(w.quality * quality - Object.values(penalties).reduce((a, b) => a + b, 0));
  return { utility, quality: round2(quality), penalties };
}

// Winner among ELIGIBLE candidates, tie-breaks in rubric order:
// hard-gate pass beats fail (only eligible enter); higher utility; lower
// review burden (feedback penalty); lower cost; then a human decides.
function selectJudgeWinner(evaluations) {
  const eligible = evaluations.filter(e => e.hard_gates_passed);
  if (!eligible.length) {
    return { winner: null, rationale: 'No candidate passed the hard gates — no winner; faults and scores are retained as learning data.' };
  }
  const ranked = [...eligible].sort((a, b) =>
    b.utility - a.utility
    || a.penalties.feedback_penalty - b.penalties.feedback_penalty
    || a.cost_usd - b.cost_usd);
  const [top, next] = ranked;
  if (next
    && top.utility === next.utility
    && top.penalties.feedback_penalty === next.penalties.feedback_penalty
    && top.cost_usd === next.cost_usd) {
    return { winner: null, rationale: `Genuine tie between ${top.candidate_id} and ${next.candidate_id} past every tie-break — a human decides.` };
  }
  return {
    winner: top.candidate_id,
    rationale: `${top.candidate_id} passed all hard gates with the highest utility (${top.utility})${next ? ` over ${next.candidate_id} (${next.utility})` : ' as the only eligible candidate'}.`,
  };
}

// ---------- artifact rendering ----------

function gateLabel(v) {
  return v === true ? 'pass' : v === false ? 'FAIL' : 'unchecked';
}

function renderEvaluation(meta, row, evaluations, verdict, weights, created) {
  const lines = [
    `# Evaluation: ${row.experiment_id}`,
    '',
    `- Judge: \`${row.candidate_id}\` (lane \`${row.agent_tool}\`, model \`deterministic\`) — headless drain pass, ${created}`,
    `- Task: \`${meta.tl_spec || '(fixture)'}\` at base \`${meta.base_commit || 'unknown'}\``,
    `- Winner: ${verdict.winner ? `\`${verdict.winner}\`` : '**none — human decides**'}`,
    meta.self_judge === true ? '- `self_judge: true` — flagged: a self-judged winner is weaker evidence.' : null,
    '',
    `> ${verdict.rationale}`,
    '',
    '## Hard gates',
    '',
    '| Candidate | valid_output | patch_applies | tests_pass | eligible | fault |',
    '|-----------|--------------|---------------|------------|----------|-------|',
    ...evaluations.map(e =>
      `| \`${e.candidate_id}\` | ${gateLabel(e.gates.valid_output)} | ${gateLabel(e.gates.patch_applies)} | ${gateLabel(e.gates.tests_pass)} | ${e.hard_gates_passed ? 'yes' : 'no'} | ${e.fault || '—'} |`),
    '',
    '`unchecked` means declared unavailable (no repo or no test command) — recorded honestly, never a silent pass-off as green.',
    '',
    '## Scores and utility (deterministic baseline)',
    '',
    '| Candidate | correctness | completeness | scope_discipline | maintainability | test_quality | explanation_quality | utility |',
    '|-----------|-------------|--------------|------------------|-----------------|--------------|---------------------|---------|',
    ...evaluations.map(e =>
      `| \`${e.candidate_id}\` | ${e.scores.correctness} | ${e.scores.completeness} | ${e.scores.scope_discipline} | ${e.scores.maintainability} | ${e.scores.test_quality} | ${e.scores.explanation_quality} | ${e.utility} |`),
    '',
    `Model-judgment dimensions (${MODEL_JUDGMENT_DIMENSIONS.join(', ')}) carry deterministic baselines pending a model/human pass — see \`JUDGE-BRIEF.md\` in this folder. Faulted candidates are scored non-winning and retained as learning data.`,
    '',
    '## Utility weights used',
    '',
    '```json',
    JSON.stringify(weights, null, 2),
    '```',
    '',
    '## Notes per candidate',
    '',
    ...evaluations.map(e => `- \`${e.candidate_id}\`: ${e.notes.length ? e.notes.join('; ') : 'no deterministic findings beyond the gates.'}`),
    '',
    'A winner is a **nomination**, not an application — apply/reject stays an explicit human action (`tl experiment select|apply|reject|send-to-review`).',
    '',
  ];
  return lines.filter(l => l !== null).join('\n');
}

// The lane-agnostic brief: everything a model judge in ANY lane (or a human
// running skills/experiment-judge) needs to refine the model-judgment
// dimensions without this process's context.
function renderJudgeBrief(meta, row, evaluations, created) {
  return [
    `# Judge brief: ${row.experiment_id}`,
    '',
    `Deterministic checks ran headlessly on ${created}. The dimensions below need model judgment: score each 1–5 per \`_patterns/experiment-judge.md\`, anchored to the diff and trace — never to prose confidence. Any lane may pick this up: run \`skills/experiment-judge/SKILL.md\` against this experiment and supersede \`SCORES.json\`/\`EVALUATION.md\` in a new \`evaluation/<judge_id>/\` folder (append a new \`judge-log.jsonl\` line; never rewrite this one).`,
    '',
    '## Task contract',
    '',
    `- Spec: \`${meta.tl_spec || '(fixture task — see EXPERIMENT.md body)'}\``,
    `- Spec hash: \`${meta.spec_hash || 'unknown'}\` · base commit: \`${meta.base_commit || 'unknown'}\``,
    `- Primary: \`${meta.primary_agent || 'unknown'}\` · judge must differ unless \`self_judge: true\`${meta.self_judge === true ? ' (it is — flag the weaker evidence)' : ''}`,
    '',
    '## Dimensions needing model judgment',
    '',
    ...MODEL_JUDGMENT_DIMENSIONS.map(d => `- \`${d}\` — deterministic baseline only; re-anchor to the evidence below`),
    '',
    '## Evidence per candidate',
    '',
    ...evaluations.flatMap(e => [
      `### \`${e.candidate_id}\` (${e.role})${e.fault ? ` — fault: \`${e.fault}\`` : ''}`,
      '',
      `- Gates: valid_output ${gateLabel(e.gates.valid_output)}, patch_applies ${gateLabel(e.gates.patch_applies)}, tests_pass ${gateLabel(e.gates.tests_pass)}`,
      `- \`candidates/${e.candidate_id}/PATCH.diff\` — judge the diff, not the self-report`,
      `- \`candidates/${e.candidate_id}/FEEDBACK.md\` — a claim to verify`,
      `- \`candidates/${e.candidate_id}/METRICS.json\` · \`candidates/${e.candidate_id}/TRACE.jsonl\``,
      '',
    ]),
    'Judging is read-only over candidates and the canonical repo; a refined verdict writes only under `evaluation/` and `_metrics/`.',
    '',
  ].join('\n');
}

// ---------- runJudge: execute one CLAIMED judge row ----------

// Executes a claimed judge queue row end-to-end. Returns
// { status: 'succeeded'|'failed', winner, reason, evaluationDir }.
// Never throws for expected failures; never leaves a partial evaluation —
// artifacts stage in a temp dir and land via one rename, and the judge-log
// line is appended only after the rename.
function runJudge(workspaceDir, row, opts = {}) {
  const startedAt = Date.now();
  const created = isoNow(opts.now);
  const expDir = path.join(workspaceDir, '_experiments', row.experiment_id);
  const judgeId = row.candidate_id;
  const evalRoot = path.join(expDir, 'evaluation');
  const finalDir = path.join(evalRoot, judgeId);
  const tmpDir = path.join(evalRoot, `.tmp-${judgeId}-${row.attempt || 0}`);

  try {
    const meta = readExperimentMeta(workspaceDir, row.experiment_id);

    // Different-eyes discipline: the judge must not be the primary candidate
    // unless the experiment explicitly allows self_judge.
    if (meta.primary_agent && String(meta.primary_agent) === String(judgeId) && meta.self_judge !== true) {
      return { status: 'failed', winner: null, reason: `judge "${judgeId}" is the primary candidate and self_judge is not set`, evaluationDir: null };
    }

    const candidateRows = (opts.candidateRows
      || readQueueRows(workspaceDir).filter(r => r.experiment_id === row.experiment_id))
      .filter(r => r.role !== 'judge');
    if (!candidateRows.length) {
      return { status: 'failed', winner: null, reason: 'no candidate rows to judge', evaluationDir: null };
    }

    // Deterministic evaluation — read-only over candidates and repo.
    const weights = { ...DEFAULT_UTILITY_WEIGHTS, ...(opts.utilityWeights || {}) };
    const evaluations = candidateRows
      .sort((a, b) => String(a.candidate_id).localeCompare(String(b.candidate_id)))
      .map(r => {
        const ev = evaluateCandidate(workspaceDir, r, meta, opts);
        return { ...ev, ...computeUtility(ev, r, weights) };
      });
    const verdict = selectJudgeWinner(evaluations);
    const winnerEval = verdict.winner ? evaluations.find(e => e.candidate_id === verdict.winner) : null;

    const scoresPayload = {
      judge_id: judgeId,
      judge_agent: row.agent_tool,
      judge_model: 'deterministic',
      status: 'succeeded',
      self_judge: meta.self_judge === true,
      winner: verdict.winner,
      winner_set_by: 'judge',
      rationale: verdict.rationale,
      utility_weights: weights,
      scored_by: 'deterministic',
      model_judgment_pending: MODEL_JUDGMENT_DIMENSIONS,
      brief_path: `_experiments/${row.experiment_id}/evaluation/${judgeId}/JUDGE-BRIEF.md`,
      candidates: Object.fromEntries(evaluations.map(e => [e.candidate_id, {
        hard_gates_passed: e.hard_gates_passed,
        fault: e.fault,
        gates: e.gates,
        scores: e.scores,
        utility: e.utility,
        cost_usd: e.cost_usd,
        duration_minutes: e.duration_minutes,
      }])),
    };

    // Stage everything, then land it with one rename — never half-written.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    writeFile(path.join(tmpDir, 'SCORES.json'), JSON.stringify(scoresPayload, null, 2) + '\n');
    writeFile(path.join(tmpDir, 'EVALUATION.md'), renderEvaluation(meta, row, evaluations, verdict, weights, created));
    writeFile(path.join(tmpDir, 'JUDGE-BRIEF.md'), renderJudgeBrief(meta, row, evaluations, created));
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);

    appendJsonl(path.join(workspaceDir, '_metrics', 'judge-log.jsonl'), {
      date: datePart(created),
      experiment_id: row.experiment_id,
      judge_id: judgeId,
      judge_agent: row.agent_tool,
      judge_model: 'deterministic',
      status: 'succeeded',
      winner: verdict.winner,
      winner_set_by: 'judge',
      rationale: verdict.rationale,
      scores_path: `_experiments/${row.experiment_id}/evaluation/${judgeId}/SCORES.json`,
      evaluation_path: `_experiments/${row.experiment_id}/evaluation/${judgeId}/EVALUATION.md`,
      utility: winnerEval ? winnerEval.utility : null,
      hard_gates_passed: winnerEval ? winnerEval.hard_gates_passed : false,
      duration_minutes: round2((Date.now() - startedAt) / 60000),
      cost_usd: 0,
      tokens_used: 0,
    });

    setExperimentStatus(workspaceDir, row.experiment_id,
      verdict.winner ? 'succeeded' : 'failed',
      verdict.winner ? `judge ${judgeId} selected ${verdict.winner}` : `judge ${judgeId} found no eligible winner — ${verdict.rationale}`,
      opts.now);

    return { status: 'succeeded', winner: verdict.winner, reason: verdict.rationale, evaluationDir: finalDir };
  } catch (e) {
    // Mid-run failure: remove any staging, report the fault. The caller
    // (drainQueue) marks the row and releases the claim — the experiment
    // stays awaiting_evaluation, and no partial evaluation exists.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { status: 'failed', winner: null, reason: `judge run failed: ${String(e.message).slice(0, 300)}`, evaluationDir: null };
  }
}

module.exports = {
  DEFAULT_UTILITY_WEIGHTS,
  MODEL_JUDGMENT_DIMENSIONS,
  evaluateCandidate,
  computeUtility,
  selectJudgeWinner,
  runJudge,
};

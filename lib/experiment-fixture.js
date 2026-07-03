'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function gitBaseCommit(cwd) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

const FIXTURE_TASK = [
  '# Fixture Task',
  '',
  '## Objective',
  '',
  'Produce a tiny patch artifact and feedback report for the experiment fixture.',
  '',
  '## Acceptance criteria',
  '',
  '- Candidate writes a non-empty patch.',
  '- Candidate feedback states whether the task is complete.',
].join('\n');

const CANDIDATES = [
  {
    id: 'fixture-a',
    role: 'primary',
    complete: true,
    patch: [
      'diff --git a/fixture.txt b/fixture.txt',
      'new file mode 100644',
      'index 0000000..2cf24d8',
      '--- /dev/null',
      '+++ b/fixture.txt',
      '@@ -0,0 +1 @@',
      '+fixture winner',
      '',
    ].join('\n'),
    feedback: [
      '# Feedback: fixture-a',
      '',
      'Completed the fixture task. The patch is non-empty and the task is marked complete.',
      '',
    ].join('\n'),
  },
  {
    id: 'fixture-b',
    role: 'shadow',
    complete: false,
    patch: [
      'diff --git a/fixture.txt b/fixture.txt',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/fixture.txt',
      '@@ -0,0 +1 @@',
      '+fixture incomplete',
      '',
    ].join('\n'),
    feedback: [
      '# Feedback: fixture-b',
      '',
      'Produced a non-empty patch, but did not mark the fixture task complete.',
      '',
    ].join('\n'),
  },
];

function writeCandidate(workspaceDir, experimentId, baseCommit, created, candidate) {
  const dir = path.join(workspaceDir, '_experiments', experimentId, 'candidates', candidate.id);
  const metrics = {
    candidate_id: candidate.id,
    role: candidate.role,
    status: 'succeeded',
    agent_tool: 'fixture',
    agent_model: 'deterministic',
    agent_model_auto: false,
    agent_model_source: 'fixture',
    runtime_version: '1',
    framework: 'throughline-fixture',
    adapter_version: '1',
    duration_minutes: 0,
    cost_usd: 0,
    tokens_used: 0,
    fault: null,
    task_complete: candidate.complete,
  };
  const traceRows = [
    { ts: created, type: 'start', status: 'succeeded', summary: 'Started fixture candidate run.' },
    { ts: created, type: 'patch', status: 'succeeded', summary: 'Wrote deterministic fixture patch.' },
    { ts: created, type: 'finish', status: 'succeeded', summary: 'Finished fixture candidate run.' },
  ];

  writeFile(path.join(dir, 'PATCH.diff'), candidate.patch);
  writeFile(path.join(dir, 'FEEDBACK.md'), candidate.feedback);
  writeFile(path.join(dir, 'METRICS.json'), JSON.stringify(metrics, null, 2) + '\n');
  writeFile(path.join(dir, 'TRACE.jsonl'), traceRows.map(JSON.stringify).join('\n') + '\n');

  appendJsonl(path.join(workspaceDir, '_metrics', 'candidate-run-log.jsonl'), {
    date: datePart(created),
    experiment_id: experimentId,
    task_type: 'fixture',
    tl_spec: '',
    spec_hash: sha256(FIXTURE_TASK),
    base_commit: baseCommit,
    candidate_id: candidate.id,
    role: candidate.role,
    status: 'succeeded',
    fault: null,
    agent_tool: 'fixture',
    agent_model: 'deterministic',
    agent_model_auto: false,
    agent_model_source: 'fixture',
    runtime_version: '1',
    framework: 'throughline-fixture',
    adapter_version: '1',
    rules_hash: '',
    skills_hash: '',
    duration_minutes: 0,
    cost_usd: 0,
    tokens_used: 0,
    patch_path: `_experiments/${experimentId}/candidates/${candidate.id}/PATCH.diff`,
    trace_path: `_experiments/${experimentId}/candidates/${candidate.id}/TRACE.jsonl`,
  });
}

function scoreCandidate(workspaceDir, experimentId, candidateId) {
  const dir = path.join(workspaceDir, '_experiments', experimentId, 'candidates', candidateId);
  const patch = fs.readFileSync(path.join(dir, 'PATCH.diff'), 'utf8');
  const metrics = JSON.parse(fs.readFileSync(path.join(dir, 'METRICS.json'), 'utf8'));
  const feedback = fs.readFileSync(path.join(dir, 'FEEDBACK.md'), 'utf8');
  const hardGatesPassed = metrics.status === 'succeeded'
    && patch.trim().length > 0
    && metrics.task_complete === true
    && /complete/i.test(feedback);

  return {
    hard_gates_passed: hardGatesPassed,
    scores: {
      correctness: hardGatesPassed ? 5 : 2,
      completeness: hardGatesPassed ? 5 : 2,
      scope_discipline: 5,
    },
    utility: hardGatesPassed ? 5 : 2,
  };
}

function writeEvaluation(workspaceDir, experimentId, created) {
  const judgeId = 'fixture-judge';
  const scores = {};
  for (const candidate of CANDIDATES) {
    scores[candidate.id] = scoreCandidate(workspaceDir, experimentId, candidate.id);
  }
  const winner = Object.entries(scores)
    .sort((a, b) => Number(b[1].hard_gates_passed) - Number(a[1].hard_gates_passed) || b[1].utility - a[1].utility)[0][0];
  const dir = path.join(workspaceDir, '_experiments', experimentId, 'evaluation', judgeId);
  const payload = {
    judge_id: judgeId,
    judge_agent: 'fixture',
    status: 'succeeded',
    winner,
    winner_set_by: 'judge',
    rationale: `${winner} passed the fixture hard gates with the highest utility.`,
    candidates: scores,
  };

  writeFile(path.join(dir, 'SCORES.json'), JSON.stringify(payload, null, 2) + '\n');
  writeFile(path.join(dir, 'EVALUATION.md'), [
    '# Evaluation: fixture experiment',
    '',
    `Winner: \`${winner}\``,
    '',
    'The deterministic judge requires a succeeded candidate run, a non-empty patch, and feedback/metrics indicating the fixture task is complete.',
    '',
    '- `fixture-a` passes the hard gates.',
    '- `fixture-b` is retained as a non-winning candidate because it does not mark the task complete.',
    '',
  ].join('\n'));

  appendJsonl(path.join(workspaceDir, '_metrics', 'judge-log.jsonl'), {
    date: datePart(created),
    experiment_id: experimentId,
    judge_id: judgeId,
    judge_agent: 'fixture',
    judge_model: 'deterministic',
    status: 'succeeded',
    winner,
    winner_set_by: 'judge',
    rationale: payload.rationale,
    scores_path: `_experiments/${experimentId}/evaluation/${judgeId}/SCORES.json`,
    evaluation_path: `_experiments/${experimentId}/evaluation/${judgeId}/EVALUATION.md`,
    utility: scores[winner].utility,
    hard_gates_passed: scores[winner].hard_gates_passed,
    duration_minutes: 0,
    cost_usd: 0,
    tokens_used: 0,
  });

  return { judgeId, winner };
}

function runFixtureExperiment(workspaceDir, options = {}) {
  const created = isoNow(options.now);
  const experimentId = options.experimentId || `fixture-${created.replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const baseCommit = options.baseCommit || gitBaseCommit(path.resolve(workspaceDir, '..', '..'));
  const expDir = path.join(workspaceDir, '_experiments', experimentId);
  const specHash = sha256(FIXTURE_TASK);

  if (fs.existsSync(expDir)) {
    throw new Error(`Experiment already exists: ${experimentId}`);
  }

  writeFile(path.join(expDir, 'EXPERIMENT.md'), [
    '---',
    `experiment_id: "${experimentId}"`,
    'task_type: "fixture"',
    'tl_spec: ""',
    `spec_hash: "${specHash}"`,
    `base_commit: "${baseCommit}"`,
    'primary_agent: "fixture-a"',
    'shadow_agents: [fixture-b]',
    'judge_agent: "fixture-judge"',
    'status: "succeeded"',
    `created: "${created}"`,
    'replay_of: ""',
    'suite_id: ""',
    '---',
    '',
    FIXTURE_TASK,
    '',
  ].join('\n'));
  mkdirp(path.join(expDir, 'queue'));

  appendJsonl(path.join(workspaceDir, '_metrics', 'experiment-log.jsonl'), {
    date: datePart(created),
    experiment_id: experimentId,
    task_type: 'fixture',
    tl_spec: '',
    spec_hash: specHash,
    base_commit: baseCommit,
    primary_agent: 'fixture-a',
    shadow_agents: ['fixture-b'],
    judge_agent: 'fixture-judge',
    status: 'running',
    previous_status: 'queued',
    replay_of: '',
    suite_id: '',
    reason: 'fixture experiment started',
  });

  for (const candidate of CANDIDATES) {
    writeCandidate(workspaceDir, experimentId, baseCommit, created, candidate);
  }
  const evaluation = writeEvaluation(workspaceDir, experimentId, created);

  appendJsonl(path.join(workspaceDir, '_metrics', 'experiment-log.jsonl'), {
    date: datePart(created),
    experiment_id: experimentId,
    task_type: 'fixture',
    tl_spec: '',
    spec_hash: specHash,
    base_commit: baseCommit,
    primary_agent: 'fixture-a',
    shadow_agents: ['fixture-b'],
    judge_agent: 'fixture-judge',
    status: 'succeeded',
    previous_status: 'running',
    replay_of: '',
    suite_id: '',
    reason: `fixture judge selected ${evaluation.winner}`,
  });

  return { experimentId, experimentDir: expDir, winner: evaluation.winner, judgeId: evaluation.judgeId };
}

module.exports = { runFixtureExperiment, scoreCandidate };

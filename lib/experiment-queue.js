'use strict';

// Experiment queue — file-native queue read/write/claim helpers for headless
// candidate workers.
//
// How experiments are initiated: a manual command (`tl experiment queue`) or
// the UI (a request config dropped in `_experiments/queue/*.json`) creates one
// experiment folder plus one queue row per candidate. Each worker then drains
// only rows for its own `agent_tool` lane (`tl experiment drain --agent X`),
// so a shadow run can sit queued while a different tool/session is active.
//
// Queue layout (workspace-relative):
//   _experiments/queue/<experiment_id>.jsonl   append-only queue rows; the
//                                              newest row per candidate is the
//                                              current state (event-sourced)
//   _experiments/queue/claims/<exp>--<cand>--<attempt>.claim
//                                              exclusive-create claim markers —
//                                              the atomic bit of a local claim
//   _experiments/queue/<stamp>-<slug>.json     request configs (UI or CLI);
//                                              `processQueueRequests` folds
//                                              fixture-runtime requests into
//                                              real experiments + rows
//
// Atomicity model: appends record history; the claim marker (O_EXCL create)
// decides races. Two workers may both read a row as `queued`, but only one
// can create `<exp>--<cand>--<attempt>.claim`, and only that one appends the
// `running` transition. Atomic enough for local file use by design — a
// distributed queue is explicitly out of scope for this slice.
//
// Safety invariants (see docs/agent-experiments.md):
//   - experiments are shadow attempts: nothing here moves canonical specs/
//     folders or mutates spec lifecycle stages;
//   - workers NEVER apply winners — this module does not (and must not)
//     import lib/experiment-apply.js; winner application stays an explicit
//     human CLI action.
//
// Node stdlib only; zero dependencies.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseFrontmatter } = require('./parse');
const { setFrontmatterField } = require('./frontmatter');
const { tlSpecToTask } = require('./experiment-adapter');

// Every queue row carries at least these fields, on every transition — a
// single row is self-describing without replaying the whole file.
const QUEUE_ROW_FIELDS = [
  'experiment_id',
  'candidate_id',
  'role',
  'agent_tool',
  'agent_model_requested',
  'status',
  'attempt',
  'budget_usd',
  'timeout_minutes',
  'created',
];

// Statuses after which a candidate run is over. Faults are terminal too —
// they are learning data, never retried silently (a retry is a new attempt,
// claimed explicitly).
const TERMINAL_STATUSES = ['succeeded', 'failed', 'timed_out', 'over_budget', 'unavailable', 'cancelled', 'invalid_output'];
const FAULT_STATUSES = ['failed', 'timed_out', 'over_budget', 'unavailable', 'cancelled', 'invalid_output'];

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

function appendJsonl(file, row) {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function queueDir(workspaceDir) {
  return path.join(workspaceDir, '_experiments', 'queue');
}

function queueFile(workspaceDir, experimentId) {
  return path.join(queueDir(workspaceDir), experimentId + '.jsonl');
}

// Ids are single path segments — no separators, no traversal, no dotfiles.
// Same rule as lib/experiment-apply.js.
function assertSegment(kind, id) {
  if (typeof id !== 'string' || !id.length || id.startsWith('.') || /[\\/]/.test(id)) {
    throw new Error(`Invalid ${kind}: ${JSON.stringify(id)} — must be a single folder-safe segment`);
  }
  return id;
}

function gitHead(repoDir) {
  if (!repoDir) return 'unknown';
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

// EXPERIMENT.md frontmatter, tolerated missing (rows still make sense alone).
function readExperimentMeta(workspaceDir, experimentId) {
  try {
    const text = fs.readFileSync(path.join(workspaceDir, '_experiments', experimentId, 'EXPERIMENT.md'), 'utf8');
    return parseFrontmatter(text).meta || {};
  } catch {
    return {};
  }
}

// ---------- experiment creation (`tl experiment queue`) ----------

// Normalize one candidate config to the queue's shape. Explicit config wins;
// anything unspecified degrades to the deterministic fixture defaults.
function normalizeCandidate(c, i) {
  const src = typeof c === 'string' ? { id: c } : (c || {});
  const id = assertSegment('candidate id', String(src.id || `candidate-${i + 1}`));
  const role = src.role === 'primary' ? 'primary' : 'shadow';
  return {
    id,
    role,
    agent_tool: String(src.agent_tool || 'fixture'),
    agent_model: src.agent_model ? String(src.agent_model) : null,
    // Runner config, carried on the row so a drain is self-contained:
    // shell candidates need a command + repo; fixture candidates may pin
    // `complete`; `estimated_cost_usd` powers the budget stop.
    config: {
      ...(src.command ? { command: String(src.command) } : {}),
      ...(src.env && typeof src.env === 'object' ? { env: src.env } : {}),
      ...(src.repo ? { repo: String(src.repo) } : {}),
      ...(src.complete !== undefined ? { complete: Boolean(src.complete) } : {}),
      ...(Number.isFinite(+src.estimated_cost_usd) ? { estimated_cost_usd: +src.estimated_cost_usd } : {}),
    },
  };
}

// The fixture default cohort — mirrors `tl experiment fixture` and the UI's
// defaults: one deterministic primary that completes, one shadow that doesn't.
function fixtureDefaultCandidates() {
  return [
    { id: 'fixture-a', role: 'primary', agent_tool: 'fixture' },
    { id: 'fixture-b', role: 'shadow', agent_tool: 'fixture' },
  ];
}

// Create one experiment: folder + EXPERIMENT.md index (status: queued), an
// experiment-log row, and one queued row per candidate in
// `_experiments/queue/<experiment_id>.jsonl`.
//
// opts:
//   spec            workspace-relative spec path ('specs/foo/' or a .md file);
//                   omitted → a spec-less fixture task
//   repoDir         repo candidates run against (base_commit source)
//   candidates      explicit candidate configs; omitted → fixture defaults
//   judge           { id, agent_tool } or string id
//   budgetUsd / timeoutMinutes / experimentId / now / replayOf / suiteId / source
function queueExperiment(workspaceDir, opts = {}) {
  const created = isoNow(opts.now);

  // Task identity: hash the spec at queue time + record the base commit, so
  // every candidate is judged against the same task text and source tree.
  let task;
  const specRel = String(opts.spec || '').replace(/^\/+/, '');
  if (specRel) {
    const specFile = specRel.endsWith('.md')
      ? path.join(workspaceDir, specRel)
      : path.join(workspaceDir, specRel.replace(/\/+$/, ''), 'SPEC.md');
    if (!fs.existsSync(specFile)) throw new Error(`Spec not found: ${specRel} (looked for ${path.relative(workspaceDir, specFile)})`);
    const parsed = parseFrontmatter(fs.readFileSync(specFile, 'utf8'));
    task = tlSpecToTask(parsed, { specPath: specRel, baseCommit: opts.baseCommit || gitHead(opts.repoDir) });
    task.task_type = 'tl_spec';
  } else {
    // Spec-less fixture run (the UI's default queue form allows it).
    task = { title: 'Fixture task', task_type: 'fixture', spec_hash: sha256('fixture'), base_commit: opts.baseCommit || gitHead(opts.repoDir), source: { spec_path: '' } };
  }

  const candidates = (Array.isArray(opts.candidates) && opts.candidates.length
    ? opts.candidates : fixtureDefaultCandidates()).map(normalizeCandidate);
  const primaries = candidates.filter(c => c.role === 'primary');
  if (primaries.length !== 1) throw new Error(`Exactly one primary candidate is required (got ${primaries.length})`);
  const ids = new Set(candidates.map(c => c.id));
  if (ids.size !== candidates.length) throw new Error('Candidate ids must be unique');

  const judgeSrc = typeof opts.judge === 'string' ? { id: opts.judge } : (opts.judge || {});
  const judge = {
    id: assertSegment('judge id', String(judgeSrc.id || 'fixture-judge')),
    agent_tool: String(judgeSrc.agent_tool || 'fixture'),
  };
  if (ids.has(judge.id)) throw new Error(`Judge id "${judge.id}" collides with a candidate id`);

  const experimentId = assertSegment('experiment id',
    opts.experimentId || `exp-${created.replace(/[-:.TZ]/g, '').slice(0, 14)}-${(task.source.spec_path || 'fixture').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'fixture'}`);
  const expDir = path.join(workspaceDir, '_experiments', experimentId);
  if (fs.existsSync(expDir)) throw new Error(`Experiment already exists: ${experimentId}`);

  const budgetUsd = Number.isFinite(+opts.budgetUsd) ? +opts.budgetUsd : null;
  const timeoutMinutes = Number.isFinite(+opts.timeoutMinutes) ? +opts.timeoutMinutes : null;
  const shadows = candidates.filter(c => c.role === 'shadow').map(c => c.id);

  // EXPERIMENT.md — the human-readable index. `judge_tool` is an extra field
  // beyond the schema minimum (parsers preserve unknown fields); queueJudge
  // reads it so the judge row lands in the right worker lane later.
  mkdirp(expDir);
  fs.writeFileSync(path.join(expDir, 'EXPERIMENT.md'), [
    '---',
    `experiment_id: "${experimentId}"`,
    `task_type: "${task.task_type}"`,
    `tl_spec: "${task.source.spec_path || ''}"`,
    `spec_hash: "${task.spec_hash}"`,
    `base_commit: "${task.base_commit}"`,
    `primary_agent: "${primaries[0].id}"`,
    `shadow_agents: [${shadows.join(', ')}]`,
    `judge_agent: "${judge.id}"`,
    `judge_tool: "${judge.agent_tool}"`,
    'status: "queued"',
    `created: "${created}"`,
    `replay_of: "${opts.replayOf || ''}"`,
    `suite_id: "${opts.suiteId || ''}"`,
    '---',
    '',
    `# Experiment: ${task.title || experimentId}`,
    '',
    task.objective ? task.objective : 'Deterministic fixture task (no TL spec attached).',
    '',
    '## Candidates',
    '',
    ...candidates.map(c => `- \`${c.id}\` — ${c.role}, \`${c.agent_tool}\`${c.agent_model ? `, model \`${c.agent_model}\`` : ''}`),
    '',
    '## Judge plan',
    '',
    `Judge \`${judge.id}\` (\`${judge.agent_tool}\`) is queued once every candidate run is terminal (or a human forces partial evaluation). Candidates run in isolated worktrees/clones from \`${task.base_commit}\`; nothing here mutates canonical specs — winner application stays an explicit human action.`,
    '',
  ].join('\n'));

  appendJsonl(path.join(workspaceDir, '_metrics', 'experiment-log.jsonl'), {
    date: datePart(created),
    experiment_id: experimentId,
    task_type: task.task_type,
    tl_spec: task.source.spec_path || '',
    spec_hash: task.spec_hash,
    base_commit: task.base_commit,
    primary_agent: primaries[0].id,
    shadow_agents: shadows,
    judge_agent: judge.id,
    status: 'queued',
    previous_status: null,
    replay_of: opts.replayOf || '',
    suite_id: opts.suiteId || '',
    reason: `experiment queued (${opts.source || 'cli'})`,
  });

  // One queued row per candidate — the worker contract.
  const rows = candidates.map(c => ({
    ts: created,
    created,
    experiment_id: experimentId,
    candidate_id: c.id,
    role: c.role,
    agent_tool: c.agent_tool,
    agent_model_requested: c.agent_model,
    status: 'queued',
    attempt: 0,
    budget_usd: budgetUsd,
    timeout_minutes: timeoutMinutes,
    claimed_by: null,
    fault: null,
    reason: null,
    config: c.config,
  }));
  for (const row of rows) appendJsonl(queueFile(workspaceDir, experimentId), row);

  return { experimentId, experimentDir: expDir, rows };
}

// ---------- queue reading (event-sourced view) ----------

// Reduce every `_experiments/queue/*.jsonl` to the CURRENT row per
// (experiment, candidate): later rows override earlier fields; `config` from
// the initial queued row is carried forward so a claimed row stays runnable.
function readQueueRows(workspaceDir) {
  const dir = queueDir(workspaceDir);
  if (!fs.existsSync(dir)) return [];
  const current = new Map();
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.jsonl') || f.startsWith('.')) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // a corrupt line never blocks the queue
      if (!row || !row.experiment_id || !row.candidate_id) continue;
      const key = row.experiment_id + ' ' + row.candidate_id;
      const prev = current.get(key);
      current.set(key, prev ? { ...prev, ...row, config: row.config || prev.config } : row);
    }
  }
  return Array.from(current.values());
}

// The rows a worker for `agentTool` may claim: queued candidate rows in its
// lane. Judge rows are never drained here — judging is a later worker/skill.
function laneRows(rows, agentTool) {
  const lane = String(agentTool || '').toLowerCase();
  return rows.filter(r => r.status === 'queued' && r.role !== 'judge'
    && String(r.agent_tool || '').toLowerCase() === lane);
}

// ---------- claim + transitions ----------

// Claim a queued row for `agent`. The atomic bit is an exclusive-create
// (`wx`) marker file — of two racing workers, exactly one wins the create and
// appends the `running` transition; the loser gets null and moves on.
function claimRow(workspaceDir, row, agent, opts = {}) {
  const attempt = (Number(row.attempt) || 0) + 1;
  const claimsDir = path.join(queueDir(workspaceDir), 'claims');
  mkdirp(claimsDir);
  const marker = path.join(claimsDir, `${row.experiment_id}--${row.candidate_id}--${attempt}.claim`);
  try {
    fs.writeFileSync(marker, JSON.stringify({ agent, ts: isoNow(opts.now) }) + '\n', { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') return null; // someone else holds this attempt
    throw e;
  }
  const running = {
    ...row,
    ts: isoNow(opts.now),
    status: 'running',
    attempt,
    claimed_by: String(agent),
    fault: null,
    reason: null,
  };
  appendJsonl(queueFile(workspaceDir, row.experiment_id), running);
  return running;
}

// Append a status transition for a row. Fault statuses stamp `fault` with the
// same string, so fault serialization is queryable without status mapping.
function markRow(workspaceDir, row, status, extra = {}) {
  const next = {
    ...row,
    ts: isoNow(extra.now),
    status,
    fault: FAULT_STATUSES.includes(status) ? status : null,
    reason: extra.reason || null,
  };
  appendJsonl(queueFile(workspaceDir, row.experiment_id), next);
  return next;
}

// ---------- experiment status ----------

// Flip EXPERIMENT.md's status and log the transition. No-op when unchanged.
function setExperimentStatus(workspaceDir, experimentId, status, reason, now) {
  const file = path.join(workspaceDir, '_experiments', experimentId, 'EXPERIMENT.md');
  if (!fs.existsSync(file)) return null;
  const meta = readExperimentMeta(workspaceDir, experimentId);
  if (meta.status === status) return meta.status;
  fs.writeFileSync(file, setFrontmatterField(fs.readFileSync(file, 'utf8'), 'status', status));
  const created = isoNow(now);
  appendJsonl(path.join(workspaceDir, '_metrics', 'experiment-log.jsonl'), {
    date: datePart(created),
    experiment_id: experimentId,
    task_type: meta.task_type || '',
    tl_spec: meta.tl_spec || '',
    spec_hash: meta.spec_hash || '',
    base_commit: meta.base_commit || '',
    primary_agent: meta.primary_agent || '',
    shadow_agents: Array.isArray(meta.shadow_agents) ? meta.shadow_agents : [],
    judge_agent: meta.judge_agent || '',
    status,
    previous_status: meta.status || null,
    replay_of: meta.replay_of || '',
    suite_id: meta.suite_id || '',
    reason: reason || '',
  });
  return status;
}

// ---------- judge queueing ----------

// Queue the judge row for an experiment — but only once every candidate run
// is terminal, unless a human explicitly forces evaluation of partial
// results. A failed primary never blocks this: `failed` is terminal, shadows
// keep running, and a shadow can still win at evaluation.
function queueJudge(workspaceDir, experimentId, opts = {}) {
  const rows = readQueueRows(workspaceDir).filter(r => r.experiment_id === experimentId);
  const candidates = rows.filter(r => r.role !== 'judge');
  if (!candidates.length) return { queued: false, reason: 'no candidate rows' };
  if (rows.some(r => r.role === 'judge')) return { queued: false, reason: 'judge already queued' };
  const pending = candidates.filter(r => !TERMINAL_STATUSES.includes(r.status));
  if (pending.length && !opts.force) {
    return { queued: false, reason: `${pending.length} candidate run(s) not terminal yet` };
  }
  const meta = readExperimentMeta(workspaceDir, experimentId);
  const created = isoNow(opts.now);
  const row = {
    ts: created,
    created,
    experiment_id: experimentId,
    candidate_id: String(meta.judge_agent || 'judge'),
    role: 'judge',
    agent_tool: String(meta.judge_tool || 'fixture'),
    agent_model_requested: null,
    status: 'queued',
    attempt: 0,
    budget_usd: null,
    timeout_minutes: null,
    claimed_by: null,
    fault: null,
    reason: pending.length ? `forced partial evaluation with ${pending.length} candidate run(s) not terminal` : null,
  };
  appendJsonl(queueFile(workspaceDir, experimentId), row);
  setExperimentStatus(workspaceDir, experimentId, 'awaiting_evaluation',
    pending.length ? 'judge queued — forced evaluation of partial results' : 'judge queued — all candidate runs terminal', opts.now);
  return { queued: true, row };
}

// ---------- request configs (the UI's write path) ----------

// Fold pending request configs (`_experiments/queue/*.json`, status "queued")
// into real experiments + rows. This slice bridges `runtime: "fixture"`
// requests; `runtime: "local"` requests need explicit candidate config (a
// command, a repo) that the UI form doesn't collect yet, so they are left
// queued untouched for a later slice. A processed request is rewritten with
// status "accepted" + the experiment id (or "invalid" + the error), so the UI
// can show what became of it — the file is the audit trail, never deleted.
function processQueueRequests(workspaceDir, opts = {}) {
  const dir = queueDir(workspaceDir);
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const file = path.join(dir, f);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!cfg || cfg.status !== 'queued') continue;
    if (String(cfg.runtime || '') !== 'fixture') {
      results.push({ file: f, status: 'left-queued', reason: `runtime "${cfg.runtime}" needs explicit candidate config` });
      continue;
    }
    const models = (cfg.models && typeof cfg.models === 'object') ? cfg.models : {};
    const candidates = [
      { id: cfg.primary || 'fixture-a', role: 'primary', agent_tool: 'fixture', agent_model: models[cfg.primary] || models.primary || null },
      ...(Array.isArray(cfg.shadows) ? cfg.shadows : []).map(s =>
        ({ id: s, role: 'shadow', agent_tool: 'fixture', agent_model: models[s] || null })),
    ];
    try {
      const created = queueExperiment(workspaceDir, {
        spec: cfg.tl_spec || '',
        candidates,
        judge: { id: cfg.judge || 'fixture-judge', agent_tool: 'fixture' },
        budgetUsd: cfg.budget_usd,
        timeoutMinutes: cfg.timeout_minutes,
        replayOf: cfg.replay_of || '',
        source: cfg.source || 'request',
        now: opts.now,
      });
      fs.writeFileSync(file, JSON.stringify({ ...cfg, status: 'accepted', experiment_id: created.experimentId, accepted_at: isoNow(opts.now) }, null, 2) + '\n');
      results.push({ file: f, status: 'accepted', experimentId: created.experimentId });
    } catch (e) {
      fs.writeFileSync(file, JSON.stringify({ ...cfg, status: 'invalid', error: String(e.message).slice(0, 300) }, null, 2) + '\n');
      results.push({ file: f, status: 'invalid', reason: e.message });
    }
  }
  return results;
}

// ---------- drain (`tl experiment drain --agent X`) ----------

// One drain pass for one worker lane:
//   1. fold pending request configs into experiments (fixture runtime);
//   2. claim + run every queued row in this agent's lane (up to `max`);
//   3. queue judge rows for any experiment whose candidates are all terminal
//      (or that a human explicitly listed in `evaluatePartial`).
// Rows in other lanes are left queued — that IS the fault posture for a
// worker that isn't running: its lane simply waits.
function drainQueue(workspaceDir, opts = {}) {
  const agent = String(opts.agent || '').trim();
  if (!agent) throw new Error('drainQueue requires opts.agent — a worker drains exactly one agent_tool lane');
  // Injected for tests; defaults to the local fixture/shell runner. Required
  // lazily so the queue module stays loadable without the runner.
  const runCandidate = opts.runCandidate || require('./experiment-runner').runCandidate;
  const max = Number.isFinite(+opts.max) && +opts.max > 0 ? +opts.max : Infinity;

  const requests = processQueueRequests(workspaceDir, opts);
  const rows = readQueueRows(workspaceDir);
  const lane = laneRows(rows, agent).sort((a, b) => String(a.created).localeCompare(String(b.created))).slice(0, max === Infinity ? undefined : max);

  const ran = [];
  for (const row of lane) {
    const claimed = claimRow(workspaceDir, row, agent, opts);
    if (!claimed) { ran.push({ row, status: 'skipped', reason: 'claim lost — another worker holds it' }); continue; }
    setExperimentStatus(workspaceDir, row.experiment_id, 'running', `candidate ${row.candidate_id} claimed by ${agent}`, opts.now);
    let outcome;
    try {
      outcome = runCandidate(workspaceDir, claimed, opts);
    } catch (e) {
      // The runner writes artifacts itself even on faults; this catch is the
      // belt for a runner *crash* — the row still reaches a terminal status.
      outcome = { status: 'failed', reason: `runner crashed: ${String(e.message).slice(0, 300)}` };
    }
    const status = TERMINAL_STATUSES.includes(outcome && outcome.status) ? outcome.status : 'failed';
    markRow(workspaceDir, claimed, status, { reason: (outcome && outcome.reason) || null, now: opts.now });
    ran.push({ row: claimed, status, reason: (outcome && outcome.reason) || null });
  }

  // Judge queueing — every experiment currently in the queue gets checked, so
  // whichever lane finishes last is the one that queues the judge.
  const force = new Set(Array.isArray(opts.evaluatePartial) ? opts.evaluatePartial : []);
  const judges = [];
  const expIds = [...new Set(readQueueRows(workspaceDir).map(r => r.experiment_id))];
  for (const id of expIds) {
    const res = queueJudge(workspaceDir, id, { force: force.has(id), now: opts.now });
    if (res.queued) judges.push({ experimentId: id, row: res.row });
  }

  return { agent, requests, ran, judges };
}

module.exports = {
  QUEUE_ROW_FIELDS,
  TERMINAL_STATUSES,
  FAULT_STATUSES,
  queueExperiment,
  readQueueRows,
  laneRows,
  claimRow,
  markRow,
  setExperimentStatus,
  queueJudge,
  processQueueRequests,
  drainQueue,
  readExperimentMeta,
};

'use strict';

// Experiment replay and benchmark suites — rerun historical tasks against a
// new model/framework/tool candidate and compare the outcome to the prior
// winner, updating nothing until the evidence clears the promotion policy.
//
// Three replay modes (docs/agent-experiments.md "Replay and benchmark suites"):
//   exact  same `spec_hash` AND same `base_commit` as the original experiment —
//          the fully controlled comparison. Refused loudly if the spec text
//          has changed since (its hash would differ).
//   spec   same spec slug against the CURRENT repo — rehash now, base_commit
//          from the run repo's HEAD. The task drifted; the comparison says so.
//   auto   exact when the spec still hashes the same, else spec — the suite
//          default, so one changed spec never sinks a whole benchmark pass.
//
// Every replay experiment is a NORMAL experiment (created through
// lib/experiment-queue.js `queueExperiment`, drained by the same workers,
// judged by the same judge) plus two things only this module adds:
//   _experiments/<id>/REPLAY.json      replay metadata: mode, the original's
//                                      spec_hash/base_commit/winner, and the
//                                      candidate RUNTIME FINGERPRINT captured
//                                      at queue time (incl. tl_version,
//                                      rules_hash, skills_hash) — so a later
//                                      reader can tell whether the candidate
//                                      changed because of model, tool,
//                                      adapter, framework, rules, or skills
//   _metrics/replay-log.jsonl          one comparison row per judged replay
//                                      candidate: previous winner vs new
//                                      candidate, utility/quality/cost/latency
//                                      deltas, and the promotion
//                                      recommendation (threshold-enforced via
//                                      lib/experiment-policy.js — a new
//                                      runtime never becomes default off a
//                                      single win)
//
// Suites are stored definitions, not copies of tasks:
//   _experiments/suites/<name>.json    selectors (specs / tags / task_types)
//                                      plus an optional sample size; suite
//                                      replay re-selects judged historical
//                                      experiments at replay time
//
// Safety invariants (same posture as queue/runner/judge):
//   - replay EVALUATES, never applies: this module must not import
//     lib/experiment-apply.js (a test enforces it), and nothing here moves
//     canonical spec folders or mutates spec lifecycle stages;
//   - all logs are append-only; a re-run comparison is a new line, never an
//     edit; faults (`unavailable`, `timed_out`, `over_budget`,
//     `invalid_output`) are compared as reliability signals, never dropped.
//
// Node stdlib only; zero dependencies.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseFrontmatter } = require('./parse');
const { makeFingerprint, FINGERPRINT_FIELDS } = require('./experiment-adapter');
const { queueExperiment, readExperimentMeta } = require('./experiment-queue');
const { readExperimentsConfig, shouldPromoteFromReplays } = require('./experiment-policy');

const REPLAY_MODES = ['exact', 'spec', 'auto'];

// The fingerprint fields a replay comparison reports differences over: the 9
// shared fields plus tl_version (the version of tl itself that queued the
// replay — rules/skills hashes catch prompt-side drift, tl_version catches
// harness drift).
const REPLAY_FINGERPRINT_FIELDS = [...FINGERPRINT_FIELDS, 'tl_version'];

// Where a spec can live over its lifecycle — replay must find a task whose
// spec has moved stages since the original run (same list as
// lib/experiment-policy.js contextKeyForLoggedRun).
const STAGE_FOLDERS = ['specs', 'in-progress', 'tests', 'in-review', 'done', 'triage'];

// ---------- small shared helpers (same shapes as lib/experiment-queue.js) ----------

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function datePart(iso) {
  return iso.slice(0, 10);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function appendJsonl(file, row) {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a corrupt line never blocks replay */ }
  }
  return rows;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

// Ids are single path segments — no separators, no traversal, no dotfiles.
// Same rule as lib/experiment-queue.js / lib/experiment-apply.js.
function assertSegment(kind, id) {
  if (typeof id !== 'string' || !id.length || id.startsWith('.') || /[\\/]/.test(id)) {
    throw new Error(`Invalid ${kind}: ${JSON.stringify(id)} — must be a single folder-safe segment`);
  }
  return id;
}

function replayLogFile(workspaceDir) {
  return path.join(workspaceDir, '_metrics', 'replay-log.jsonl');
}

function suitesDir(workspaceDir) {
  return path.join(workspaceDir, '_experiments', 'suites');
}

// ---------- runtime fingerprint (with tl_version + rules/skills hashes) ----------

// Hash a set of files as one identity: sorted (relpath + content) pairs, so
// the hash moves when any file's content moves and only then. Missing files
// simply don't contribute; no files at all hashes the empty list (stable).
function hashFiles(rootDir, relPaths) {
  const h = crypto.createHash('sha256');
  for (const rel of [...relPaths].sort()) {
    let content;
    try { content = fs.readFileSync(path.join(rootDir, rel), 'utf8'); } catch { continue; }
    h.update(rel + '\n' + content + '\n');
  }
  return h.digest('hex').slice(0, 12);
}

// rules_hash: the agent-facing rules files at the repo root (the generated
// tl sync-rules targets plus CLAUDE.md). skills_hash: every skills/*/SKILL.md.
// Both are inputs a candidate agent reads — if either moved between the
// original run and the replay, the fingerprint says so.
function rulesHash(rootDir) {
  return hashFiles(rootDir, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', path.join('.cursor', 'rules', 'tl.mdc')]);
}

function skillsHash(rootDir) {
  const dir = path.join(rootDir, 'skills');
  let entries = [];
  try { entries = fs.readdirSync(dir).sort(); } catch { /* no skills dir — stable empty hash */ }
  return hashFiles(rootDir, entries.map(e => path.join('skills', e, 'SKILL.md')));
}

function tlVersion() {
  try { return String(require('../package.json').version || '0'); } catch { return '0'; }
}

// The candidate runtime fingerprint captured at replay-queue time. The 9
// shared fields (lib/experiment-adapter.js makeFingerprint) plus `tl_version`.
// `rootDir` is the checkout whose rules/skills the candidate will read —
// defaults to this tl checkout.
function replayRuntimeFingerprint(candidate = {}, opts = {}) {
  const rootDir = opts.rootDir || path.resolve(__dirname, '..');
  const model = candidate.agent_model || null;
  return {
    ...makeFingerprint({
      agent_tool: candidate.agent_tool || 'unknown',
      agent_model: model || 'auto',
      agent_model_auto: !model,
      agent_model_source: model ? 'requested' : 'auto',
      runtime_version: process.version,
      framework: candidate.framework || candidate.agent_tool || 'unknown',
      adapter_version: '1',
      rules_hash: rulesHash(rootDir),
      skills_hash: skillsHash(rootDir),
    }),
    tl_version: tlVersion(),
  };
}

// Which fingerprint fields differ between two runs — the answer to "did the
// candidate change because of model, tool, adapter, framework, rules, or
// skills?". Missing/null fields compare as ''.
function fingerprintDiff(a, b) {
  const norm = (row, f) => (row && row[f] !== undefined && row[f] !== null ? String(row[f]) : '');
  return REPLAY_FINGERPRINT_FIELDS.filter(f => norm(a, f) !== norm(b, f));
}

// ---------- candidate parsing ----------

// `--candidate codex` / `--candidate codex:gpt-5` / an explicit object with
// structured runner config fields (repo, command, prompt, profile, sandbox,
// extra_flags, env, complete, estimated_cost_usd — the queueExperiment
// candidate shape).
function parseCandidate(input) {
  if (input && typeof input === 'object') {
    if (!input.agent_tool) throw new Error('Replay candidate object requires agent_tool');
    const tool = String(input.agent_tool);
    const model = input.agent_model ? String(input.agent_model) : null;
    return { ...input, agent_tool: tool, agent_model: model, id: input.id ? String(input.id) : defaultCandidateId(tool, model) };
  }
  const s = String(input || '').trim();
  if (!s) throw new Error('Replay requires a candidate: --candidate <agent_tool>[:<agent_model>]');
  const colon = s.indexOf(':');
  const tool = colon >= 0 ? s.slice(0, colon) : s;
  const model = colon >= 0 && s.slice(colon + 1) ? s.slice(colon + 1) : null;
  if (!tool) throw new Error(`Invalid candidate ${JSON.stringify(s)} — expected <agent_tool>[:<agent_model>]`);
  return { agent_tool: tool, agent_model: model, id: defaultCandidateId(tool, model) };
}

function defaultCandidateId(tool, model) {
  return slugify(model ? `${tool}-${model}` : tool) || 'candidate';
}

// ---------- spec location + hashing ----------

// Find the current file for a workspace-relative spec path, following the
// spec through lifecycle stages when it has moved since the original run.
// Returns { rel, file } or null. `rel` is what queueExperiment gets — so the
// replay's `tl_spec` names where the spec lives NOW.
function locateSpec(workspaceDir, specRel) {
  const clean = String(specRel || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return null;
  const direct = clean.endsWith('.md')
    ? path.join(workspaceDir, clean)
    : path.join(workspaceDir, clean, 'SPEC.md');
  if (fs.existsSync(direct)) return { rel: clean.endsWith('.md') ? clean : clean + '/', file: direct };
  const slug = clean.split('/').pop().replace(/\.md$/, '');
  for (const stage of STAGE_FOLDERS) {
    const file = path.join(workspaceDir, stage, slug, 'SPEC.md');
    if (fs.existsSync(file)) return { rel: `${stage}/${slug}/`, file };
  }
  return null;
}

// The spec's current content hash — computed exactly the way queueExperiment
// does (via tlSpecToTask: sha256 of the spec BODY, frontmatter excluded), so
// "hashes match" here means queueExperiment will record the same spec_hash.
function currentSpecHash(specFile) {
  const parsed = parseFrontmatter(fs.readFileSync(specFile, 'utf8'));
  return sha256(parsed.body || '');
}

// ---------- log lookups ----------

// Latest succeeded judge row per experiment — the "judged" gate, same rule as
// lib/experiment-policy.js updatePriorsFromLogs.
function latestJudgeRows(workspaceDir) {
  const judged = new Map();
  for (const j of readJsonl(path.join(workspaceDir, '_metrics', 'judge-log.jsonl'))) {
    if (j && j.experiment_id && j.status === 'succeeded') judged.set(j.experiment_id, j);
  }
  return judged;
}

// Latest candidate-run-log row per (experiment, candidate) — retries supersede.
function latestCandidateRuns(workspaceDir) {
  const runs = new Map();
  for (const r of readJsonl(path.join(workspaceDir, '_metrics', 'candidate-run-log.jsonl'))) {
    if (r && r.experiment_id && r.candidate_id) runs.set(`${r.experiment_id} ${r.candidate_id}`, r);
  }
  return runs;
}

// SCORES.json for a judge row, resolved through the workspace only (the path
// is one our own judge wrote, but guard traversal anyway).
function readScores(workspaceDir, judgeRow) {
  if (!judgeRow || !judgeRow.scores_path) return null;
  const file = path.resolve(workspaceDir, String(judgeRow.scores_path));
  if (!file.startsWith(path.resolve(workspaceDir) + path.sep)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function meanScore(scores) {
  const vals = Object.values(scores || {}).filter(v => Number.isFinite(+v)).map(Number);
  return vals.length ? round4(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

// Every experiment folder's meta, newest first. Skips the queue/ and suites/
// infrastructure folders (no EXPERIMENT.md) automatically.
function listExperiments(workspaceDir) {
  const dir = path.join(workspaceDir, '_experiments');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const e of entries.sort()) {
    if (e.startsWith('.')) continue;
    if (!fs.existsSync(path.join(dir, e, 'EXPERIMENT.md'))) continue;
    const meta = readExperimentMeta(workspaceDir, e);
    if (meta && meta.experiment_id) out.push(meta);
  }
  return out.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
}

// ---------- replay one experiment ----------

// Queue a replay of `experimentId` with a new candidate runtime.
//
// opts:
//   candidate       required — 'tool', 'tool:model', or a structured object
//   mode            'exact' (default) | 'spec' | 'auto'
//   repoDir         repo the candidate runs against (worktree/clone source);
//                   also the base_commit source in spec mode
//   judge           override judge ({ id, agent_tool } or string); default:
//                   the original experiment's judge
//   budgetUsd / timeoutMinutes / experimentId / suiteId / source / now / rootDir
//
// Returns { experimentId, mode, fingerprint, spec, rows, replayPath }.
function replayExperiment(workspaceDir, experimentId, opts = {}) {
  assertSegment('experiment id', String(experimentId || ''));
  const meta = readExperimentMeta(workspaceDir, experimentId);
  if (!meta.experiment_id) throw new Error(`Experiment not found: ${experimentId} (no _experiments/${experimentId}/EXPERIMENT.md)`);

  const requested = opts.mode ? String(opts.mode) : 'exact';
  if (!REPLAY_MODES.includes(requested)) throw new Error(`Unknown replay mode "${requested}" — expected ${REPLAY_MODES.join(' | ')}`);
  const candidate = parseCandidate(opts.candidate);
  const created = isoNow(opts.now);

  // Resolve the task and settle the mode. A fixture task (no tl_spec) has a
  // constant hash, so exact always holds for it.
  let mode = requested;
  let specRel = '';
  let hashMatches = true;
  if (meta.tl_spec) {
    const located = locateSpec(workspaceDir, meta.tl_spec);
    if (!located) throw new Error(`Cannot replay ${experimentId}: spec ${meta.tl_spec} not found in any lifecycle stage`);
    specRel = located.rel;
    hashMatches = currentSpecHash(located.file) === String(meta.spec_hash || '');
    if (requested === 'auto') mode = hashMatches ? 'exact' : 'spec';
    if (mode === 'exact' && !hashMatches) {
      throw new Error(`Cannot exact-replay ${experimentId}: ${specRel} has changed since the original run (spec_hash differs) — use --mode spec to rerun the current spec text, or --mode auto to let replay decide`);
    }
  } else if (requested === 'auto') {
    mode = 'exact';
  }

  // The controlled variables: exact pins the original base_commit (and the
  // hash check above pinned spec_hash); spec mode re-derives both from now.
  const baseCommit = mode === 'exact' ? (meta.base_commit || undefined) : undefined;

  // The queue candidate row: structured config fields pass straight through
  // to lib/experiment-queue.js normalizeCandidate (repo, command, prompt,
  // profile, sandbox, extra_flags, env, complete, estimated_cost_usd).
  const queueCandidate = {
    ...candidate,
    id: assertSegment('candidate id', candidate.id),
    role: 'primary',
    ...(opts.repoDir && !candidate.repo ? { repo: String(opts.repoDir) } : {}),
  };

  // Judge: the original experiment's judge unless overridden — but never the
  // candidate itself (queueExperiment enforces the collision).
  const judgeSrc = opts.judge !== undefined ? opts.judge
    : { id: meta.judge_agent || 'fixture-judge', agent_tool: meta.judge_tool || 'fixture' };

  const newId = opts.experimentId
    ? assertSegment('experiment id', String(opts.experimentId))
    : uniqueReplayId(workspaceDir, created, queueCandidate.id, specRel || 'fixture');

  const result = queueExperiment(workspaceDir, {
    spec: specRel,
    repoDir: opts.repoDir,
    baseCommit,
    candidates: [queueCandidate],
    judge: judgeSrc,
    budgetUsd: opts.budgetUsd,
    timeoutMinutes: opts.timeoutMinutes,
    experimentId: newId,
    replayOf: experimentId,
    suiteId: opts.suiteId || '',
    source: opts.source || 'replay',
    now: opts.now,
  });

  // Exact-mode invariant: the new experiment records the ORIGINAL spec_hash —
  // queueExperiment rehashes, and the pre-check above guarantees equality.

  // REPLAY.json — the replay metadata sidecar: mode, the original's identity
  // and winner, and the candidate runtime fingerprint captured at queue time.
  const judged = latestJudgeRows(workspaceDir);
  const originalJudge = judged.get(experimentId) || null;
  const fingerprint = replayRuntimeFingerprint(candidate, opts);
  const replayPath = path.join(result.experimentDir, 'REPLAY.json');
  fs.writeFileSync(replayPath, JSON.stringify({
    experiment_id: result.experimentId,
    replay_of: experimentId,
    suite_id: opts.suiteId || '',
    mode,
    created,
    original: {
      tl_spec: meta.tl_spec || '',
      spec_hash: meta.spec_hash || '',
      base_commit: meta.base_commit || '',
      previous_winner: originalJudge ? (originalJudge.winner || null) : null,
      spec_hash_matches: hashMatches,
    },
    candidate: { id: queueCandidate.id, agent_tool: candidate.agent_tool, agent_model: candidate.agent_model || null },
    runtime_fingerprint: fingerprint,
  }, null, 2) + '\n');

  return {
    experimentId: result.experimentId,
    experimentDir: result.experimentDir,
    replayOf: experimentId,
    mode,
    spec: specRel,
    fingerprint,
    rows: result.rows,
    replayPath,
  };
}

// Replay ids embed the candidate and original task so two replays queued in
// the same second never collide silently — and a residual collision gets a
// numeric suffix rather than an error mid-suite.
function uniqueReplayId(workspaceDir, created, candidateId, specRel) {
  const stamp = created.replace(/[-:.TZ]/g, '').slice(0, 14);
  const specSlug = slugify(specRel).slice(0, 30) || 'fixture';
  const base = `exp-${stamp}-replay-${slugify(candidateId).slice(0, 24) || 'candidate'}-${specSlug}`;
  let id = base;
  for (let i = 2; fs.existsSync(path.join(workspaceDir, '_experiments', id)); i++) id = `${base}-${i}`;
  return id;
}

// ---------- suites ----------

// Record a benchmark suite definition. Selectors are matched at REPLAY time
// (the suite is a saved query, not a snapshot):
//   specs       list — matches an experiment whose tl_spec contains the entry
//               or whose spec slug equals the entry's slug
//   tags        list — matches the spec's frontmatter tags (spec located
//               across stages at selection time)
//   task_types  list — matches EXPERIMENT.md task_type
// Empty selectors match everything. `sample_size` caps how many historical
// tasks one suite replay queues (newest first, one per spec_hash).
function createSuite(workspaceDir, name, opts = {}) {
  assertSegment('suite name', String(name || ''));
  const file = path.join(suitesDir(workspaceDir), name + '.json');
  if (fs.existsSync(file)) throw new Error(`Suite already exists: ${name} (${path.relative(workspaceDir, file)}) — suites are definitions; pick a new name`);
  const list = v => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const suite = {
    suite_id: name,
    created: isoNow(opts.now),
    selectors: {
      specs: list(opts.specs),
      tags: list(opts.tags),
      task_types: list(opts.taskTypes),
    },
    sample_size: Number.isFinite(+opts.sampleSize) && +opts.sampleSize > 0 ? Math.floor(+opts.sampleSize) : null,
    notes: opts.notes ? String(opts.notes) : '',
  };
  mkdirp(suitesDir(workspaceDir));
  fs.writeFileSync(file, JSON.stringify(suite, null, 2) + '\n');
  return { suite, file };
}

function readSuite(workspaceDir, name) {
  assertSegment('suite name', String(name || ''));
  const file = path.join(suitesDir(workspaceDir), name + '.json');
  if (!fs.existsSync(file)) throw new Error(`Suite not found: ${name} (expected ${path.relative(workspaceDir, file)})`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listSuites(workspaceDir) {
  let entries = [];
  try { entries = fs.readdirSync(suitesDir(workspaceDir)); } catch { return []; }
  const out = [];
  for (const e of entries.sort()) {
    if (!e.endsWith('.json') || e.startsWith('.')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(suitesDir(workspaceDir), e), 'utf8'))); } catch { /* skip corrupt */ }
  }
  return out;
}

// The spec's tags, followed across stages. Best effort — an unlocatable spec
// has unknown tags (matches only when no tag selector is set).
function specTags(workspaceDir, specRel) {
  const located = locateSpec(workspaceDir, specRel);
  if (!located) return null;
  try {
    const meta = parseFrontmatter(fs.readFileSync(located.file, 'utf8')).meta || {};
    return (Array.isArray(meta.tags) ? meta.tags : []).map(t => String(t).toLowerCase());
  } catch { return null; }
}

function slugOfSpec(specRel) {
  return String(specRel || '').replace(/\/+$/, '').split('/').pop().replace(/\.md$/, '').toLowerCase();
}

// Select the historical benchmark tasks a suite replay runs against:
// judged original experiments (never replays of replays), matching the
// selectors, deduped to the NEWEST experiment per spec_hash, newest first,
// capped at the sample size.
function selectSuiteExperiments(workspaceDir, suite, opts = {}) {
  const selectors = (suite && suite.selectors) || {};
  const specSel = (selectors.specs || []).map(String);
  const tagSel = (selectors.tags || []).map(s => String(s).toLowerCase());
  const typeSel = (selectors.task_types || []).map(String);
  const judged = latestJudgeRows(workspaceDir);

  const matches = [];
  for (const meta of listExperiments(workspaceDir)) {
    if (meta.replay_of) continue; // benchmark tasks are original runs
    if (!judged.has(meta.experiment_id) && !opts.includeUnjudged) continue; // a benchmark needs a prior verdict
    if (typeSel.length && !typeSel.includes(String(meta.task_type || ''))) continue;
    if (specSel.length) {
      const spec = String(meta.tl_spec || '');
      const slug = slugOfSpec(spec);
      const hit = specSel.some(s => (spec && spec.includes(s.replace(/\/+$/, ''))) || slugOfSpec(s) === slug);
      if (!hit) continue;
    }
    if (tagSel.length) {
      const tags = meta.tl_spec ? specTags(workspaceDir, meta.tl_spec) : [];
      if (!tags || !tagSel.some(t => tags.includes(t))) continue;
    }
    matches.push(meta);
  }

  // One benchmark per task: the newest experiment per spec_hash.
  const perHash = new Map();
  for (const m of matches) {
    const key = String(m.spec_hash || m.experiment_id);
    const prev = perHash.get(key);
    if (!prev || String(m.created || '').localeCompare(String(prev.created || '')) > 0) perHash.set(key, m);
  }
  const selected = Array.from(perHash.values())
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));

  const cap = Number.isFinite(+opts.sampleSize) && +opts.sampleSize > 0 ? Math.floor(+opts.sampleSize)
    : (Number.isFinite(+(suite && suite.sample_size)) && +suite.sample_size > 0 ? Math.floor(+suite.sample_size) : null);
  return cap ? selected.slice(0, cap) : selected;
}

// Queue replay experiments across a suite's selected historical tasks.
// Mode defaults to `auto` — one drifted spec degrades to a spec replay
// (recorded in its REPLAY.json), it never aborts the batch; an item that
// still fails to queue is reported in `skipped`, never fatal.
function replaySuite(workspaceDir, suiteName, opts = {}) {
  const suite = readSuite(workspaceDir, suiteName);
  const candidate = parseCandidate(opts.candidate);
  const selected = selectSuiteExperiments(workspaceDir, suite, opts);
  const queued = [];
  const skipped = [];
  for (const meta of selected) {
    try {
      queued.push(replayExperiment(workspaceDir, meta.experiment_id, {
        ...opts,
        candidate,
        mode: opts.mode || 'auto',
        suiteId: suite.suite_id,
        source: `suite:${suite.suite_id}`,
      }));
    } catch (e) {
      skipped.push({ experiment_id: meta.experiment_id, reason: String(e.message).slice(0, 300) });
    }
  }
  return { suite, selected: selected.map(m => m.experiment_id), queued, skipped };
}

// ---------- replay comparison report (replay-log.jsonl) ----------

// Fold judged replay experiments into `_metrics/replay-log.jsonl` — one row
// per (replay experiment, candidate), appended exactly once (idempotence:
// existing rows are keyed by experiment_id + candidate_id).
//
// Each row compares the new candidate against the ORIGINAL experiment's
// winner: utility/quality from the two SCORES.json verdicts, cost/latency
// from candidate-run-log, fingerprint changes from the two run rows, and the
// promotion recommendation from the cumulative replay evidence for this
// candidate runtime (lib/experiment-policy.js shouldPromoteFromReplays —
// min_samples_to_promote + promote_utility_delta, so a single win never
// recommends promotion). Faulted replays produce rows too: status + fault are
// reliability signals, and their deltas are null where no metric exists.
function replayReport(workspaceDir, opts = {}) {
  const nowIso = isoNow(opts.now);
  const config = opts.config !== undefined ? opts.config : readExperimentsConfig(workspaceDir);
  const judged = latestJudgeRows(workspaceDir);
  const runs = latestCandidateRuns(workspaceDir);
  const existing = readJsonl(replayLogFile(workspaceDir));
  const done = new Set(existing.map(r => `${r.experiment_id} ${r.candidate_id}`));

  // Judged replay experiments not folded yet, oldest first (stable growth).
  const pendingRows = [];
  const replays = listExperiments(workspaceDir).filter(m => m.replay_of && judged.has(m.experiment_id))
    .sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));

  for (const meta of replays) {
    const replayJudge = judged.get(meta.experiment_id);
    const scores = readScores(workspaceDir, replayJudge);
    const originalJudge = judged.get(String(meta.replay_of)) || null;
    const originalScores = readScores(workspaceDir, originalJudge);
    const previousWinner = originalJudge ? (originalJudge.winner || null) : null;
    const prevEval = previousWinner && originalScores && originalScores.candidates
      ? originalScores.candidates[previousWinner] : null;
    const prevRun = previousWinner ? runs.get(`${meta.replay_of} ${previousWinner}`) : null;

    const candidateIds = scores && scores.candidates ? Object.keys(scores.candidates).sort() : [];
    for (const cid of candidateIds) {
      if (done.has(`${meta.experiment_id} ${cid}`)) continue;
      const ev = scores.candidates[cid] || {};
      const run = runs.get(`${meta.experiment_id} ${cid}`) || null;
      // Missing metrics stay missing: null/undefined never coerces to 0 — a
      // faulted or unjudgeable side yields a null delta, not a fake zero.
      const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : +v);
      const delta = (a, b) => (Number.isFinite(num(a)) && Number.isFinite(num(b)) ? round4(num(a) - num(b)) : null);
      pendingRows.push({
        date: datePart(nowIso),
        experiment_id: meta.experiment_id,
        replay_of: String(meta.replay_of),
        suite_id: meta.suite_id ? String(meta.suite_id) : '',
        candidate_id: cid,
        agent_tool: run ? run.agent_tool || '' : '',
        agent_model: run && run.agent_model && run.agent_model !== 'unknown' ? run.agent_model : null,
        previous_winner: previousWinner,
        new_winner: replayJudge.winner || null,
        utility_delta: delta(ev.utility, prevEval && prevEval.utility),
        quality_delta: delta(meanScore(ev.scores), prevEval && meanScore(prevEval.scores)),
        cost_delta: delta(run && run.cost_usd, prevRun && prevRun.cost_usd),
        latency_delta: delta(run && run.duration_minutes, prevRun && prevRun.duration_minutes),
        replay_status: run ? run.status || '' : '',
        fault: (run && run.fault) || (ev.fault || null),
        fingerprint_changes: fingerprintDiff(prevRun, run),
        // promotion fields filled below, once every pending row's delta exists
        promotion_recommendation: 'hold',
        promotion_reason: '',
        promotion_samples: 0,
      });
    }
  }

  // Promotion: cumulative evidence per candidate runtime (tool + model),
  // across existing rows plus everything this fold adds — threshold-enforced.
  const identity = r => `${r.agent_tool || ''} ${r.agent_model || ''}`;
  const deltasBy = new Map();
  for (const r of [...existing, ...pendingRows]) {
    if (!Number.isFinite(+r.utility_delta)) continue;
    const key = identity(r);
    if (!deltasBy.has(key)) deltasBy.set(key, []);
    deltasBy.get(key).push(+r.utility_delta);
  }
  for (const row of pendingRows) {
    const rec = shouldPromoteFromReplays(deltasBy.get(identity(row)) || [], config);
    row.promotion_recommendation = rec.promote ? 'promote' : 'hold';
    row.promotion_reason = rec.reason;
    row.promotion_samples = rec.samples;
    appendJsonl(replayLogFile(workspaceDir), row);
  }

  return { appended: pendingRows.length, rows: pendingRows };
}

module.exports = {
  REPLAY_MODES,
  REPLAY_FINGERPRINT_FIELDS,
  replayRuntimeFingerprint,
  fingerprintDiff,
  parseCandidate,
  locateSpec,
  currentSpecHash,
  listExperiments,
  replayExperiment,
  createSuite,
  readSuite,
  listSuites,
  selectSuiteExperiments,
  replaySuite,
  replayReport,
};

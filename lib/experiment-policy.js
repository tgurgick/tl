'use strict';

// Experiment routing policy — transparent primary/shadow selection over local
// priors, with exploration when data is sparse.
//
// This is the learning loop's "policy brain" WITHOUT a private model: a small
// contextual policy over append-only JSONL. It never calls a network or a
// model. It reads what already exists —
//   _metrics/judge-log.jsonl           judged outcomes (winner, status)
//   _metrics/candidate-run-log.jsonl   per-candidate cost/latency/fault rows
//   _metrics/routing-priors.jsonl      the running aggregates this module owns
// — and appends new prior rows; historical rows are never mutated. A future
// private/hosted model can read the same logs and emit the same row shape
// (see createLocalRoutingPolicy in lib/experiment-adapter.js for the seam).
//
// Selection rules (documented in _templates/SCHEMA.md):
//   1. An explicit override always wins: an opts.override (CLI/experiment
//      config) first, else the spec's own `agent:` lane when not `any`.
//   2. Otherwise priors decide — the best weighted score among candidates
//      whose prior has at least `min_samples_to_route` samples, unless the
//      exploration roll fires (`explore_rate`).
//   3. Otherwise explore: pick the least-sampled candidate (round-robin by
//      evidence), ties broken uniformly at random — so with no priors at all
//      the fallback is a plain random pick.
//
// Shadow rules: `all_others` (default), `top_n` (best-scoring N by priors),
// or an explicit list. The judge is excluded from the candidate pool unless
// `allow_judge_candidate: true`.
//
// Prior updates happen ONLY after judged outcomes: an experiment contributes
// observations only once a succeeded judge-log row exists for it, and each
// experiment is folded in exactly once (idempotence via the row's
// `source: "judged:<experiment_id>"` tag).
//
// Promotion is a recommendation, never an action: `shouldPromote` says
// whether a challenger's evidence justifies becoming `default_primary`, and
// requires both `min_samples_to_promote` and a utility delta — a new runtime
// never becomes the default off a single win. Nothing here writes TRIAGE.yml.
//
// The downstream consumer is specs/experiment-auto-initiation: it calls
// `decideRouting(workspaceDir, spec, opts)` on a canonical claim and passes
// the returned `queue_candidates` straight to lib/experiment-queue.js
// `queueExperiment`. Node stdlib only; zero dependencies.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { parseYaml, parseFrontmatter } = require('./parse');
const { extractSpecSections, ROUTING_PRIORS_FILE } = require('./experiment-adapter');

// Textual composite Map-key delimiter (was NUL; keeps source as text for Git/file).
const COMPOSITE_KEY_SEP = '\u241F';

// Every routing-priors.jsonl row carries exactly these fields (SCHEMA.md).
const PRIOR_FIELDS = [
  'date',
  'context_key',
  'agent_tool',
  'agent_model',
  'runtime_fingerprint',
  'expected_quality',
  'expected_cost',
  'expected_latency',
  'success_rate',
  'samples',
  'last_updated',
  'source',
];

// The weighted score over a prior: quality and success push a candidate up;
// cost and latency (normalized against the candidate pool) pull it down.
// "A weighted score over quality, success rate, cost, and latency" — the
// whole model, on purpose.
const DEFAULT_SCORE_WEIGHTS = {
  quality: 0.5,
  success: 0.3,
  cost: 0.1,
  latency: 0.1,
};

const DEFAULT_EXPERIMENTS_CONFIG = {
  enabled: false,
  candidates: [],
  default_primary: '',
  explore_rate: 0.1,
  shadow_mode: 'all_others',
  shadow_top_n: 1,
  judge: '',
  allow_judge_candidate: false,
  budget_usd: null,
  timeout_minutes: null,
  min_samples_to_route: 2,
  min_samples_to_promote: 3,
  promote_utility_delta: 0.1,
};

// ---------- small shared helpers (same shapes as lib/experiment-queue.js) ----------

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function datePart(iso) {
  return iso.slice(0, 10);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a corrupt line never blocks the policy */ }
  }
  return rows;
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function priorsFile(workspaceDir) {
  return path.join(workspaceDir, '_metrics', ROUTING_PRIORS_FILE);
}

// ---------- config (`experiments:` in TRIAGE.yml) ----------

// Normalize the `experiments:` section (or a whole parsed TRIAGE.yml, or
// nothing) to a complete config. Fallback-on-garbage throughout — a broken
// dial degrades to the default, it never throws (same posture as calmCap).
function normalizeExperimentsConfig(input) {
  let src = input && typeof input === 'object' ? input : {};
  if (src.experiments && typeof src.experiments === 'object') src = src.experiments; // whole TRIAGE.yml accepted
  const d = DEFAULT_EXPERIMENTS_CONFIG;
  const num = (v, dflt, min) => (Number.isFinite(+v) && v !== null && v !== '' && +v >= min ? +v : dflt);
  const rate = Number.isFinite(+src.explore_rate) && src.explore_rate !== null && src.explore_rate !== ''
    && +src.explore_rate >= 0 && +src.explore_rate <= 1 ? +src.explore_rate : d.explore_rate;
  const mode = Array.isArray(src.shadow_mode) ? src.shadow_mode.map(String)
    : (src.shadow_mode === 'top_n' || src.shadow_mode === 'all_others' ? src.shadow_mode : d.shadow_mode);
  const judgeSrc = src.judge && typeof src.judge === 'object' ? src.judge : { id: src.judge };
  return {
    ...src, // unknown fields preserved — later specs (auto_initiate, lane caps) extend this section
    enabled: src.enabled === true,
    candidates: normalizeCandidates(src.candidates),
    default_primary: src.default_primary ? String(src.default_primary) : d.default_primary,
    explore_rate: rate,
    shadow_mode: mode,
    shadow_top_n: Math.floor(num(src.shadow_top_n, d.shadow_top_n, 1)),
    judge: judgeSrc.id ? String(judgeSrc.id) : d.judge,
    judge_tool: judgeSrc.agent_tool ? String(judgeSrc.agent_tool) : (judgeSrc.id ? String(judgeSrc.id) : ''),
    allow_judge_candidate: src.allow_judge_candidate === true,
    budget_usd: Number.isFinite(+src.budget_usd) && src.budget_usd !== null && src.budget_usd !== '' ? +src.budget_usd : d.budget_usd,
    timeout_minutes: Number.isFinite(+src.timeout_minutes) && src.timeout_minutes !== null && src.timeout_minutes !== '' ? +src.timeout_minutes : d.timeout_minutes,
    min_samples_to_route: Math.floor(num(src.min_samples_to_route, d.min_samples_to_route, 1)),
    min_samples_to_promote: Math.floor(num(src.min_samples_to_promote, d.min_samples_to_promote, 1)),
    promote_utility_delta: num(src.promote_utility_delta, d.promote_utility_delta, 0),
    weights: { ...DEFAULT_SCORE_WEIGHTS, ...(src.weights && typeof src.weights === 'object' ? src.weights : {}) },
  };
}

// Read + normalize the workspace's `experiments:` config from TRIAGE.yml.
// Absent file or section = the defaults (enabled: false — fully off).
function readExperimentsConfig(workspaceDir) {
  let text;
  try { text = fs.readFileSync(path.join(workspaceDir, 'TRIAGE.yml'), 'utf8'); } catch { text = ''; }
  let cfg;
  try { cfg = parseYaml(text) || {}; } catch { cfg = {}; }
  return normalizeExperimentsConfig(cfg);
}

// Candidates may be strings ('codex') or maps ({ agent_tool, agent_model, id }).
function normalizeCandidates(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const src = typeof c === 'string' ? { agent_tool: c } : (c && typeof c === 'object' ? c : null);
    if (!src || !src.agent_tool) continue;
    const tool = String(src.agent_tool);
    const model = src.agent_model ? String(src.agent_model) : null;
    const id = String(src.id || (model ? `${tool}-${model}` : tool)).toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || tool;
    if (seen.has(id)) continue; // ids must stay unique for queueExperiment
    seen.add(id);
    out.push({ id, agent_tool: tool, agent_model: model });
  }
  return out;
}

// ---------- context keys ----------

// Map file paths to coarse "families": the top-level directory, or an
// extension family for root files. `lib/experiment-policy.js` → `lib`;
// `README.md` → `md`. Sorted, unique, capped — the point is a small, stable
// bucket, not a fingerprint of the exact file list.
function fileFamilies(paths, cap = 4) {
  const fams = new Set();
  for (const p of Array.isArray(paths) ? paths : []) {
    const clean = String(p || '').replace(/`/g, '').trim().replace(/^\.\//, '');
    if (!clean) continue;
    const slash = clean.indexOf('/');
    if (slash > 0) { fams.add(clean.slice(0, slash).toLowerCase()); continue; }
    const dot = clean.lastIndexOf('.');
    fams.add(dot > 0 ? clean.slice(dot + 1).toLowerCase() : 'root');
  }
  return Array.from(fams).sort().slice(0, cap);
}

// Tags that mark a spec as high-risk regardless of anything else.
const HIGH_RISK_TAGS = ['security', 'auth', 'payments', 'billing', 'data-migration', 'migration', 'infra', 'release'];

// Derive the context descriptor from a parsed spec ({ meta, body } — the
// lib/parse.js#parseFrontmatter shape). Risk is a small documented heuristic:
// `p0` priority or a high-risk tag → high, else normal; an explicit
// opts.risk always wins. Required capabilities come from opts (the spec text
// has no way to state them yet).
function specContext(spec, opts = {}) {
  const meta = (spec && spec.meta) || {};
  const body = (spec && spec.body) || '';
  const sections = extractSpecSections(body);
  const tags = (Array.isArray(meta.tags) ? meta.tags : []).map(t => String(t).toLowerCase());
  const risk = opts.risk ? String(opts.risk)
    : (meta.priority === 'p0' || tags.some(t => HIGH_RISK_TAGS.includes(t)) ? 'high' : 'normal');
  return {
    type: meta.type || 'feature',
    size: meta.size || 'medium',
    tags,
    files: sections.allowedFiles,
    risk,
    capabilities: Array.isArray(opts.capabilities) ? opts.capabilities.map(String) : [],
  };
}

// Build the deterministic context key. Accepts a descriptor ({ type, size,
// tags, files, risk, capabilities }) or a parsed spec ({ meta, body }).
// Fixed segments, sorted values, `none` placeholders — the same work always
// produces the same key, which is what makes priors joinable.
function buildContextKey(input, opts = {}) {
  const desc = input && input.meta !== undefined ? specContext(input, opts) : (input || {});
  const seg = (vals, cap) => {
    const list = (Array.isArray(vals) ? vals : []).map(v => String(v).toLowerCase()).filter(Boolean);
    return Array.from(new Set(list)).sort().slice(0, cap).join('+') || 'none';
  };
  return [
    `type=${String(desc.type || 'unknown').toLowerCase()}`,
    `size=${String(desc.size || 'medium').toLowerCase()}`,
    `files=${seg(desc.files !== undefined ? fileFamilies(desc.files) : desc.file_families, 4)}`,
    `tags=${seg(desc.tags, 4)}`,
    `risk=${String(desc.risk || 'normal').toLowerCase()}`,
    `caps=${seg(desc.capabilities, 4)}`,
  ].join('|');
}

// ---------- priors (read + score) ----------

// Current prior view: the LATEST row per (context_key, agent_tool,
// agent_model) — the file is event-sourced like the experiment queue, so
// later aggregates supersede earlier ones without mutating them.
function readPriors(workspaceDir) {
  const current = new Map();
  for (const row of readJsonl(priorsFile(workspaceDir))) {
    if (!row || !row.context_key || !row.agent_tool) continue;
    current.set(`${row.context_key}${COMPOSITE_KEY_SEP}${row.agent_tool}${COMPOSITE_KEY_SEP}${row.agent_model || ''}`, row);
  }
  return Array.from(current.values());
}

// The prior for one candidate in one context. A model-specific prior wins
// over a tool-level one (agent_model null matches any model row for the tool
// only when no exact row exists).
function latestPriorFor(priors, contextKey, candidate) {
  const tool = String(candidate.agent_tool || candidate);
  const model = candidate.agent_model || null;
  const rows = (priors || []).filter(p => p.context_key === contextKey && p.agent_tool === tool);
  if (!rows.length) return null;
  if (model) {
    const exact = rows.find(p => (p.agent_model || null) === model);
    if (exact) return exact;
  }
  return rows.find(p => !model || !p.agent_model) || rows[0];
}

// The weighted score for one prior. Cost and latency are normalized against
// the pool maxima passed in, so the score is comparable within one decision.
function scorePrior(prior, opts = {}) {
  if (!prior) return 0;
  const w = { ...DEFAULT_SCORE_WEIGHTS, ...(opts.weights || {}) };
  const maxCost = Number(opts.maxCost) > 0 ? Number(opts.maxCost) : 0;
  const maxLatency = Number(opts.maxLatency) > 0 ? Number(opts.maxLatency) : 0;
  const quality = Number(prior.expected_quality) || 0;
  const success = Number(prior.success_rate) || 0;
  const cost = maxCost ? (Number(prior.expected_cost) || 0) / maxCost : 0;
  const latency = maxLatency ? (Number(prior.expected_latency) || 0) / maxLatency : 0;
  return round4(w.quality * quality + w.success * success - w.cost * cost - w.latency * latency);
}

// Pool normalization inputs for a set of priors.
function poolMaxima(priorRows) {
  let maxCost = 0, maxLatency = 0;
  for (const p of priorRows) {
    if (!p) continue;
    maxCost = Math.max(maxCost, Number(p.expected_cost) || 0);
    maxLatency = Math.max(maxLatency, Number(p.expected_latency) || 0);
  }
  return { maxCost, maxLatency };
}

// ---------- candidate pool ----------

// The judge never competes unless explicitly allowed — a candidate matching
// the configured judge id or tool is dropped from the pool.
function withoutJudge(candidates, config) {
  if (config.allow_judge_candidate) return candidates.slice();
  const judge = String(config.judge || '').toLowerCase();
  const judgeTool = String(config.judge_tool || '').toLowerCase();
  if (!judge && !judgeTool) return candidates.slice();
  return candidates.filter(c => {
    const id = String(c.id || '').toLowerCase();
    const tool = String(c.agent_tool || '').toLowerCase();
    return id !== judge && tool !== judge && (judgeTool ? tool !== judgeTool && id !== judgeTool : true);
  });
}

function findCandidate(candidates, name) {
  const n = String(name || '').toLowerCase();
  return candidates.find(c => String(c.id).toLowerCase() === n || String(c.agent_tool).toLowerCase() === n) || null;
}

// ---------- primary selection ----------

// Pick the primary candidate. Order of authority:
//   override (opts.override, else spec `agent:` ≠ any)  → source 'override'
//   priors with samples ≥ min_samples_to_route, no explore roll → 'prior'
//   exploration (least-sampled first, ties uniform at random)  → 'explore'
// Returns { candidate, source, reason, context_key, scores } — never null
// candidate as long as any candidate exists.
function selectPrimary(candidates, opts = {}) {
  const config = normalizeExperimentsConfig(opts.config);
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const contextKey = opts.contextKey || '';
  const priors = Array.isArray(opts.priors) ? opts.priors : [];
  const all = normalizeCandidates(candidates && candidates.length ? candidates : config.candidates);
  const pool = withoutJudge(all, config);
  if (!pool.length) return { candidate: null, source: 'none', reason: 'no eligible candidates', context_key: contextKey, scores: {} };

  // 1. Explicit override wins — human intent is never re-decided by priors.
  const overrideName = opts.override
    || (opts.spec && opts.spec.meta && opts.spec.meta.agent && String(opts.spec.meta.agent) !== 'any'
      ? String(opts.spec.meta.agent) : null);
  if (overrideName) {
    const named = findCandidate(all, overrideName)
      || { id: String(overrideName).toLowerCase(), agent_tool: String(overrideName), agent_model: null };
    return {
      candidate: named, source: 'override', context_key: contextKey, scores: {},
      reason: opts.override ? `explicit override: ${overrideName}` : `spec agent lane: ${overrideName}`,
    };
  }

  // Score every candidate's prior once; the same table drives 2 and 3.
  const priorByid = new Map(pool.map(c => [c.id, latestPriorFor(priors, contextKey, c)]));
  const maxima = poolMaxima(Array.from(priorByid.values()));
  const scores = {};
  for (const c of pool) scores[c.id] = scorePrior(priorByid.get(c.id), { weights: config.weights, ...maxima });

  // 2. Priors above threshold — unless the exploration roll fires.
  const routable = pool.filter(c => {
    const p = priorByid.get(c.id);
    return p && (Number(p.samples) || 0) >= config.min_samples_to_route;
  });
  if (routable.length && rng() >= config.explore_rate) {
    let best = routable[0];
    for (const c of routable) if (scores[c.id] > scores[best.id]) best = c;
    return {
      candidate: best, source: 'prior', context_key: contextKey, scores,
      reason: `best prior score ${scores[best.id]} over ${routable.length} routable candidate(s) (samples ≥ ${config.min_samples_to_route})`,
    };
  }

  // 3. Explore: least evidence first (round-robin by samples), random ties.
  const samplesOf = c => { const p = priorByid.get(c.id); return p ? Number(p.samples) || 0 : 0; };
  const least = Math.min(...pool.map(samplesOf));
  const ties = pool.filter(c => samplesOf(c) === least);
  const pick = ties[Math.min(ties.length - 1, Math.floor(rng() * ties.length))];
  return {
    candidate: pick, source: 'explore', context_key: contextKey, scores,
    reason: routable.length
      ? `exploration roll (< explore_rate ${config.explore_rate}) — least-sampled of ${pool.length}`
      : `no prior with ≥ ${config.min_samples_to_route} samples for this context — exploring least-sampled of ${pool.length}`,
  };
}

// ---------- shadow selection ----------

// Pick the shadow cohort for a chosen primary. `shadow_mode`:
//   'all_others'  every other (non-judge) candidate         — the default
//   'top_n'       best `shadow_top_n` others by prior score
//   [list]        the explicit named lanes, in list order
// The judge stays excluded unless `allow_judge_candidate: true`, and the
// primary never shadows itself.
function selectShadows(candidates, primary, opts = {}) {
  const config = normalizeExperimentsConfig(opts.config);
  const contextKey = opts.contextKey || '';
  const priors = Array.isArray(opts.priors) ? opts.priors : [];
  const all = normalizeCandidates(candidates && candidates.length ? candidates : config.candidates);
  const primaryId = primary ? String(primary.id || primary).toLowerCase() : '';
  const pool = withoutJudge(all, config)
    .filter(c => String(c.id).toLowerCase() !== primaryId
      && String(c.agent_tool).toLowerCase() !== primaryId);

  const mode = opts.mode !== undefined ? opts.mode : config.shadow_mode;

  if (Array.isArray(mode)) {
    const shadows = [];
    for (const name of mode) {
      const c = findCandidate(pool, name);
      if (c && !shadows.includes(c)) shadows.push(c);
    }
    return { shadows, mode: 'explicit', reason: `explicit shadow list (${mode.length} named, ${shadows.length} eligible)` };
  }

  if (mode === 'top_n') {
    const priorById = new Map(pool.map(c => [c.id, latestPriorFor(priors, contextKey, c)]));
    const maxima = poolMaxima(Array.from(priorById.values()));
    const scored = pool.map(c => ({ c, score: scorePrior(priorById.get(c.id), { weights: config.weights, ...maxima }) }));
    scored.sort((a, b) => b.score - a.score);
    const shadows = scored.slice(0, config.shadow_top_n).map(s => s.c);
    return { shadows, mode: 'top_n', reason: `top ${config.shadow_top_n} of ${pool.length} by prior score` };
  }

  return { shadows: pool, mode: 'all_others', reason: `all ${pool.length} other candidate(s)` };
}

// ---------- prior updates (only after judged outcomes) ----------

// A compact fingerprint of the runtime identity on a candidate-run-log row —
// the 9 shared fingerprint fields hashed to a short stable id.
function fingerprintKey(row) {
  const fields = ['agent_tool', 'agent_model', 'agent_model_auto', 'agent_model_source',
    'runtime_version', 'framework', 'adapter_version', 'rules_hash', 'skills_hash'];
  const canon = fields.map(f => `${f}=${row && row[f] !== undefined && row[f] !== null ? String(row[f]) : ''}`).join('|');
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

// Resolve the context key for a historical experiment: reread the spec named
// by its candidate rows (searching every lifecycle stage — specs move), else
// degrade to a minimal type-only key. Best effort, never throws.
const STAGE_FOLDERS = ['specs', 'in-progress', 'tests', 'in-review', 'done', 'triage'];

function contextKeyForLoggedRun(workspaceDir, row) {
  const specRel = String(row.tl_spec || '').replace(/^\/+/, '');
  if (specRel) {
    const tries = [];
    tries.push(specRel.endsWith('.md')
      ? path.join(workspaceDir, specRel)
      : path.join(workspaceDir, specRel.replace(/\/+$/, ''), 'SPEC.md'));
    const slug = specRel.replace(/\/+$/, '').split('/').pop().replace(/\.md$/, '');
    for (const stage of STAGE_FOLDERS) tries.push(path.join(workspaceDir, stage, slug, 'SPEC.md'));
    for (const file of tries) {
      try {
        return buildContextKey(parseFrontmatter(fs.readFileSync(file, 'utf8')));
      } catch { /* try the next stage */ }
    }
  }
  return buildContextKey({ type: row.task_type || 'unknown', size: 'medium' });
}

// Fold judged outcomes into routing priors. Reads judge-log.jsonl and
// candidate-run-log.jsonl, finds experiments with a succeeded judge row that
// have NOT been folded in yet (idempotence: `source: "judged:<id>"` on prior
// rows), and appends one updated aggregate row per (context, tool, model)
// observation. Quality observation per candidate:
//   won the experiment           → 1.0
//   succeeded but did not win    → 0.5
//   faulted (any non-succeeded)  → 0.0
// Aggregates are running means; unknown cost/latency count as 0. Historical
// rows are never edited — every update is a new line.
function updatePriorsFromLogs(workspaceDir, opts = {}) {
  const nowIso = isoNow(opts.now);
  const judgeRows = readJsonl(path.join(workspaceDir, '_metrics', 'judge-log.jsonl'));
  const candRows = readJsonl(path.join(workspaceDir, '_metrics', 'candidate-run-log.jsonl'));

  // Latest succeeded judge row per experiment — the "judged" gate.
  const judged = new Map();
  for (const j of judgeRows) {
    if (j && j.experiment_id && j.status === 'succeeded') judged.set(j.experiment_id, j);
  }

  // Latest candidate row per (experiment, candidate) — retries supersede.
  const candidates = new Map();
  for (const r of candRows) {
    if (r && r.experiment_id && r.candidate_id) candidates.set(`${r.experiment_id}${COMPOSITE_KEY_SEP}${r.candidate_id}`, r);
  }

  // Already-folded experiments, from existing prior rows' source tags.
  const existing = readJsonl(priorsFile(workspaceDir));
  const processed = new Set();
  for (const p of existing) {
    const m = String(p && p.source || '').match(/^judged:(.+)$/);
    if (m) processed.add(m[1]);
  }

  // Live aggregate view keyed like readPriors, updated as we fold — so two
  // new experiments in one pass chain correctly.
  const live = new Map();
  for (const p of existing) {
    if (!p || !p.context_key || !p.agent_tool) continue;
    live.set(`${p.context_key}${COMPOSITE_KEY_SEP}${p.agent_tool}${COMPOSITE_KEY_SEP}${p.agent_model || ''}`, p);
  }

  const pending = Array.from(judged.keys()).filter(id => !processed.has(id))
    .sort((a, b) => String(judged.get(a).date || '').localeCompare(String(judged.get(b).date || '')) || a.localeCompare(b));

  const appended = [];
  for (const expId of pending) {
    const judge = judged.get(expId);
    const runs = Array.from(candidates.values()).filter(r => r.experiment_id === expId);
    if (!runs.length) continue; // judged but no candidate rows — nothing to learn from
    for (const run of runs.sort((a, b) => String(a.candidate_id).localeCompare(String(b.candidate_id)))) {
      const contextKey = contextKeyForLoggedRun(workspaceDir, run);
      const won = judge.winner && judge.winner === run.candidate_id;
      const succeeded = run.status === 'succeeded';
      const quality = won ? 1.0 : (succeeded ? 0.5 : 0.0);
      const cost = Number(run.cost_usd) || 0;
      const latency = Number(run.duration_minutes) || 0;
      const tool = String(run.agent_tool || 'unknown');
      const model = run.agent_model && run.agent_model !== 'unknown' ? String(run.agent_model) : null;

      const key = `${contextKey}${COMPOSITE_KEY_SEP}${tool}${COMPOSITE_KEY_SEP}${model || ''}`;
      const prev = live.get(key);
      const n = prev ? Number(prev.samples) || 0 : 0;
      const mean = (field, x) => round4(((prev ? Number(prev[field]) || 0 : 0) * n + x) / (n + 1));
      const row = {
        date: datePart(nowIso),
        context_key: contextKey,
        agent_tool: tool,
        agent_model: model,
        runtime_fingerprint: fingerprintKey(run),
        expected_quality: mean('expected_quality', quality),
        expected_cost: mean('expected_cost', cost),
        expected_latency: mean('expected_latency', latency),
        success_rate: mean('success_rate', succeeded ? 1 : 0),
        samples: n + 1,
        last_updated: nowIso,
        source: `judged:${expId}`,
      };
      appendJsonl(priorsFile(workspaceDir), row);
      live.set(key, row);
      appended.push(row);
    }
    processed.add(expId);
  }

  return { appended: appended.length, experiments: pending, rows: appended };
}

// ---------- promotion (recommendation only — nothing writes TRIAGE.yml) ----------

// Should `challenger` (a prior row) replace the incumbent as
// `default_primary`? Requires BOTH enough evidence (min_samples_to_promote)
// AND a real utility edge (promote_utility_delta) — a single win never
// promotes. Pure: returns { promote, reason, delta }; acting on it is a
// human/TRIAGE.yml edit, never this module.
function shouldPromote(challenger, incumbent, config) {
  const cfg = normalizeExperimentsConfig(config);
  if (!challenger) return { promote: false, delta: 0, reason: 'no challenger prior — nothing observed yet' };
  const samples = Number(challenger.samples) || 0;
  if (samples < cfg.min_samples_to_promote) {
    return {
      promote: false, delta: 0,
      reason: `insufficient samples: ${samples} < min_samples_to_promote ${cfg.min_samples_to_promote} — a new runtime never becomes default from a single win`,
    };
  }
  const maxima = poolMaxima([challenger, incumbent]);
  const challengerScore = scorePrior(challenger, { weights: cfg.weights, ...maxima });
  const incumbentScore = scorePrior(incumbent, { weights: cfg.weights, ...maxima });
  const delta = round4(challengerScore - incumbentScore);
  if (delta < cfg.promote_utility_delta) {
    return { promote: false, delta, reason: `utility delta ${delta} < promote_utility_delta ${cfg.promote_utility_delta}` };
  }
  return { promote: true, delta, reason: `delta ${delta} ≥ ${cfg.promote_utility_delta} over ${samples} samples` };
}

// Replay flavor of the same promotion policy (lib/experiment-replay.js):
// the evidence is a list of per-replay utility deltas (new candidate minus
// previous winner, from replay-log.jsonl) instead of prior rows. The SAME
// thresholds apply — at least `min_samples_to_promote` comparisons AND a mean
// delta of at least `promote_utility_delta` — so a new runtime never becomes
// the recommended default off a single replay win. Note the units: replay
// deltas are judge-utility points (rubric scale), while shouldPromote's delta
// is in weighted-prior-score units; `promote_utility_delta` is the shared,
// configurable bar for both. Pure recommendation — nothing writes TRIAGE.yml.
function shouldPromoteFromReplays(utilityDeltas, config) {
  const cfg = normalizeExperimentsConfig(config);
  // Strict: only finite NUMBERS count as evidence — null/booleans/strings
  // never coerce into fake zero-delta samples.
  const deltas = (Array.isArray(utilityDeltas) ? utilityDeltas : []).filter(d => typeof d === 'number' && Number.isFinite(d));
  const samples = deltas.length;
  const mean = samples ? round4(deltas.reduce((a, b) => a + b, 0) / samples) : 0;
  if (samples < cfg.min_samples_to_promote) {
    return {
      promote: false, samples, mean_delta: mean,
      reason: `insufficient replay samples: ${samples} < min_samples_to_promote ${cfg.min_samples_to_promote} — a new runtime never becomes default from a single win`,
    };
  }
  if (mean < cfg.promote_utility_delta) {
    return { promote: false, samples, mean_delta: mean, reason: `mean utility delta ${mean} < promote_utility_delta ${cfg.promote_utility_delta} over ${samples} replay(s)` };
  }
  return { promote: true, samples, mean_delta: mean, reason: `mean utility delta ${mean} ≥ ${cfg.promote_utility_delta} over ${samples} replay(s)` };
}

// ---------- the auto-initiation entry point ----------

// One call that answers: "this spec is being claimed — should experiments
// run, and with which lanes?" Reads TRIAGE.yml (or takes opts.config), builds
// the context key, reads priors, selects primary + shadows, and returns a
// decision whose `queue_candidates` feeds lib/experiment-queue.js
// `queueExperiment(workspaceDir, { candidates: decision.queue_candidates,
// judge, budgetUsd, timeoutMinutes })` directly. Read-only: it never queues,
// never logs, never mutates — the caller owns side effects.
//
//   workspaceDir  the workspace root (holds TRIAGE.yml, _metrics/)
//   spec          parsed spec ({ meta, body }) — lib/parse.js#parseFrontmatter
//   opts          { config, override, rng, capabilities, risk, priors }
function decideRouting(workspaceDir, spec, opts = {}) {
  const config = opts.config !== undefined
    ? normalizeExperimentsConfig(opts.config)
    : readExperimentsConfig(workspaceDir);

  if (!config.enabled) {
    return { enabled: false, config, primary: null, shadows: [], queue_candidates: [], context_key: '', reason: 'experiments disabled (experiments.enabled is not true)' };
  }
  if (!config.candidates.length) {
    return { enabled: true, config, primary: null, shadows: [], queue_candidates: [], context_key: '', reason: 'no candidates configured (experiments.candidates is empty)' };
  }

  const contextKey = buildContextKey(spec, { capabilities: opts.capabilities, risk: opts.risk });
  const priors = Array.isArray(opts.priors) ? opts.priors : readPriors(workspaceDir);

  const primary = selectPrimary(config.candidates, {
    config, contextKey, priors, spec, override: opts.override, rng: opts.rng,
  });
  if (!primary.candidate) {
    return { enabled: true, config, primary: null, shadows: [], queue_candidates: [], context_key: contextKey, reason: primary.reason };
  }
  const shadowSel = selectShadows(config.candidates, primary.candidate, { config, contextKey, priors });

  const queueCandidates = [
    { id: primary.candidate.id, role: 'primary', agent_tool: primary.candidate.agent_tool, agent_model: primary.candidate.agent_model },
    ...shadowSel.shadows.map(s => ({ id: s.id, role: 'shadow', agent_tool: s.agent_tool, agent_model: s.agent_model })),
  ];

  return {
    enabled: true,
    config,
    context_key: contextKey,
    primary: { ...primary.candidate, source: primary.source, reason: primary.reason },
    shadows: shadowSel.shadows.slice(),
    shadow_mode: shadowSel.mode,
    scores: primary.scores,
    judge: config.judge ? { id: config.judge, agent_tool: config.judge_tool || config.judge } : null,
    budget_usd: config.budget_usd,
    timeout_minutes: config.timeout_minutes,
    queue_candidates: queueCandidates,
    reason: `primary ${primary.candidate.id} via ${primary.source} (${primary.reason}); shadows: ${shadowSel.reason}`,
  };
}

module.exports = {
  PRIOR_FIELDS,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_EXPERIMENTS_CONFIG,
  normalizeExperimentsConfig,
  readExperimentsConfig,
  normalizeCandidates,
  fileFamilies,
  specContext,
  buildContextKey,
  readPriors,
  latestPriorFor,
  scorePrior,
  selectPrimary,
  selectShadows,
  updatePriorsFromLogs,
  shouldPromote,
  shouldPromoteFromReplays,
  decideRouting,
};

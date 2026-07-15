'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PRIOR_FIELDS,
  normalizeExperimentsConfig,
  normalizeCandidates,
  fileFamilies,
  buildContextKey,
  readPriors,
  latestPriorFor,
  scorePrior,
  selectPrimary,
  selectShadows,
  updatePriorsFromLogs,
  shouldPromote,
  decideRouting,
} = require('../lib/experiment-policy');

// ---------- fixtures ----------

const SPEC_MD = [
  '---',
  'title: "Demo spec"',
  'created: 2026-07-10',
  'type: "feature"',
  'size: "medium"',
  'tags: [experiments, routing]',
  '---',
  '',
  '# Demo spec',
  '',
  '## Objective',
  '',
  'Do a demo thing.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] It works',
  '',
  '## Scope',
  '',
  '### Files to touch',
  '',
  '- `lib/demo.js` - the thing',
  '- `test/demo.test.js` - its tests',
  '',
].join('\n');

function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-policy-ws-'));
  const specDir = path.join(ws, 'specs', 'demo');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'SPEC.md'), SPEC_MD);
  fs.mkdirSync(path.join(ws, '_metrics'), { recursive: true });
  return ws;
}

function appendLine(ws, file, row) {
  fs.appendFileSync(path.join(ws, '_metrics', file), JSON.stringify(row) + '\n');
}

function parsedSpec(ws) {
  const { parseFrontmatter } = require('../lib/parse');
  return parseFrontmatter(fs.readFileSync(path.join(ws, 'specs', 'demo', 'SPEC.md'), 'utf8'));
}

// An rng stub that returns the given values in order (then the last forever).
function seq(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function candRunRow(expId, candidateId, over = {}) {
  return {
    date: '2026-07-10', experiment_id: expId, task_type: 'tl_spec', tl_spec: 'specs/demo/',
    spec_hash: 'abc', base_commit: 'def', candidate_id: candidateId, role: over.role || 'primary',
    status: 'succeeded', fault: null, agent_tool: candidateId.split('-')[0], agent_model: 'm1',
    agent_model_auto: false, agent_model_source: 'requested', runtime_version: '1', framework: 'x',
    adapter_version: '1', rules_hash: '', skills_hash: '', duration_minutes: 10, cost_usd: 1,
    tokens_used: 0, patch_path: '', trace_path: '', ...over,
  };
}

function judgeRow(expId, winner, over = {}) {
  return {
    date: '2026-07-11', experiment_id: expId, judge_id: 'judge-1', judge_agent: 'fixture',
    judge_model: 'deterministic', status: 'succeeded', winner, winner_set_by: 'judge',
    rationale: 'test', scores_path: '', evaluation_path: '', utility: 4, hard_gates_passed: true,
    duration_minutes: 1, cost_usd: 0, tokens_used: 0, ...over,
  };
}

const THREE_LANES = ['claude', 'codex', 'cursor'];

function prior(contextKey, tool, over = {}) {
  return {
    date: '2026-07-10', context_key: contextKey, agent_tool: tool, agent_model: null,
    runtime_fingerprint: 'fp', expected_quality: 0.5, expected_cost: 1, expected_latency: 10,
    success_rate: 1, samples: 5, last_updated: '2026-07-10T00:00:00.000Z', source: 'judged:exp-x', ...over,
  };
}

// ---------- config ----------

test('normalizeExperimentsConfig: defaults, whole-TRIAGE acceptance, garbage fallback', () => {
  const dflt = normalizeExperimentsConfig(null);
  assert.equal(dflt.enabled, false);
  assert.deepEqual(dflt.candidates, []);
  assert.equal(dflt.explore_rate, 0.1);
  assert.equal(dflt.shadow_mode, 'all_others');
  assert.equal(dflt.min_samples_to_promote, 3);

  // A whole parsed TRIAGE.yml is accepted (the experiments key is unwrapped).
  const cfg = normalizeExperimentsConfig({
    goals: [], experiments: { enabled: true, candidates: THREE_LANES, explore_rate: 0.25, judge: 'fixture-judge' },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.candidates.length, 3);
  assert.equal(cfg.explore_rate, 0.25);
  assert.equal(cfg.judge, 'fixture-judge');

  // Garbage degrades to defaults, never throws.
  const bad = normalizeExperimentsConfig({ enabled: 'yes', explore_rate: 7, shadow_top_n: -2, min_samples_to_promote: 'lots' });
  assert.equal(bad.enabled, false); // only literal true enables
  assert.equal(bad.explore_rate, 0.1);
  assert.equal(bad.shadow_top_n, 1);
  assert.equal(bad.min_samples_to_promote, 3);

  // Unknown fields are preserved for later specs (auto_initiate, etc).
  const ext = normalizeExperimentsConfig({ enabled: true, auto_initiate: true, candidates: ['claude'] });
  assert.equal(ext.auto_initiate, true);
});

test('normalizeCandidates: strings, maps, dedup, id shape', () => {
  const cands = normalizeCandidates(['claude', { agent_tool: 'codex', agent_model: 'gpt-5' }, 'claude', { nope: true }]);
  assert.deepEqual(cands.map(c => c.id), ['claude', 'codex-gpt-5']);
  assert.equal(cands[1].agent_model, 'gpt-5');
});

// ---------- context keys ----------

test('buildContextKey: deterministic, ordered segments, file families', () => {
  assert.deepEqual(fileFamilies(['lib/a.js', 'lib/b.js', 'test/a.test.js', 'README.md']), ['lib', 'md', 'test']);

  const ws = mkWorkspace();
  const key = buildContextKey(parsedSpec(ws));
  assert.equal(key, 'type=feature|size=medium|files=lib+test|tags=experiments+routing|risk=normal|caps=none');
  // Same spec → same key, always.
  assert.equal(buildContextKey(parsedSpec(ws)), key);

  // Descriptor form; capabilities and risk feed the key.
  const dkey = buildContextKey({ type: 'bug', size: 'small', files: ['ui/index.html'], tags: ['security'], risk: 'high', capabilities: ['headless'] });
  assert.equal(dkey, 'type=bug|size=small|files=ui|tags=security|risk=high|caps=headless');
});

test('buildContextKey: p0 or risky tags derive risk=high from a spec', () => {
  const { parseFrontmatter } = require('../lib/parse');
  const spec = parseFrontmatter('---\ntitle: "x"\ntype: "bug"\npriority: "p0"\n---\nbody');
  assert.match(buildContextKey(spec), /risk=high/);
  const tagged = parseFrontmatter('---\ntitle: "x"\ntags: [security]\n---\nbody');
  assert.match(buildContextKey(tagged), /risk=high/);
});

// ---------- primary selection ----------

test('selectPrimary: no priors → random exploration fallback', () => {
  const config = { enabled: true, candidates: THREE_LANES };
  // rng drives which of the zero-sample ties is picked — all candidates reachable.
  const first = selectPrimary(THREE_LANES, { config, contextKey: 'k', priors: [], rng: seq(0.0) });
  assert.equal(first.source, 'explore');
  assert.equal(first.candidate.id, 'claude');
  const last = selectPrimary(THREE_LANES, { config, contextKey: 'k', priors: [], rng: seq(0.99) });
  assert.equal(last.source, 'explore');
  assert.equal(last.candidate.id, 'cursor');
  assert.match(first.reason, /no prior with ≥ 2 samples/);
});

test('selectPrimary: explicit override wins over priors', () => {
  const priors = [prior('k', 'claude', { expected_quality: 1, samples: 50 })];
  const config = { enabled: true, candidates: THREE_LANES };
  const sel = selectPrimary(THREE_LANES, { config, contextKey: 'k', priors, override: 'cursor', rng: seq(0.9) });
  assert.equal(sel.source, 'override');
  assert.equal(sel.candidate.agent_tool, 'cursor');

  // The spec's own `agent:` lane is an override too.
  const spec = { meta: { agent: 'codex' }, body: '' };
  const laneSel = selectPrimary(THREE_LANES, { config, contextKey: 'k', priors, spec, rng: seq(0.9) });
  assert.equal(laneSel.source, 'override');
  assert.equal(laneSel.candidate.agent_tool, 'codex');

  // agent: any is NOT an override.
  const anySel = selectPrimary(THREE_LANES, { config, contextKey: 'k', priors, spec: { meta: { agent: 'any' }, body: '' }, rng: seq(0.9) });
  assert.notEqual(anySel.source, 'override');
});

test('selectPrimary: prior-based selection picks the best-scoring routable candidate', () => {
  const priors = [
    prior('k', 'claude', { expected_quality: 0.9, success_rate: 1, expected_cost: 1, expected_latency: 10, samples: 6 }),
    prior('k', 'codex', { expected_quality: 0.4, success_rate: 0.8, expected_cost: 0.3, expected_latency: 5, samples: 6 }),
    // cursor has evidence but below the routing threshold — not routable.
    prior('k', 'cursor', { expected_quality: 1, samples: 1 }),
  ];
  const config = { enabled: true, candidates: THREE_LANES, explore_rate: 0.1 };
  const sel = selectPrimary(THREE_LANES, { config, contextKey: 'k', priors, rng: seq(0.9) }); // 0.9 ≥ explore_rate → exploit
  assert.equal(sel.source, 'prior');
  assert.equal(sel.candidate.agent_tool, 'claude');
  assert.ok(sel.scores.claude > sel.scores.codex);
});

test('selectPrimary: exploration roll fires even when priors exist', () => {
  const priors = [
    prior('k', 'claude', { expected_quality: 0.9, samples: 10 }),
    prior('k', 'codex', { expected_quality: 0.2, samples: 2 }),
  ];
  const config = { enabled: true, candidates: THREE_LANES, explore_rate: 0.2 };
  // roll 0.05 < 0.2 → explore; cursor has 0 samples → least-sampled pick.
  const sel = selectPrimary(THREE_LANES, { config, contextKey: 'k', priors, rng: seq(0.05, 0.0) });
  assert.equal(sel.source, 'explore');
  assert.equal(sel.candidate.agent_tool, 'cursor');
  assert.match(sel.reason, /exploration roll/);
});

test('selectPrimary: judge is excluded from the pool unless explicitly allowed', () => {
  const config = { enabled: true, candidates: ['claude', 'fixture-judge'], judge: 'fixture-judge' };
  const sel = selectPrimary([], { config, contextKey: 'k', priors: [], rng: seq(0.5, 0.99) });
  assert.equal(sel.candidate.id, 'claude'); // judge never picked even at the top of the rng range

  const allowed = { ...config, allow_judge_candidate: true };
  const sel2 = selectPrimary([], { config: allowed, contextKey: 'k', priors: [], rng: seq(0.5, 0.99) });
  assert.equal(sel2.candidate.id, 'fixture-judge');
});

// ---------- shadow selection ----------

test('selectShadows: all_others excludes the primary and the judge', () => {
  const config = { enabled: true, candidates: [...THREE_LANES, 'fixture-judge'], judge: 'fixture-judge' };
  const primary = { id: 'claude', agent_tool: 'claude', agent_model: null };
  const res = selectShadows([], primary, { config });
  assert.deepEqual(res.shadows.map(s => s.id).sort(), ['codex', 'cursor']);
  assert.equal(res.mode, 'all_others');
});

test('selectShadows: top_n ranks by prior score', () => {
  const priors = [
    prior('k', 'codex', { expected_quality: 0.9, samples: 5 }),
    prior('k', 'cursor', { expected_quality: 0.1, samples: 5 }),
  ];
  const config = { enabled: true, candidates: THREE_LANES, shadow_mode: 'top_n', shadow_top_n: 1 };
  const primary = { id: 'claude', agent_tool: 'claude', agent_model: null };
  const res = selectShadows([], primary, { config, contextKey: 'k', priors });
  assert.equal(res.mode, 'top_n');
  assert.deepEqual(res.shadows.map(s => s.id), ['codex']);
});

test('selectShadows: explicit list honors order, still excludes primary and judge', () => {
  const config = { enabled: true, candidates: [...THREE_LANES, 'fixture-judge'], judge: 'fixture-judge', shadow_mode: ['cursor', 'claude', 'fixture-judge'] };
  const primary = { id: 'claude', agent_tool: 'claude', agent_model: null };
  const res = selectShadows([], primary, { config });
  assert.equal(res.mode, 'explicit');
  assert.deepEqual(res.shadows.map(s => s.id), ['cursor']); // claude is primary, judge excluded
});

// ---------- prior updates ----------

test('updatePriorsFromLogs: judged outcomes fold into append-only aggregates', () => {
  const ws = mkWorkspace();
  // Experiment 1: claude-a wins, codex-b succeeded-not-winner.
  appendLine(ws, 'candidate-run-log.jsonl', candRunRow('exp-1', 'claude-a', { agent_tool: 'claude', cost_usd: 2, duration_minutes: 20 }));
  appendLine(ws, 'candidate-run-log.jsonl', candRunRow('exp-1', 'codex-b', { agent_tool: 'codex', role: 'shadow', cost_usd: 1, duration_minutes: 10 }));
  appendLine(ws, 'judge-log.jsonl', judgeRow('exp-1', 'claude-a'));
  // Experiment 2: codex-b faulted; claude-a wins again.
  appendLine(ws, 'candidate-run-log.jsonl', candRunRow('exp-2', 'claude-a', { agent_tool: 'claude', cost_usd: 4, duration_minutes: 10 }));
  appendLine(ws, 'candidate-run-log.jsonl', candRunRow('exp-2', 'codex-b', { agent_tool: 'codex', role: 'shadow', status: 'timed_out', fault: 'timed_out', cost_usd: 0, duration_minutes: 30 }));
  appendLine(ws, 'judge-log.jsonl', judgeRow('exp-2', 'claude-a', { date: '2026-07-12' }));
  // An UNJUDGED experiment must not update priors.
  appendLine(ws, 'candidate-run-log.jsonl', candRunRow('exp-3', 'cursor-c', { agent_tool: 'cursor' }));

  const res = updatePriorsFromLogs(ws, { now: new Date('2026-07-12T10:00:00Z') });
  assert.deepEqual(res.experiments, ['exp-1', 'exp-2']);
  assert.equal(res.appended, 4);

  const priors = readPriors(ws);
  const claude = priors.find(p => p.agent_tool === 'claude');
  const codex = priors.find(p => p.agent_tool === 'codex');
  assert.ok(claude && codex);
  assert.equal(priors.some(p => p.agent_tool === 'cursor'), false); // unjudged → no prior

  // Row shape matches the documented schema exactly.
  assert.deepEqual(Object.keys(claude).sort(), [...PRIOR_FIELDS].sort());

  // claude: won twice → quality 1.0, success 1.0, mean cost 3, mean latency 15, samples 2.
  assert.equal(claude.samples, 2);
  assert.equal(claude.expected_quality, 1);
  assert.equal(claude.success_rate, 1);
  assert.equal(claude.expected_cost, 3);
  assert.equal(claude.expected_latency, 15);
  // Context key resolved from the real spec (specs move — slug search covers it).
  assert.equal(claude.context_key, 'type=feature|size=medium|files=lib+test|tags=experiments+routing|risk=normal|caps=none');

  // codex: succeeded-not-winner (0.5) then fault (0.0) → quality 0.25, success 0.5.
  assert.equal(codex.samples, 2);
  assert.equal(codex.expected_quality, 0.25);
  assert.equal(codex.success_rate, 0.5);

  // Append-only: 4 lines on disk, and a rerun is idempotent (nothing new).
  const file = path.join(ws, '_metrics', 'routing-priors.jsonl');
  const lineCount = () => fs.readFileSync(file, 'utf8').trim().split('\n').length;
  assert.equal(lineCount(), 4);
  const again = updatePriorsFromLogs(ws);
  assert.equal(again.appended, 0);
  assert.equal(lineCount(), 4); // historical rows untouched, no rewrites

  // Judging exp-3 later folds exactly that experiment in.
  appendLine(ws, 'judge-log.jsonl', judgeRow('exp-3', 'cursor-c', { date: '2026-07-12' }));
  const third = updatePriorsFromLogs(ws);
  assert.deepEqual(third.experiments, ['exp-3']);
  assert.equal(lineCount(), 5);
  assert.equal(readPriors(ws).find(p => p.agent_tool === 'cursor').expected_quality, 1);
});

test('latestPriorFor / scorePrior: model-specific prior beats tool-level; cost pulls score down', () => {
  const rows = [
    prior('k', 'codex', { agent_model: null, expected_quality: 0.3 }),
    prior('k', 'codex', { agent_model: 'gpt-5', expected_quality: 0.9 }),
  ];
  const exact = latestPriorFor(rows, 'k', { agent_tool: 'codex', agent_model: 'gpt-5' });
  assert.equal(exact.expected_quality, 0.9);
  const toolLevel = latestPriorFor(rows, 'k', { agent_tool: 'codex' });
  assert.equal(toolLevel.expected_quality, 0.3);

  const cheap = scorePrior(prior('k', 'a', { expected_quality: 0.8, expected_cost: 1, expected_latency: 10 }), { maxCost: 10, maxLatency: 10 });
  const pricey = scorePrior(prior('k', 'b', { expected_quality: 0.8, expected_cost: 10, expected_latency: 10 }), { maxCost: 10, maxLatency: 10 });
  assert.ok(cheap > pricey);
});

// ---------- promotion ----------

test('shouldPromote: low samples never promote, even on a perfect record', () => {
  const config = { min_samples_to_promote: 3, promote_utility_delta: 0.1 };
  const challenger = prior('k', 'codex', { expected_quality: 1, success_rate: 1, samples: 1 });
  const incumbent = prior('k', 'claude', { expected_quality: 0.2, success_rate: 0.5, samples: 20 });
  const res = shouldPromote(challenger, incumbent, config);
  assert.equal(res.promote, false);
  assert.match(res.reason, /insufficient samples: 1 < min_samples_to_promote 3/);
});

test('shouldPromote: needs the utility delta too; promotes when both hold', () => {
  const config = { min_samples_to_promote: 3, promote_utility_delta: 0.1 };
  const incumbent = prior('k', 'claude', { expected_quality: 0.78, success_rate: 1, samples: 20 });
  // Enough samples but nearly identical utility → no promotion.
  const close = prior('k', 'codex', { expected_quality: 0.8, success_rate: 1, samples: 5 });
  const resClose = shouldPromote(close, incumbent, config);
  assert.equal(resClose.promote, false);
  assert.match(resClose.reason, /utility delta/);
  // Clearly better with evidence → promote.
  const better = prior('k', 'codex', { expected_quality: 1, success_rate: 1, expected_cost: 0.1, expected_latency: 1, samples: 5 });
  const resBetter = shouldPromote(better, prior('k', 'claude', { expected_quality: 0.4, success_rate: 0.6, samples: 20 }), config);
  assert.equal(resBetter.promote, true);
  assert.ok(resBetter.delta >= 0.1);

  // No challenger evidence at all → never promote.
  assert.equal(shouldPromote(null, incumbent, config).promote, false);
});

// ---------- decideRouting (the auto-initiation entry point) ----------

test('decideRouting: disabled or unconfigured stays inert', () => {
  const ws = mkWorkspace();
  const off = decideRouting(ws, parsedSpec(ws)); // no TRIAGE.yml at all
  assert.equal(off.enabled, false);
  assert.deepEqual(off.queue_candidates, []);

  fs.writeFileSync(path.join(ws, 'TRIAGE.yml'), 'experiments:\n  enabled: true\n');
  const noCands = decideRouting(ws, parsedSpec(ws));
  assert.equal(noCands.enabled, true);
  assert.equal(noCands.primary, null);
  assert.match(noCands.reason, /no candidates configured/);
});

test('decideRouting: end-to-end — TRIAGE.yml config to queue-ready candidates', () => {
  const ws = mkWorkspace();
  fs.writeFileSync(path.join(ws, 'TRIAGE.yml'), [
    'experiments:',
    '  enabled: true',
    '  candidates: [claude, codex, cursor]',
    '  judge: "fixture-judge"',
    '  explore_rate: 0.1',
    '  budget_usd: 2.5',
    '  timeout_minutes: 30',
    '',
  ].join('\n'));

  const decision = decideRouting(ws, parsedSpec(ws), { rng: seq(0.5, 0.0) });
  assert.equal(decision.enabled, true);
  assert.equal(decision.context_key, 'type=feature|size=medium|files=lib+test|tags=experiments+routing|risk=normal|caps=none');
  assert.equal(decision.primary.source, 'explore'); // no priors yet
  assert.equal(decision.budget_usd, 2.5);
  assert.equal(decision.timeout_minutes, 30);
  assert.deepEqual(decision.judge, { id: 'fixture-judge', agent_tool: 'fixture-judge' });

  // queue_candidates is exactly what queueExperiment consumes: unique ids,
  // exactly one primary, judge not among them.
  const primaries = decision.queue_candidates.filter(c => c.role === 'primary');
  assert.equal(primaries.length, 1);
  assert.equal(new Set(decision.queue_candidates.map(c => c.id)).size, decision.queue_candidates.length);
  assert.equal(decision.queue_candidates.some(c => c.id === 'fixture-judge'), false);
  assert.equal(decision.queue_candidates.length, 3); // primary + 2 shadows (all_others)

  // Spec lane override rides through decideRouting.
  const spec = parsedSpec(ws);
  spec.meta.agent = 'codex';
  const overridden = decideRouting(ws, spec);
  assert.equal(overridden.primary.source, 'override');
  assert.equal(overridden.primary.agent_tool, 'codex');
});

test('decideRouting: priors learned from logs drive later primaries', () => {
  const ws = mkWorkspace();
  fs.writeFileSync(path.join(ws, 'TRIAGE.yml'), [
    'experiments:',
    '  enabled: true',
    '  candidates: [claude, codex]',
    '  explore_rate: 0.1',
    '  min_samples_to_route: 2',
    '',
  ].join('\n'));

  // Two judged experiments where claude wins and codex faults.
  for (const exp of ['exp-1', 'exp-2']) {
    appendLine(ws, 'candidate-run-log.jsonl', candRunRow(exp, 'claude-a', { agent_tool: 'claude' }));
    appendLine(ws, 'candidate-run-log.jsonl', candRunRow(exp, 'codex-b', { agent_tool: 'codex', role: 'shadow', status: 'failed', fault: 'failed' }));
    appendLine(ws, 'judge-log.jsonl', judgeRow(exp, 'claude-a'));
  }
  updatePriorsFromLogs(ws);

  const decision = decideRouting(ws, parsedSpec(ws), { rng: seq(0.9) }); // no explore roll
  assert.equal(decision.primary.source, 'prior');
  assert.equal(decision.primary.agent_tool, 'claude');
  assert.deepEqual(decision.shadows.map(s => s.agent_tool), ['codex']);
});

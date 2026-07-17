'use strict';
// Experiment auto-initiation — the `experiments.auto_initiate` dial and the
// worker-tick hook (lib/worker.js maybeAutoInitiateExperiment).
//
// The contract under test, in AC order:
//   - absent/off dial = fully inert (zero writes, zero behavior change);
//   - dial on → a fresh canonical claim queues the policy's cohort through
//     the ordinary queueExperiment path;
//   - every initiation and every policy "no" is logged with policy inputs
//     (info vs debug);
//   - budget exhaustion holds NEW experiments with a visible reason and never
//     cancels running ones;
//   - auto experiments carry initiated_by: "policy" (absent = human);
//   - a broken experiment path never stops or delays the canonical claim.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const {
  tick, autoInitiateDial, autoInitiateBudget, readAutoInitiationLog,
  maybeAutoInitiateExperiment, AUTO_INITIATE_DEFAULTS,
} = require('../lib/worker');
const { parseFrontmatter } = require('../lib/parse');
const { queueExperiment, readQueueRows, markRow } = require('../lib/experiment-queue');

// ---------- harness (same shape as test/worker.test.js) ----------

const LANES_YML = [
  'lanes:',
  '  claude:',
  '    command: "echo run -p {prompt_file}"',
  '',
].join('\n');

// experiments section with the dial ON; extra lines splice in before the end.
function dialOnTriage(extra = []) {
  return LANES_YML + [
    'experiments:',
    '  enabled: true',
    '  auto_initiate: true',
    '  candidates: [claude, codex]',
    '  judge: gemini',
    '  budget_usd: 2.5',
    '  timeout_minutes: 30',
    ...extra,
    '',
  ].join('\n');
}

function withWorkspace(opts, fn) {
  const name = 'tl-autoinit-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(ROOT, 'projects', name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), opts.triage !== undefined ? opts.triage : LANES_YML);
    fs.writeFileSync(path.join(dir, 'PROJECT.md'),
      `---\nname: "${name}"\nrepo: "${opts.projectRepo || ROOT}"\n---\n`);
    for (const s of opts.specs || []) {
      const folder = (s.stage && s.stage !== 'ready') ? s.stage : 'specs';
      const specDir = path.join(dir, folder, s.slug);
      fs.mkdirSync(specDir, { recursive: true });
      const fm = ['---', `title: "${s.slug}"`, 'type: feature', `status: ${s.stage || 'ready'}`]
        .concat(s.agent ? [`agent: ${s.agent}`] : [])
        .concat(s.claimedBy ? [`claimed_by: ${s.claimedBy}`] : [])
        .concat(['---', '', '## Objective', 'x', '', '## Scope', '', '### Files to touch',
          ...(s.files || []).map(f => `- \`${f}\``), '']).join('\n');
      fs.writeFileSync(path.join(specDir, 'SPEC.md'), fm);
    }
    for (const [rel, content] of Object.entries(opts.files || {})) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    return fn({ name, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runTick(ws, { lane = 'claude', dryRun = false, childCode = 0 } = {}) {
  const lines = [];
  const spawns = [];
  const result = tick({
    root: ROOT, wsDir: ws.dir, wsName: ws.name, lane, dryRun,
    dirtyPaths: [],
    print: s => lines.push(s),
    getRunBrief: () => 'RUN BRIEF\n',
    spawnLane: args => { spawns.push(args); return childCode; },
  });
  return { result, lines, spawns };
}

function readWorkerLog(ws) {
  const f = path.join(ws.dir, '_metrics', 'worker-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function readExperimentLog(ws) {
  const f = path.join(ws.dir, '_metrics', 'experiment-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function experimentDirs(ws) {
  const d = path.join(ws.dir, '_experiments');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(e => e.startsWith('exp-'));
}

// A parsed-spec object for direct maybeAutoInitiateExperiment calls.
function specObj(slug) {
  return {
    meta: { title: slug, type: 'feature' },
    body: '## Objective\nx\n\n## Scope\n\n### Files to touch\n- `a.js`\n',
  };
}

const EXP_CONFIG = {
  experiments: {
    enabled: true, auto_initiate: true,
    candidates: ['claude', 'codex'], judge: 'gemini',
    budget_usd: 2.5, timeout_minutes: 30,
  },
};

// deep-clone the config so per-test tweaks never leak
function cfg(tweaks = {}) {
  const c = JSON.parse(JSON.stringify(EXP_CONFIG));
  Object.assign(c.experiments, tweaks);
  return c;
}

// ---------- dial normalization (fallback-on-garbage) ----------

test('autoInitiateDial: defaults — off, no lanes, calm caps', () => {
  const d = autoInitiateDial({});
  assert.equal(d.enabled, false);
  assert.deepEqual(d.lanes, []);
  assert.equal(d.maxConcurrent, AUTO_INITIATE_DEFAULTS.max_concurrent);
  assert.equal(d.dailyMax, AUTO_INITIATE_DEFAULTS.daily_max);
});

test('autoInitiateDial: auto_initiate must be literal true', () => {
  assert.equal(autoInitiateDial({ auto_initiate: 'true' }).enabled, false);
  assert.equal(autoInitiateDial({ auto_initiate: 1 }).enabled, false);
  assert.equal(autoInitiateDial({ auto_initiate: true }).enabled, true);
});

test('autoInitiateDial: garbage caps fall back to defaults; valid values stick', () => {
  const garbage = autoInitiateDial({
    auto_initiate_max_concurrent: 0, auto_initiate_daily_max: 'lots', auto_initiate_lanes: 'claude',
  });
  assert.equal(garbage.maxConcurrent, AUTO_INITIATE_DEFAULTS.max_concurrent);
  assert.equal(garbage.dailyMax, AUTO_INITIATE_DEFAULTS.daily_max);
  assert.deepEqual(garbage.lanes, []);
  const ok = autoInitiateDial({
    auto_initiate_max_concurrent: 3.9, auto_initiate_daily_max: 7, auto_initiate_lanes: ['Codex', ''],
  });
  assert.equal(ok.maxConcurrent, 3);           // floored
  assert.equal(ok.dailyMax, 7);
  assert.deepEqual(ok.lanes, ['codex']);       // lowercased, empties dropped
});

// ---------- dial-off inertness ----------

test('inertness: absent experiments section — tick claims and spawns, zero experiment artifacts', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const { result, spawns } = runTick(ws);
    assert.equal(result.code, 0);
    assert.equal(result.spawned, true);
    assert.equal(spawns.length, 1);
    // fully inert: no experiments dir, no auto-initiation log, no experiment log
    assert.equal(fs.existsSync(path.join(ws.dir, '_experiments')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'auto-initiation-log.jsonl')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'experiment-log.jsonl')), false);
    assert.equal(readWorkerLog(ws)[0].experiment_queued, undefined);
  });
});

test('inertness: experiments enabled but auto_initiate absent — still fully off', () => {
  const triage = LANES_YML + 'experiments:\n  enabled: true\n  candidates: [claude, codex]\n';
  withWorkspace({ triage, specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const { result } = runTick(ws);
    assert.equal(result.spawned, true);
    assert.equal(fs.existsSync(path.join(ws.dir, '_experiments')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'auto-initiation-log.jsonl')), false);
  });
});

test('inertness: auto_initiate true but experiments.enabled false — off (both must be true)', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const out = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/r/', spec: specObj('r'),
      triageCfg: cfg({ enabled: false }),
    });
    assert.equal(out.decision, 'off');
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'auto-initiation-log.jsonl')), false);
  });
});

// ---------- dial-on queue creation ----------

test('dial on: a fresh claim queues the policy cohort — rows, provenance, logs', () => {
  withWorkspace({ triage: dialOnTriage(), specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const { result, lines, spawns } = runTick(ws);
    assert.equal(result.code, 0);
    assert.equal(result.spawned, true);
    assert.equal(spawns.length, 1);

    // one experiment, created via the ordinary queueExperiment path
    const exps = experimentDirs(ws);
    assert.equal(exps.length, 1);
    const expId = exps[0];
    assert.match(lines.join('\n'), /auto-initiated experiment exp-/);

    // provenance: initiated_by "policy" in EXPERIMENT.md frontmatter
    const meta = parseFrontmatter(
      fs.readFileSync(path.join(ws.dir, '_experiments', expId, 'EXPERIMENT.md'), 'utf8')).meta;
    assert.equal(meta.initiated_by, 'policy');
    assert.equal(meta.status, 'queued');

    // queue rows: exactly one primary + one shadow over the two candidates,
    // config budget/timeout carried onto every row (same worker contract as
    // a human-queued experiment)
    const rows = readQueueRows(ws.dir).filter(r => r.experiment_id === expId);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(r => r.role === 'primary').length, 1);
    assert.equal(rows.filter(r => r.role === 'shadow').length, 1);
    assert.deepEqual(rows.map(r => r.agent_tool).sort(), ['claude', 'codex']);
    for (const r of rows) {
      assert.equal(r.status, 'queued');
      assert.equal(r.budget_usd, 2.5);
      assert.equal(r.timeout_minutes, 30);
    }

    // experiment-log: the normal queued transition, provenance in the reason
    const elog = readExperimentLog(ws);
    assert.equal(elog.length, 1);
    assert.equal(elog[0].experiment_id, expId);
    assert.equal(elog[0].reason, 'experiment queued (policy)');
    assert.equal(elog[0].judge_agent, 'gemini');

    // auto-initiation log: level info, with the policy inputs (training signal)
    const alog = readAutoInitiationLog(ws.dir);
    assert.equal(alog.length, 1);
    assert.equal(alog[0].decision, 'initiated');
    assert.equal(alog[0].level, 'info');
    assert.equal(alog[0].initiated_by, 'policy');
    assert.equal(alog[0].experiment_id, expId);
    assert.equal(alog[0].spec, 'specs/r/');
    assert.match(alog[0].policy.context_key, /^type=feature\|/);
    assert.ok(alog[0].policy.primary && alog[0].policy.primary.id);
    assert.ok(['prior', 'explore', 'override'].includes(alog[0].policy.primary.source));
    assert.equal(alog[0].policy.shadows.length, 1);
    assert.deepEqual(alog[0].policy.candidates.sort(), ['claude', 'codex']);
    assert.equal(alog[0].budget.daily_max, AUTO_INITIATE_DEFAULTS.daily_max);

    // worker-log carries the pointer
    assert.equal(readWorkerLog(ws).pop().experiment_queued, expId);
  });
});

test('dial on: human-queued experiments stay unmarked — initiated_by is the only difference', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const manual = queueExperiment(ws.dir, {
      spec: 'specs/r/', repoDir: ROOT,
      candidates: [
        { id: 'claude', role: 'primary', agent_tool: 'claude' },
        { id: 'codex', role: 'shadow', agent_tool: 'codex' },
      ],
      judge: { id: 'gemini', agent_tool: 'gemini' },
    });
    const meta = parseFrontmatter(
      fs.readFileSync(path.join(manual.experimentDir, 'EXPERIMENT.md'), 'utf8')).meta;
    assert.equal(meta.initiated_by, undefined); // absent = human (SCHEMA.md)
  });
});

test('lane allowlist: auto_initiate_lanes filters the whole routed pool', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const out = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/r/', spec: specObj('r'),
      triageCfg: cfg({ auto_initiate_lanes: ['codex'] }), repoDir: ROOT,
    });
    assert.equal(out.decision, 'initiated');
    const rows = readQueueRows(ws.dir).filter(r => r.experiment_id === out.experiment_id);
    assert.equal(rows.length, 1);                    // claude filtered out entirely
    assert.equal(rows[0].agent_tool, 'codex');
    assert.equal(rows[0].role, 'primary');
    assert.deepEqual(readAutoInitiationLog(ws.dir)[0].policy.candidates, ['codex']);
  });
});

// ---------- policy "no" decisions (debug level) ----------

test('policy no: empty candidate pool is a logged debug skip, no experiment', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const none = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/r/', spec: specObj('r'),
      triageCfg: cfg({ candidates: [] }),
    });
    assert.equal(none.decision, 'skipped');
    const mismatch = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/r/', spec: specObj('r'),
      triageCfg: cfg({ auto_initiate_lanes: ['windsurf'] }),
    });
    assert.equal(mismatch.decision, 'skipped');
    assert.match(mismatch.reason, /auto_initiate_lanes/);

    const alog = readAutoInitiationLog(ws.dir);
    assert.equal(alog.length, 2);
    for (const row of alog) {
      assert.equal(row.decision, 'skipped');
      assert.equal(row.level, 'debug');            // policy "no" logs at debug
      assert.equal(row.experiment_id, null);
      assert.ok(row.policy);                        // inputs still recorded
    }
    assert.equal(experimentDirs(ws).length, 0);
  });
});

// ---------- budget: hold with a visible reason, never cancel ----------

test('budget: daily cap holds new auto experiments; running ones untouched', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }, { slug: 's', files: ['b.js'] }] }, ws => {
    const config = cfg({ auto_initiate_daily_max: 1, auto_initiate_max_concurrent: 5 });
    const t0 = new Date('2026-07-14T10:00:00Z');
    const first = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/r/', spec: specObj('r'),
      triageCfg: config, repoDir: ROOT, now: t0,
    });
    assert.equal(first.decision, 'initiated');
    const before = fs.readFileSync(
      path.join(ws.dir, '_experiments', 'queue', first.experiment_id + '.jsonl'), 'utf8');

    const lines = [];
    const second = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/s/', spec: specObj('s'),
      triageCfg: config, repoDir: ROOT, now: new Date('2026-07-14T11:00:00Z'),
      print: s => lines.push(s),
    });
    assert.equal(second.decision, 'held');
    assert.match(second.reason, /daily auto-experiment budget exhausted \(1\/1/);
    assert.match(second.reason, /running experiments unaffected/);
    assert.match(lines.join('\n'), /experiment held for specs\/s\//); // visible

    // never cancels: the first experiment's queue file is byte-identical
    const after = fs.readFileSync(
      path.join(ws.dir, '_experiments', 'queue', first.experiment_id + '.jsonl'), 'utf8');
    assert.equal(after, before);
    assert.equal(experimentDirs(ws).length, 1);

    const held = readAutoInitiationLog(ws.dir).pop();
    assert.equal(held.decision, 'held');
    assert.equal(held.level, 'info');
    assert.deepEqual(held.budget, {
      daily_used: 1, daily_max: 1, concurrent_used: 1, max_concurrent: 5,
    });
  });
});

test('budget: concurrent cap counts non-terminal auto experiments and frees on terminal rows', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }, { slug: 's', files: ['b.js'] }] }, ws => {
    const config = cfg({ auto_initiate_max_concurrent: 1, auto_initiate_daily_max: 10 });
    const first = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/r/', spec: specObj('r'),
      triageCfg: config, repoDir: ROOT, now: new Date('2026-07-14T10:00:00Z'),
    });
    assert.equal(first.decision, 'initiated');

    const held = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/s/', spec: specObj('s'),
      triageCfg: config, repoDir: ROOT, now: new Date('2026-07-14T10:01:00Z'),
    });
    assert.equal(held.decision, 'held');
    assert.match(held.reason, /concurrent auto-experiment budget exhausted \(1\/1/);

    // finish the first cohort → concurrent slot frees, initiation proceeds
    for (const row of readQueueRows(ws.dir).filter(r => r.experiment_id === first.experiment_id)) {
      markRow(ws.dir, row, 'succeeded');
    }
    const third = maybeAutoInitiateExperiment({
      wsDir: ws.dir, specPath: 'specs/s/', spec: specObj('s'),
      triageCfg: config, repoDir: ROOT, now: new Date('2026-07-14T10:02:00Z'),
    });
    assert.equal(third.decision, 'initiated');
    assert.notEqual(third.experiment_id, first.experiment_id);
  });
});

test('autoInitiateBudget: only auto-initiated experiments count toward the caps', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    // a human-queued experiment with live rows...
    queueExperiment(ws.dir, { spec: 'specs/r/', repoDir: ROOT });
    // ...does not consume the auto budget
    const used = autoInitiateBudget(ws.dir, new Date().toISOString());
    assert.deepEqual(used, { daily_used: 0, concurrent_used: 0 });
  });
});

// ---------- the claim is never blocked ----------

test('failure-silent: a broken experiment path never stops the claim — tick still spawns, exit 0', () => {
  withWorkspace({
    triage: dialOnTriage(),
    specs: [{ slug: 'r', files: ['a.js'] }],
    files: { _experiments: 'not a directory' },   // queueExperiment will throw ENOTDIR
  }, ws => {
    const { result, lines, spawns } = runTick(ws);
    assert.equal(result.code, 0);                 // canonical work unaffected
    assert.equal(result.spawned, true);
    assert.equal(spawns.length, 1);
    assert.match(lines.join('\n'), /auto-initiation failed for specs\/r\/ \(canonical claim unaffected\)/);
    const err = readAutoInitiationLog(ws.dir).pop();
    assert.equal(err.decision, 'error');
    assert.match(err.reason, /auto-initiation failed/);
    assert.equal(readWorkerLog(ws).pop().experiment_queued, undefined);
  });
});

test('failure-silent: maybeAutoInitiateExperiment never throws, even on a bogus workspace', () => {
  // The bogus workspace lives under a scratch tmpdir, never the real
  // projects/ — the error-log append mkdirs wsDir into existence, and a
  // real-projects path here leaked one does-not-exist-<epoch> junk
  // workspace per npm test run (see test/projects-hygiene.test.js).
  const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tl-autoinit-bogus-'));
  try {
    const out = maybeAutoInitiateExperiment({
      wsDir: path.join(scratch, 'does-not-exist-' + Date.now()),
      specPath: 'specs/none/', spec: specObj('none'),
      triageCfg: cfg(),
    });
    assert.ok(['error', 'skipped', 'held', 'initiated'].includes(out.decision));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------- only fresh ready claims initiate ----------

test('continuations never initiate — a resume must not re-spend the auto budget', () => {
  withWorkspace({
    triage: dialOnTriage(),
    specs: [{ slug: 'kicked', stage: 'in-progress', claimedBy: 'claude', files: ['a.js'] }],
    files: {
      '_dispatch/kicked.json': JSON.stringify({
        spec: 'kicked', mode: 'continuation', stage: 'in-progress', status: 'pending',
      }),
    },
  }, ws => {
    const { result } = runTick(ws);
    assert.equal(result.spawned, true);
    assert.equal(result.picked, '_dispatch/kicked.json');
    assert.equal(experimentDirs(ws).length, 0);
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'auto-initiation-log.jsonl')), false);
  });
});

test('dry run never initiates — a dry tick still leaves zero artifacts', () => {
  withWorkspace({ triage: dialOnTriage(), specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const { result } = runTick(ws, { dryRun: true });
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(path.join(ws.dir, '_experiments')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics')), false);
  });
});

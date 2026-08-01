'use strict';
// Spec-scoped activity trace (<stage>/<slug>/TRACE.jsonl) — the canonical-spec
// trace contract from _templates/SCHEMA.md "Activity trace": append-only,
// travels with the spec folder, explicit provenance (actor/initiation/source),
// dispatch failures are first-class, and absence is never read as `human`.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'tl.js');
const {
  appendSpecTraceEvent, readSpecTrace, loadSpecTracePayload, SPEC_TRACE_FILE,
  tick, verifyTick, applyVerifyHumanDecision,
} = require('../lib/worker');

// ---------- scaffolding ----------

// Workspace under a scratch TL_ROOT (CLI paths) or used directly via wsDir
// (lib paths). Mirrors the cli.test.js / worker.test.js conventions.
function withWorkspace(opts, fn) {
  const name = 'tl-tracetest-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-tracetest-root-'));
  const dir = path.join(scratch, 'projects', name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: "${name}"\nrepo: "${REPO_ROOT}"\n---\n`);
    if (opts.triage !== undefined) fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), opts.triage);
    for (const s of opts.specs || []) {
      const folder = (s.stage && s.stage !== 'ready') ? s.stage : 'specs';
      const specDir = path.join(dir, folder, s.slug);
      fs.mkdirSync(specDir, { recursive: true });
      const fm = ['---', `title: "${s.slug}"`, 'type: feature', `status: ${s.status || s.stage || 'ready'}`]
        .concat(s.claimedBy ? [`claimed_by: ${s.claimedBy}`] : [])
        .concat(s.claimedAt ? [`claimed_at: "${s.claimedAt}"`] : [])
        .concat(s.awaitingVerifier ? ['awaiting_verifier: true'] : [])
        .concat(['---', '', '## Objective', 'x', '',
          '## Acceptance criteria', '', '- works', '',
          '## Scope', '', '### Files to touch',
          ...(s.files || []).map(f => `- \`${f}\``), '']).join('\n');
      fs.writeFileSync(path.join(specDir, 'SPEC.md'), fm);
    }
    for (const [rel, content] of Object.entries(opts.files || {})) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    return fn({ name, dir, scratch });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const LANES_YML = 'lanes:\n  claude:\n    command: "echo run"\n    model: claude-fable-5\n';

function runTick(ws, { lane = 'claude', dryRun = false, brief = 'BRIEF\n', childCode = 0, spawnThrows = false, briefThrows = false, onBrief } = {}) {
  const lines = [];
  return {
    lines,
    result: tick({
      root: REPO_ROOT, wsDir: ws.dir, wsName: ws.name, lane, dryRun,
      dirtyPaths: [],
      print: s => lines.push(s),
      getRunBrief: () => {
        if (onBrief) onBrief();
        if (briefThrows) throw new Error('tl run exploded');
        return brief;
      },
      spawnLane: () => {
        if (spawnThrows) throw new Error('ENOENT: agent CLI not found');
        return childCode;
      },
    }),
  };
}

const trace = (ws, rel) => readSpecTrace(path.join(ws.dir, rel));

// ---------- appendSpecTraceEvent (the writer contract) ----------

test('appendSpecTraceEvent: normalizes provenance to "unknown", passes payload through, appends JSONL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-trace-unit-'));
  try {
    const row = appendSpecTraceEvent(dir, { type: 'handoff', summary: 's', from_stage: 'tests', to_stage: 'in-review', run_id: 'r-1' });
    assert.equal(row.actor_type, 'unknown');
    assert.equal(row.actor_id, 'unknown');
    assert.equal(row.initiation, 'unknown');
    assert.equal(row.source, 'unknown');
    assert.equal(row.from_stage, 'tests');
    assert.equal(row.to_stage, 'in-review');
    assert.equal(row.run_id, 'r-1');
    assert.ok(row.ts);
    const events = readSpecTrace(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'handoff');
    // append-only: a second event lands on a new line, first is untouched
    appendSpecTraceEvent(dir, { type: 'blocked', summary: 'b', actor_type: 'agent', actor_id: 'claude', initiation: 'automation', source: 'worker' });
    const all = readSpecTrace(dir);
    assert.equal(all.length, 2);
    assert.equal(all[1].actor_type, 'agent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('appendSpecTraceEvent: redacts secrets before write; never throws on a missing folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-trace-redact-'));
  try {
    appendSpecTraceEvent(dir, { type: 'command-run', summary: 'ran with OPENAI_API_KEY=sk-abcdef1234567890 exported' });
    const raw = fs.readFileSync(path.join(dir, SPEC_TRACE_FILE), 'utf8');
    assert.ok(!raw.includes('sk-abcdef1234567890'), 'secret must not land on disk');
    assert.match(raw, /\[redacted\]/);
    // flat .md specs have no folder — a non-directory is a silent no-op
    assert.equal(appendSpecTraceEvent(path.join(dir, 'nope'), { type: 'x', summary: 'y' }), null);
    assert.equal(appendSpecTraceEvent(null, { type: 'x', summary: 'y' }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- headless worker tick provenance ----------

test('tick: fresh ready pick appends a claimed event — initiation automation, source worker, run_id correlates with the prompt stamp', () => {
  withWorkspace({ triage: LANES_YML, specs: [{ slug: 'fresh', files: ['a.js'] }] }, ws => {
    const { result } = runTick(ws, { childCode: 0 });
    assert.equal(result.code, 0);
    const events = trace(ws, 'specs/fresh');
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, 'claimed');
    assert.equal(ev.actor_type, 'agent');
    assert.equal(ev.actor_id, 'claude');
    assert.equal(ev.initiation, 'automation');
    assert.equal(ev.source, 'worker');
    assert.equal(ev.actor_model, 'claude-fable-5');   // lanes.claude.model pass-through
    assert.match(ev.run_id, /^claude-\d{8}T\d{6}Z$/);
    // run correlation: same stamp as the worker prompt artifact
    const prompts = fs.readdirSync(path.join(ws.dir, '_metrics', 'worker-prompts'));
    assert.equal(prompts.length, 1);
    assert.equal(ev.run_id + '.txt', prompts[0]);
    // clean session: no dispatch-failed rows
    assert.ok(!events.some(e => e.type === 'dispatch-failed'));
  });
});

test('tick: continuation resume appends dispatched (not claimed) with initiation continuation and the dispatch_id', () => {
  withWorkspace({
    triage: LANES_YML,
    specs: [{ slug: 'resume-me', stage: 'in-progress', status: 'in-progress', claimedBy: 'claude', files: ['a.js'] }],
    files: { '_dispatch/resume-me.json': JSON.stringify({ spec: 'resume-me', mode: 'continuation', stage: 'in-progress', status: 'pending', created: '2026-07-19' }) },
  }, ws => {
    const { result } = runTick(ws);
    assert.equal(result.code, 0);
    const events = trace(ws, 'in-progress/resume-me');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'dispatched');
    assert.equal(events[0].initiation, 'continuation');
    assert.equal(events[0].dispatch_id, '_dispatch/resume-me.json');
    assert.equal(events[0].source, 'worker');
  });
});

test('tick: unsuccessful dispatches are first-class — spawn failure and non-zero session exits append dispatch-failed after the claim row', () => {
  withWorkspace({ triage: LANES_YML, specs: [{ slug: 'boom', files: ['a.js'] }] }, ws => {
    runTick(ws, { spawnThrows: true });
    let events = trace(ws, 'specs/boom');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'claimed');
    const fail1 = events[1];
    assert.equal(fail1.type, 'dispatch-failed');
    assert.equal(fail1.reason, 'spawn_failed');
    assert.equal(fail1.lane, 'claude');
    assert.equal(fail1.initiation, 'automation');
    assert.equal(fail1.source, 'worker');
    assert.equal(fail1.run_id, events[0].run_id);       // same correlation id
    assert.match(fail1.summary, /ENOENT/);
    // lane-readiness failure: session ran but exited non-zero (auth, bad
    // invocation, sandbox visibility) — never silently looks claimed
    runTick(ws, { childCode: 41 });
    events = trace(ws, 'specs/boom');
    const last = events[events.length - 1];
    assert.equal(last.type, 'dispatch-failed');
    assert.equal(last.reason, 'agent_session_failed');
    assert.match(last.summary, /exited 41/);
    assert.match(last.summary, /auth|sandbox/);
  });
});

test('tick: tl run subprocess failure appends dispatch-failed without a claimed row; dry-run writes no trace', () => {
  withWorkspace({ triage: LANES_YML, specs: [{ slug: 'nobrief', files: ['a.js'] }] }, ws => {
    const { result } = runTick(ws, { briefThrows: true });
    assert.equal(result.code, 1);
    const events = trace(ws, 'specs/nobrief');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'dispatch-failed');
    assert.equal(events[0].reason, 'tl_run_failed');
    assert.ok(!events.some(e => e.type === 'claimed'), 'no claim was committed, so none is recorded');
  });
  withWorkspace({ triage: LANES_YML, specs: [{ slug: 'dry', files: ['a.js'] }] }, ws => {
    runTick(ws, { dryRun: true });
    assert.equal(fs.existsSync(path.join(ws.dir, 'specs', 'dry', SPEC_TRACE_FILE)), false);
  });
});

test('tick: marks its tl run subprocess via TL_WORKER_DISPATCH and restores the env after', () => {
  withWorkspace({ triage: LANES_YML, specs: [{ slug: 'envspec', files: ['a.js'] }] }, ws => {
    let seen = null;
    assert.equal(process.env.TL_WORKER_DISPATCH, undefined);
    runTick(ws, { onBrief: () => { seen = process.env.TL_WORKER_DISPATCH; } });
    assert.match(String(seen), /^claude-/, 'brief subprocess sees the tick run_id');
    assert.equal(process.env.TL_WORKER_DISPATCH, undefined, 'env restored after the brief');
  });
});

// ---------- interactive CLI provenance (tl run / reclaim) ----------

const runCli = (scratch, env, ...a) => spawnSync(process.execPath, [BIN, ...a], {
  encoding: 'utf8', env: { ...process.env, TL_ROOT: scratch, ...env },
});

test('tl run (interactive) appends claimed with initiation human / source cli; tick-driven briefs skip (one writer per path)', () => {
  withWorkspace({ specs: [{ slug: 'cli-claim', files: ['a.js'] }] }, ws => {
    const r = runCli(ws.scratch, {}, 'run', ws.name, '--agent', 'claude');
    assert.equal(r.status, 0, r.stderr);
    const events = trace(ws, 'specs/cli-claim');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'claimed');
    assert.equal(events[0].actor_type, 'agent');
    assert.equal(events[0].actor_id, 'claude');
    assert.equal(events[0].initiation, 'human');
    assert.equal(events[0].source, 'cli');
    assert.match(events[0].run_id, /^cli-/);
    // the same brief under a worker tick appends nothing — the tick owns it
    const r2 = runCli(ws.scratch, { TL_WORKER_DISPATCH: 'claude-x' }, 'run', ws.name, '--agent', 'claude');
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(trace(ws, 'specs/cli-claim').length, 1);
    // and --dry-run writes nothing either
    const r3 = runCli(ws.scratch, {}, 'run', ws.name, '--dry-run');
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(trace(ws, 'specs/cli-claim').length, 1);
  });
});

test('tl reclaim appends a human-attributed handoff event that travels with the folder', () => {
  withWorkspace({
    specs: [{ slug: 'stalled', stage: 'in-progress', status: 'in-progress', claimedBy: 'codex', claimedAt: '2026-01-01', files: ['a.js'] }],
  }, ws => {
    const specFile = path.join(ws.dir, 'in-progress', 'stalled', 'SPEC.md');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(specFile, old, old);
    const r = runCli(ws.scratch, {}, 'reclaim', ws.name, 'stalled', '--by', 'trevor', '--reason', 'agent went dark');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    // no FEEDBACK → released back to specs/; the trace moved with the folder
    const events = trace(ws, 'specs/stalled');
    const hand = events.find(e => e.type === 'handoff');
    assert.ok(hand, 'handoff event recorded: ' + JSON.stringify(events));
    assert.equal(hand.from_stage, 'in-progress');
    assert.equal(hand.to_stage, 'specs');
    assert.equal(hand.actor_type, 'human');
    assert.equal(hand.actor_id, 'trevor');
    assert.equal(hand.initiation, 'human');
    assert.equal(hand.source, 'cli');
    assert.match(hand.summary, /agent went dark/);
    assert.match(hand.summary, /codex/);   // prior claim attribution survives
  });
});

// ---------- verify-path provenance ----------

const VERIFY_YML = [
  'verification:',
  '  require_independent_verifier: true',
  '  verifier_lanes:',
  '    gemini:',
  '      agent: gemini',
  '      mode: verify',
  '      isolated: true',
  '      sandbox: required',
  '      allow_network: false',
  '      command: [agy]',
  '',
].join('\n');

test('verifyTick: a clean pass appends a tests → in-review handoff with the verify correlation id', () => {
  withWorkspace({
    triage: VERIFY_YML,
    specs: [{ slug: 'ver', stage: 'tests', status: 'blocked', claimedBy: 'claude', awaitingVerifier: true, files: ['a.js'] }],
  }, ws => {
    const result = verifyTick({
      root: REPO_ROOT, wsDir: ws.dir, wsName: ws.name,
      print: () => {},
      runVerify: () => ({ status: 'pass', notes: [] }),
      recordOutcome: ({ wsDir, slug }) => {
        const dest = path.join(wsDir, 'in-review', slug);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(path.join(wsDir, 'tests', slug), dest);
        return { status: 'in-review', path: `in-review/${slug}/` };
      },
    });
    assert.equal(result.code, 0);
    const events = trace(ws, 'in-review/ver');
    const hand = events.find(e => e.type === 'handoff');
    assert.ok(hand, JSON.stringify(events));
    assert.equal(hand.from_stage, 'tests');
    assert.equal(hand.to_stage, 'in-review');
    assert.equal(hand.actor_type, 'agent');
    assert.equal(hand.actor_id, 'gemini');
    assert.equal(hand.initiation, 'automation');     // scheduled tick default
    assert.equal(hand.source, 'worker');
    assert.match(hand.run_id, /^gemini-verify-/);
    assert.match(hand.summary, /builder claude/);
  });
});

test('verifyTick: a blocked outcome appends a blocked event, never a handoff', () => {
  withWorkspace({
    triage: VERIFY_YML,
    specs: [{ slug: 'verblock', stage: 'tests', status: 'blocked', claimedBy: 'claude', awaitingVerifier: true, files: ['a.js'] }],
  }, ws => {
    verifyTick({
      root: REPO_ROOT, wsDir: ws.dir, wsName: ws.name,
      print: () => {},
      runVerify: () => ({ status: 'blocked', reason: 'acceptance test failed', notes: [] }),
    });
    const events = trace(ws, 'tests/verblock');
    const blocked = events.find(e => e.type === 'blocked');
    assert.ok(blocked, JSON.stringify(events));
    assert.match(blocked.summary, /acceptance test failed/);
    assert.equal(blocked.reason, 'acceptance test failed');
    assert.ok(!events.some(e => e.type === 'handoff'));
  });
});

test('applyVerifyHumanDecision: the human tests → in-progress handoff carries who, why, and the continuation dispatch id', () => {
  withWorkspace({
    specs: [{ slug: 'decide', stage: 'tests', status: 'blocked', claimedBy: 'claude', files: ['a.js'] }],
  }, ws => {
    applyVerifyHumanDecision(ws.dir, { slug: 'decide', action: 'kick-back', note: 'scope drift', by: 'human-cli', source: 'cli' });
    const events = trace(ws, 'in-progress/decide');
    const hand = events.find(e => e.type === 'handoff');
    assert.ok(hand, JSON.stringify(events));
    assert.equal(hand.from_stage, 'tests');
    assert.equal(hand.to_stage, 'in-progress');
    assert.equal(hand.actor_type, 'human');
    assert.equal(hand.actor_id, 'human-cli');
    assert.equal(hand.initiation, 'human');
    assert.equal(hand.dispatch_id, '_dispatch/decide.json');
    assert.match(hand.summary, /scope drift/);
  });
});

test('loadSpecTracePayload: omits missing/empty; caps to most recent events with truncated flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-trace-payload-'));
  try {
    assert.equal(loadSpecTracePayload(dir), null);
    fs.writeFileSync(path.join(dir, SPEC_TRACE_FILE), '');
    assert.equal(loadSpecTracePayload(dir), null);
    for (let i = 0; i < 5; i++) {
      appendSpecTraceEvent(dir, {
        type: 'file-edited', summary: 'e' + i, actor_type: 'agent', actor_id: 'cursor',
        initiation: 'human', source: 'cli', paths: ['a.js'],
      }, { now: new Date(Date.UTC(2026, 6, 20, 12, i)) });
    }
    const full = loadSpecTracePayload(dir);
    assert.equal(full.truncated, false);
    assert.equal(full.events.length, 5);
    assert.equal(full.events[0].summary, 'e0');
    const capped = loadSpecTracePayload(dir, { limit: 2 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.events.length, 2);
    assert.equal(capped.events[0].summary, 'e3');
    assert.equal(capped.events[1].summary, 'e4');
    // absent provenance stays literal unknown when writers normalize — reader contract
    assert.equal(capped.events[0].actor_type, 'agent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  REQUIRED_EVENT_TYPES,
  OPTIONAL_EVENT_TYPES,
  redact,
  resolveModelVisibility,
  normalizeTraceEvent,
  appendTraceEvent,
  createTraceSession,
  extractTraceFeatures,
  appendTraceFeatures,
  readTraceFile,
  coerceRunnerEvent,
} = require('../lib/experiment-trace');
const { runCandidate } = require('../lib/experiment-runner');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkRepo() {
  const dir = mkTmp('tl-trace-repo-');
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

function mkWorkspace() {
  const dir = mkTmp('tl-trace-ws-');
  for (const name of ['specs', 'in-progress', 'tests', 'in-review', 'done', '_metrics', '_experiments']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  return dir;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ---------- contract constants ----------

test('documents required and optional event types', () => {
  for (const t of [
    'start', 'plan_summary', 'tool', 'file_read', 'file_write',
    'test', 'command', 'patch', 'status', 'fault', 'finish',
  ]) {
    assert.ok(REQUIRED_EVENT_TYPES.includes(t), `missing required type ${t}`);
  }
  for (const t of ['reasoning_summary', 'replan', 'backtrack', 'human_intervention']) {
    assert.ok(OPTIONAL_EVENT_TYPES.includes(t), `missing optional type ${t}`);
  }
});

// ---------- redaction ----------

test('redact strips API keys, tokens, JWTs, and credential env assignments', () => {
  assert.match(redact('key sk-abcdefghijklmnop'), /\[redacted\]/);
  assert.match(redact('auth ghp_abcdefghijklmnop'), /\[redacted\]/);
  assert.match(redact('xoxb-12345678-abcdefgh'), /\[redacted\]/);
  assert.match(redact('AKIAABCDEFGHIJKL'), /\[redacted\]/);
  assert.match(redact('token=eyJhbGciOiJIUzI1NiJ9.aaaaaa.bbbbbb'), /\[redacted\]/);
  assert.match(redact('api_key: supersecretvalue99'), /\[redacted\]/);
  assert.equal(redact('export OPENAI_API_KEY=sklivevalue99'), 'export OPENAI_API_KEY=[redacted]');
  assert.equal(redact('DB_PASSWORD=hunter22xx'), 'DB_PASSWORD=[redacted]');
  assert.equal(redact('harmless summary about tests'), 'harmless summary about tests');
});

// ---------- model visibility ----------

test('resolveModelVisibility handles Cursor auto explicitly', () => {
  const auto = resolveModelVisibility({ agent_tool: 'cursor' });
  assert.equal(auto.agent_model_requested, 'auto');
  assert.equal(auto.agent_model_auto, true);
  assert.equal(auto.agent_model, 'unknown');
  assert.equal(auto.agent_model_source, 'unknown');

  const resolved = resolveModelVisibility({
    agent_tool: 'cursor',
    agent_model_requested: 'auto',
    agent_model: 'claude-sonnet-4',
    agent_model_source: 'sdk',
  });
  assert.equal(resolved.agent_model_requested, 'auto');
  assert.equal(resolved.agent_model_auto, true);
  assert.equal(resolved.agent_model, 'claude-sonnet-4');
  assert.equal(resolved.agent_model_source, 'sdk');

  const hook = resolveModelVisibility({
    agent_tool: 'cursor',
    agent_model_auto: true,
    agent_model: 'gpt-5',
    agent_model_source: 'hook',
  });
  assert.equal(hook.agent_model_source, 'hook');
  assert.equal(hook.agent_model, 'gpt-5');

  const explicit = resolveModelVisibility({
    agent_tool: 'codex',
    agent_model_requested: 'gpt-5',
    agent_model: 'gpt-5',
  });
  assert.equal(explicit.agent_model_auto, false);
  assert.equal(explicit.agent_model_requested, 'gpt-5');
  assert.equal(explicit.agent_model_source, 'requested');
});

// ---------- append / normalize ----------

test('appendTraceEvent writes common fields, redacts, and supports payloads', () => {
  const dir = mkTmp('tl-trace-append-');
  const file = path.join(dir, 'TRACE.jsonl');
  const identity = {
    agent_tool: 'claude',
    agent_model: 'claude-fable-5',
    agent_model_auto: false,
    agent_model_source: 'requested',
    source: 'runner',
  };
  const ev = appendTraceEvent(file, {
    ts: '2026-07-14T12:00:00.000Z',
    type: 'command',
    summary: 'ran with OPENAI_API_KEY=sklivevalue99',
    command: 'echo hi',
    duration_ms: 12,
  }, identity);

  assert.equal(ev.type, 'command');
  assert.equal(ev.agent_tool, 'claude');
  assert.equal(ev.agent_model, 'claude-fable-5');
  assert.equal(ev.agent_model_auto, false);
  assert.equal(ev.agent_model_source, 'requested');
  assert.equal(ev.source, 'runner');
  assert.equal(ev.duration_ms, 12);
  assert.equal(ev.command, 'echo hi');
  assert.match(ev.summary, /OPENAI_API_KEY=\[redacted\]/);
  assert.doesNotMatch(ev.summary, /sklivevalue99/);

  const disk = readTraceFile(file);
  assert.equal(disk.length, 1);
  assert.equal(disk[0].type, 'command');
});

test('createTraceSession is append-only within a run and starts fresh', () => {
  const dir = mkTmp('tl-trace-sess-');
  const s1 = createTraceSession(dir, {
    agent_tool: 'shell',
    agent_model: 'none',
    agent_model_source: 'none',
  }, { now: new Date('2026-07-14T12:00:00Z') });
  s1.append({ type: 'start', summary: 'go' });
  s1.append({ type: 'finish', status: 'succeeded', summary: 'done' });
  assert.equal(readTraceFile(s1.path).length, 2);

  const s2 = createTraceSession(dir, { agent_tool: 'shell', agent_model: 'none' });
  s2.append({ type: 'start', summary: 'retry' });
  assert.equal(readTraceFile(s2.path).length, 1);
  assert.equal(readTraceFile(s2.path)[0].summary, 'retry');
});

test('normalizeTraceEvent fills defaults and coerceRunnerEvent maps legacy types', () => {
  const n = normalizeTraceEvent({ type: 'tool', summary: 'ReadFile' }, { agent_tool: 'cursor', agent_model: 'unknown', agent_model_auto: true, agent_model_source: 'unknown' });
  assert.equal(n.agent_tool, 'cursor');
  assert.equal(n.agent_model_auto, true);
  assert.ok(n.ts);

  assert.equal(coerceRunnerEvent({ type: 'exec', summary: 'x' }).type, 'command');
  assert.equal(coerceRunnerEvent({ type: 'isolate', summary: 'y' }).type, 'status');
});

// ---------- feature extraction ----------

test('extractTraceFeatures derives counts and first_test_at_ms', () => {
  const events = [
    { ts: '2026-07-14T12:00:00.000Z', type: 'start' },
    { ts: '2026-07-14T12:00:01.000Z', type: 'tool', summary: 'Read' },
    { ts: '2026-07-14T12:00:02.000Z', type: 'tool', summary: 'Edit' },
    { ts: '2026-07-14T12:00:05.000Z', type: 'test', summary: 'npm test' },
    { ts: '2026-07-14T12:00:06.000Z', type: 'test', summary: 'npm test retry' },
    { ts: '2026-07-14T12:00:07.000Z', type: 'replan', summary: 'try other approach' },
    { ts: '2026-07-14T12:00:08.000Z', type: 'backtrack', summary: 'revert bad edit' },
    { ts: '2026-07-14T12:00:09.000Z', type: 'fault', fault: 'scope_violation', summary: 'touched do-not-touch' },
    { ts: '2026-07-14T12:00:10.000Z', type: 'human_intervention', summary: 'human nudged' },
    { ts: '2026-07-14T12:00:11.000Z', type: 'finish', status: 'succeeded' },
  ];
  const f = extractTraceFeatures(events, {
    date: '2026-07-14',
    experiment_id: 'exp-1',
    candidate_id: 'c1',
  });
  assert.equal(f.event_count, 10);
  assert.equal(f.tool_calls, 2);
  assert.equal(f.test_iterations, 2);
  assert.equal(f.first_test_at_ms, 5000);
  assert.equal(f.replan_count, 1);
  assert.equal(f.backtrack_count, 1);
  assert.equal(f.scope_violations, 1);
  assert.equal(f.human_intervention_count, 1);
  assert.equal(f.experiment_id, 'exp-1');
  assert.equal(f.candidate_id, 'c1');
});

test('appendTraceFeatures writes a learning row under _metrics/', () => {
  const ws = mkWorkspace();
  const file = appendTraceFeatures(ws, {
    date: '2026-07-14',
    experiment_id: 'e',
    candidate_id: 'c',
    event_count: 3,
    tool_calls: 1,
    test_iterations: 0,
    first_test_at_ms: null,
    replan_count: 0,
    backtrack_count: 0,
    scope_violations: 0,
    human_intervention_count: 0,
  });
  const rows = readJsonl(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_calls, 1);
});

// ---------- runner wiring ----------

test('runCandidate emits TRACE events with model fields, METRICS model visibility, and trace-features', () => {
  const repo = mkRepo();
  const ws = mkWorkspace();
  fs.mkdirSync(path.join(ws, '_experiments', 'exp-trace'), { recursive: true });
  fs.writeFileSync(path.join(ws, '_experiments', 'exp-trace', 'EXPERIMENT.md'), [
    '---',
    'experiment_id: exp-trace',
    'task_type: tl_spec',
    'tl_spec: specs/demo/',
    'spec_hash: abc',
    'base_commit: HEAD',
    'status: running',
    'created: 2026-07-14',
    '---',
    '',
    '# exp',
    '',
  ].join('\n'));

  const row = {
    experiment_id: 'exp-trace',
    candidate_id: 'shell-a',
    role: 'primary',
    agent_tool: 'shell',
    agent_model_requested: null,
    status: 'running',
    attempt: 1,
    budget_usd: 10,
    timeout_minutes: 2,
    claimed_by: 'test',
    config: {
      repo,
      command: 'printf "ok\\n" > out.txt',
      estimated_cost_usd: 0,
    },
  };

  const result = runCandidate(ws, row, { now: new Date('2026-07-14T15:00:00Z') });
  assert.equal(result.status, 'succeeded');

  const candDir = path.join(ws, '_experiments', 'exp-trace', 'candidates', 'shell-a');
  const trace = readJsonl(path.join(candDir, 'TRACE.jsonl'));
  assert.ok(trace.some(t => t.type === 'start'));
  assert.ok(trace.some(t => t.type === 'plan_summary'));
  assert.ok(trace.some(t => t.type === 'command'));
  assert.ok(trace.some(t => t.type === 'patch'));
  assert.ok(trace.some(t => t.type === 'finish'));
  for (const t of trace) {
    assert.ok(t.ts);
    assert.ok(t.agent_tool);
    assert.ok('agent_model' in t);
    assert.ok('agent_model_auto' in t);
    assert.ok('agent_model_source' in t);
    assert.ok('source' in t);
    assert.ok('summary' in t);
  }

  const metrics = JSON.parse(fs.readFileSync(path.join(candDir, 'METRICS.json'), 'utf8'));
  assert.equal(metrics.agent_tool, 'shell');
  assert.ok('agent_model' in metrics);
  assert.ok('agent_model_requested' in metrics);
  assert.ok('agent_model_auto' in metrics);
  assert.ok('agent_model_source' in metrics);
  assert.ok('runtime_version' in metrics);
  assert.ok('framework' in metrics);
  assert.ok('adapter_version' in metrics);

  const features = readJsonl(path.join(ws, '_metrics', 'trace-features.jsonl'));
  assert.equal(features.length, 1);
  assert.equal(features[0].candidate_id, 'shell-a');
  assert.ok(features[0].event_count >= 3);
});

test('runCandidate Cursor auto stamps METRICS model visibility without inventing a model', () => {
  const ws = mkWorkspace();
  fs.mkdirSync(path.join(ws, '_experiments', 'exp-cur'), { recursive: true });
  fs.writeFileSync(path.join(ws, '_experiments', 'exp-cur', 'EXPERIMENT.md'), [
    '---',
    'experiment_id: exp-cur',
    'task_type: tl_spec',
    'tl_spec: specs/demo/',
    'status: running',
    'created: 2026-07-14',
    '---',
    '',
  ].join('\n'));

  // No config.repo → unavailable before spawn; still writes full artifact set.
  const result = runCandidate(ws, {
    experiment_id: 'exp-cur',
    candidate_id: 'cur-a',
    role: 'primary',
    agent_tool: 'cursor',
    agent_model_requested: null,
    status: 'running',
    attempt: 1,
    budget_usd: 10,
    timeout_minutes: 1,
    claimed_by: 'test',
    config: {},
  }, { now: new Date('2026-07-14T16:00:00Z') });

  assert.equal(result.status, 'unavailable');
  const metrics = JSON.parse(fs.readFileSync(
    path.join(ws, '_experiments', 'exp-cur', 'candidates', 'cur-a', 'METRICS.json'),
    'utf8',
  ));
  assert.equal(metrics.agent_model_requested, 'auto');
  assert.equal(metrics.agent_model_auto, true);
  assert.equal(metrics.agent_model, 'unknown');
  assert.equal(metrics.agent_model_source, 'unknown');

  const trace = readJsonl(path.join(ws, '_experiments', 'exp-cur', 'candidates', 'cur-a', 'TRACE.jsonl'));
  assert.ok(trace.some(t => t.type === 'fault'));
  assert.ok(trace.some(t => t.type === 'finish'));
  assert.equal(trace.every(t => t.agent_model_auto === true), true);
});

test('over_budget never runs a command and still leaves a redacted TRACE', () => {
  const ws = mkWorkspace();
  fs.mkdirSync(path.join(ws, '_experiments', 'exp-b'), { recursive: true });
  fs.writeFileSync(path.join(ws, '_experiments', 'exp-b', 'EXPERIMENT.md'), '---\nexperiment_id: exp-b\n---\n');

  runCandidate(ws, {
    experiment_id: 'exp-b',
    candidate_id: 'costly',
    role: 'primary',
    agent_tool: 'shell',
    agent_model_requested: null,
    status: 'running',
    attempt: 1,
    budget_usd: 1,
    timeout_minutes: 1,
    claimed_by: 'test',
    config: { estimated_cost_usd: 9, command: 'echo OPENAI_API_KEY=sklivevalue99' },
  }, { now: new Date('2026-07-14T17:00:00Z') });

  const trace = readJsonl(path.join(ws, '_experiments', 'exp-b', 'candidates', 'costly', 'TRACE.jsonl'));
  assert.equal(trace.some(t => t.type === 'command'), false);
  assert.ok(trace.some(t => t.type === 'fault'));
  assert.ok(trace.some(t => t.type === 'finish'));
});

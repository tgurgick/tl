'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  ADAPTER_METHODS,
  CAPABILITY_FIELDS,
  FINGERPRINT_FIELDS,
  ROUTING_PRIORS_FILE,
  isAdapter,
  normalizeCapabilities,
  extractSpecSections,
  tlSpecToTask,
  tlSpecAdapter,
  makeFingerprint,
  createShellAdapter,
  cursorCapabilities,
  createLocalRoutingPolicy,
} = require('../lib/experiment-adapter');

const SPEC_BODY = [
  '# Example spec',
  '',
  '## Objective',
  '',
  'Do a controlled thing so candidates can be compared fairly.',
  'A second line of the objective paragraph.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] The first criterion holds',
  '- [x] The second criterion holds',
  '',
  '## Scope',
  '',
  '### Files to touch',
  '',
  '- `lib/example.js` — the thing',
  '- `test/example.test.js` — its tests',
  '',
  '### Do not touch',
  '',
  '- `bin/tl.js`',
  '- UI dashboard',
  '',
].join('\n');

test('tlSpecToTask: converts a TL spec into a generic task object', () => {
  const task = tlSpecToTask(
    { meta: { title: 'Example spec', type: 'feature', intent: 'intents/x.md', priority: 'p2' }, body: SPEC_BODY },
    { specPath: 'specs/example/SPEC.md', baseCommit: 'abc123', intentOutcome: 'Ship the thing' }
  );

  assert.equal(task.title, 'Example spec');
  assert.equal(task.id, 'example-spec');
  assert.match(task.objective, /controlled thing/);
  assert.match(task.objective, /second line/); // multi-line paragraph joined
  assert.equal(task.intent_outcome, 'Ship the thing');
  assert.deepEqual(task.acceptance_criteria, [
    'The first criterion holds',
    'The second criterion holds',
  ]);
  assert.deepEqual(task.scope.allowed_files, ['lib/example.js', 'test/example.test.js']);
  assert.deepEqual(task.scope.do_not_touch, ['bin/tl.js', 'UI dashboard']);
  assert.equal(task.base_commit, 'abc123');
  assert.equal(task.task_type, 'feature');
  assert.equal(task.source.adapter, 'tl-spec');
  assert.equal(task.source.spec_path, 'specs/example/SPEC.md');
  // spec_hash is a stable content hash of the body
  assert.match(task.spec_hash, /^[0-9a-f]{64}$/);
});

test('tlSpecToTask: is stable — same body yields same spec_hash, defaults are safe', () => {
  const a = tlSpecToTask({ meta: { title: 'X' }, body: SPEC_BODY });
  const b = tlSpecToTask({ meta: { title: 'X' }, body: SPEC_BODY });
  assert.equal(a.spec_hash, b.spec_hash);
  assert.equal(a.base_commit, 'unknown');
  // Never throws on empty / missing input
  const empty = tlSpecToTask({});
  assert.equal(empty.id, 'task');
  assert.deepEqual(empty.acceptance_criteria, []);
  assert.deepEqual(empty.scope.allowed_files, []);
});

test('extractSpecSections is exposed via tlSpecAdapter and returns the same shape', () => {
  const direct = extractSpecSections(SPEC_BODY);
  const viaAdapter = tlSpecAdapter.extractSpecSections(SPEC_BODY);
  assert.deepEqual(direct, viaAdapter);
  assert.equal(tlSpecAdapter.name, 'tl-spec');
  assert.equal(typeof tlSpecAdapter.toTask, 'function');
});

test('makeFingerprint: produces the documented runtime fingerprint shape', () => {
  const fp = makeFingerprint({ agent_tool: 'shell', agent_model: 'none', agent_model_source: 'none' });
  for (const field of FINGERPRINT_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(fp, field), `missing field ${field}`);
  }
  assert.equal(fp.agent_tool, 'shell');
  assert.equal(fp.agent_model_auto, false);
  // Bare input degrades to safe defaults, never throws
  const bare = makeFingerprint();
  assert.equal(bare.agent_tool, 'unknown');
  assert.equal(bare.agent_model_source, 'unknown');
  assert.equal(bare.rules_hash, '');
});

test('shell adapter satisfies the full adapter interface and is provider-free', () => {
  const shell = createShellAdapter({ command: 'echo hi' });
  assert.equal(isAdapter(shell), true);
  for (const method of ADAPTER_METHODS) {
    assert.equal(typeof shell[method], 'function', `shell missing ${method}`);
  }

  const task = tlSpecToTask({ meta: { title: 'X' }, body: SPEC_BODY });
  const prepared = shell.prepareTask(task);
  assert.equal(prepared.command, 'echo hi');

  const handle = shell.startCandidate(prepared, { candidateId: 'c1' });
  assert.equal(handle.candidate_id, 'c1');

  const artifacts = shell.collectArtifacts(handle);
  assert.equal(artifacts.candidate_id, 'c1');
  assert.equal(artifacts.metrics.agent_tool, 'shell');

  assert.equal(shell.cancelCandidate(handle).status, 'cancelled');
  assert.equal(shell.supportsHeadless(), true);
  assert.equal(shell.fingerprintRuntime().agent_tool, 'shell');
});

test('capability flags: shell is headless, Cursor IDE is not, Cursor cloud is', () => {
  const shell = createShellAdapter();
  for (const field of CAPABILITY_FIELDS) {
    assert.equal(typeof shell.capabilities[field], 'boolean', `shell cap ${field} not boolean`);
  }
  assert.equal(shell.capabilities.headless, true);
  assert.equal(shell.capabilities.requires_ide, false);

  const ide = cursorCapabilities('ide');
  assert.equal(ide.headless, false);
  assert.equal(ide.requires_ide, true);
  assert.equal(ide.reports_model, true);

  const cloud = cursorCapabilities('cloud');
  assert.equal(cloud.headless, true);
  assert.equal(cloud.requires_ide, false);
  assert.equal(cloud.supports_budget, true);

  // default mode is IDE
  assert.deepEqual(cursorCapabilities(), ide);
});

test('normalizeCapabilities: coerces to the full flag set, defaults missing to false', () => {
  const caps = normalizeCapabilities({ headless: 1, requires_ide: 'yes' });
  assert.deepEqual(Object.keys(caps).sort(), CAPABILITY_FIELDS.slice().sort());
  assert.equal(caps.headless, true);
  assert.equal(caps.requires_ide, true);
  assert.equal(caps.streams_trace, false);
  // Garbage input never throws
  assert.deepEqual(normalizeCapabilities(null), normalizeCapabilities(undefined));
});

test('isAdapter: rejects incomplete adapters', () => {
  assert.equal(isAdapter(null), false);
  assert.equal(isAdapter({}), false);
  assert.equal(isAdapter({ prepareTask() {} }), false);
  assert.equal(isAdapter(createShellAdapter()), true);
});

test('routing policy: private learning stays out of the core', () => {
  const policy = createLocalRoutingPolicy();
  assert.equal(policy.name, 'local-priors');
  assert.equal(policy.priorsFile, ROUTING_PRIORS_FILE);
  assert.equal(ROUTING_PRIORS_FILE, 'routing-priors.jsonl');

  const row = policy.formatPriorRow({ task_type: 'feature', agent_tool: 'shell', outcome: 'won', utility: 5 });
  assert.equal(row.agent_tool, 'shell');
  assert.equal(row.outcome, 'won');
  assert.equal(row.utility, 5);
  assert.ok(row.ts);

  // Baseline choice: no priors -> first candidate
  assert.equal(policy.choose(['a', 'b']), 'a');
  assert.equal(policy.choose([]), null);

  // With priors, prefers the higher observed win-rate
  const priors = [
    { agent_tool: 'a', outcome: 'lost' },
    { agent_tool: 'b', outcome: 'won' },
    { agent_tool: 'b', outcome: 'won' },
  ];
  assert.equal(policy.choose(['a', 'b'], priors), 'b');
});

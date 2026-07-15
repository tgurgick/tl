'use strict';

// Provider adapters (codex / gemini / claude / cursor) — invocation-shape and
// contract tests. NO real provider CLI is ever invoked: every test points the
// row's PATH (config.env.PATH) at a directory of stub executables that record
// their argv + stdin and fabricate a small edit, so the assertions pin the
// EXACT invocation each adapter builds:
//
//   codex   exec --sandbox <mode> [-p <profile>] [extra…] -   prompt on stdin
//   gemini  agy --dangerously-skip-permissions [extra…] -p <prompt>   (-p LAST)
//   claude  claude [extra…] -p                                  prompt on stdin
//   cursor  cursor-agent -f [extra…] -p <prompt>                (-f baked in)
//
// Plus: artifact-set invariance per adapter, unavailable/timeout/budget fault
// mapping, byte-exact prompt delivery (the no-nested-quoting proof), the
// cohort-config override path end-to-end through queueExperiment/drainQueue,
// and the cockpit `runtime: "local"` request bridge in processQueueRequests.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { RUNNERS, PROVIDERS, hasRunner, runCandidate } = require('../lib/experiment-runner');
const { queueExperiment, readQueueRows, drainQueue, processQueueRequests } = require('../lib/experiment-queue');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const NOW = new Date('2026-07-14T12:00:00Z');
const ARTIFACTS = ['PATCH.diff', 'FEEDBACK.md', 'METRICS.json', 'TRACE.jsonl'];
const PROVIDER_KEYS = ['codex', 'gemini', 'claude', 'cursor'];
const BIN_BY_KEY = { codex: 'codex', gemini: 'agy', claude: 'claude', cursor: 'cursor-agent' };

// ---------- fixtures ----------

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A tiny canonical repo — the tree candidates run against (never mutated).
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-adapters-repo-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'untouched\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  return dir;
}

function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-adapters-ws-'));
  const specDir = path.join(ws, 'specs', 'demo');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'SPEC.md'), [
    '---',
    'title: "Demo spec"',
    'type: "feature"',
    'status: "ready"',
    'priority: "p2"',
    '---',
    '',
    '# Demo spec',
    '',
    '## Objective',
    '',
    'Do the demo thing.',
    '',
  ].join('\n'));
  return ws;
}

// Stub provider CLIs on PATH. Each stub records its argv (JSON — argv
// elements may be multiline prompts) and its full stdin to $STUB_OUT, then
// writes one file into its cwd so the collected git diff is non-empty.
// Env knobs: STUB_SLEEP (ms — for timeout tests), STUB_EXIT (non-zero exit).
const STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const out = process.env.STUB_OUT;
if (out) {
  fs.writeFileSync(require('path').join(out, 'argv.json'), JSON.stringify(process.argv.slice(2)));
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  fs.writeFileSync(require('path').join(out, 'stdin.txt'), stdin);
}
const sleep = Number(process.env.STUB_SLEEP || 0);
if (sleep > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep);
if (process.env.STUB_EXIT) process.exit(Number(process.env.STUB_EXIT));
fs.writeFileSync('candidate-output.txt', 'stub ran\\n');
`;

function mkStubBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-adapters-bin-'));
  for (const name of Object.values(BIN_BY_KEY)) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, STUB_SOURCE);
    fs.chmodSync(file, 0o755);
  }
  return bin;
}

function mkStubOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tl-adapters-out-'));
}

function stubEnv(bin, stubOut, extra = {}) {
  return { PATH: bin + path.delimiter + process.env.PATH, STUB_OUT: stubOut, ...extra };
}

// A hand-built claimed row — adapter unit tests exercise runCandidate
// directly, without needing a queued experiment on disk.
function mkRow(agentTool, config, extra = {}) {
  return {
    experiment_id: extra.experimentId || `exp-${agentTool}`,
    candidate_id: extra.candidateId || `${agentTool}-p`,
    role: 'primary',
    agent_tool: agentTool,
    agent_model_requested: extra.model || null,
    status: 'running',
    attempt: 1,
    budget_usd: extra.budgetUsd !== undefined ? extra.budgetUsd : null,
    timeout_minutes: extra.timeoutMinutes !== undefined ? extra.timeoutMinutes : null,
    claimed_by: 'test',
    config,
  };
}

function readArgv(stubOut) {
  return JSON.parse(fs.readFileSync(path.join(stubOut, 'argv.json'), 'utf8'));
}

function readStdin(stubOut) {
  return fs.readFileSync(path.join(stubOut, 'stdin.txt'), 'utf8');
}

function candDir(ws, row) {
  return path.join(ws, '_experiments', row.experiment_id, 'candidates', row.candidate_id);
}

function assertArtifactSet(ws, row) {
  for (const f of ARTIFACTS) {
    assert.ok(fs.existsSync(path.join(candDir(ws, row), f)), `${row.candidate_id}/${f} missing`);
  }
  const runLog = fs.readFileSync(path.join(ws, '_metrics', 'candidate-run-log.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
  assert.ok(runLog.some(r => r.candidate_id === row.candidate_id), `no run-log row for ${row.candidate_id}`);
}

function readMetrics(ws, row) {
  return JSON.parse(fs.readFileSync(path.join(candDir(ws, row), 'METRICS.json'), 'utf8'));
}

// ---------- registry ----------

test('RUNNERS registers all four provider adapters; PROVIDERS names their real binaries', () => {
  for (const key of PROVIDER_KEYS) {
    assert.equal(hasRunner(key), true, `no runner for ${key}`);
    assert.equal(typeof RUNNERS[key], 'function');
    assert.equal(PROVIDERS[key].bin, BIN_BY_KEY[key]);
  }
});

// ---------- invocation shapes, one test per adapter ----------

test('codex: exec --sandbox … [-p <profile>] [extra…] - with the prompt on stdin (-p is PROFILE, never prompt)', () => {
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin(); const out = mkStubOut();
  const row = mkRow('codex', {
    repo, prompt: 'do the task', profile: 'todoapp', extra_flags: ['--flag-x'],
    env: stubEnv(bin, out),
  });

  const result = runCandidate(ws, row, { now: NOW });
  assert.equal(result.status, 'succeeded');

  assert.deepEqual(readArgv(out), ['exec', '--sandbox', 'workspace-write', '-p', 'todoapp', '--flag-x', '-']);
  assert.equal(readStdin(out), 'do the task'); // the brief travels on stdin via the trailing '-'
  assertArtifactSet(ws, row);
  const metrics = readMetrics(ws, row);
  assert.equal(metrics.status, 'succeeded');
  assert.equal(metrics.framework, 'codex');
  assert.match(fs.readFileSync(path.join(candDir(ws, row), 'PATCH.diff'), 'utf8'), /candidate-output\.txt/);

  // sandbox override is a structured field; no profile → no '-p' at all.
  const out2 = mkStubOut();
  const row2 = mkRow('codex', { repo, prompt: 'p', sandbox: 'read-only', env: stubEnv(bin, out2) }, { candidateId: 'codex-2' });
  runCandidate(ws, row2, { now: NOW });
  assert.deepEqual(readArgv(out2), ['exec', '--sandbox', 'read-only', '-']);
});

test('gemini (agy): --dangerously-skip-permissions first, -p LAST with the prompt as the final argv element', () => {
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin(); const out = mkStubOut();
  const row = mkRow('gemini', {
    repo, prompt: 'the real task', extra_flags: ['--flag-x', '--flag-y'],
    env: stubEnv(bin, out),
  });

  const result = runCandidate(ws, row, { now: NOW });
  assert.equal(result.status, 'succeeded');

  // The agy trap: `-p` consumes the NEXT token as the prompt. The adapter
  // emits extras BEFORE `-p`, so no flag can ever be swallowed as the task.
  const argv = readArgv(out);
  assert.deepEqual(argv, ['--dangerously-skip-permissions', '--flag-x', '--flag-y', '-p', 'the real task']);
  assert.equal(argv[argv.length - 1], 'the real task');
  assert.equal(argv[argv.length - 2], '-p');
  assertArtifactSet(ws, row);
  assert.equal(readMetrics(ws, row).framework, 'gemini');
});

test('claude: [extra…] -p with the prompt on stdin', () => {
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin(); const out = mkStubOut();
  const row = mkRow('claude', { repo, prompt: 'claude task', extra_flags: ['--flag-x'], env: stubEnv(bin, out) });

  const result = runCandidate(ws, row, { now: NOW });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(readArgv(out), ['--flag-x', '-p']);
  assert.equal(readStdin(out), 'claude task');
  assertArtifactSet(ws, row);
  assert.equal(readMetrics(ws, row).framework, 'claude');
});

test('cursor (cursor-agent): -f baked in first, -p LAST with the prompt as the final argv element', () => {
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin(); const out = mkStubOut();
  const row = mkRow('cursor', { repo, prompt: 'cursor task', extra_flags: ['--flag-x'], env: stubEnv(bin, out) });

  const result = runCandidate(ws, row, { now: NOW });
  assert.equal(result.status, 'succeeded');
  const argv = readArgv(out);
  assert.equal(argv[0], '-f'); // without -f the run refuses in an untrusted dir
  assert.deepEqual(argv, ['-f', '--flag-x', '-p', 'cursor task']);
  assertArtifactSet(ws, row);
  assert.equal(readMetrics(ws, row).framework, 'cursor');
});

// ---------- no-nested-quoting proof ----------

test('prompt delivery is byte-exact — quotes, $(), backslashes, newlines survive (no shell in the path)', () => {
  const hostile = 'a "double" \'single\' $(touch pwned) `bad` \\n\nline2 $PATH';
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin();

  const outStdin = mkStubOut();
  const rowStdin = mkRow('codex', { repo, prompt: hostile, env: stubEnv(bin, outStdin) });
  assert.equal(runCandidate(ws, rowStdin, { now: NOW }).status, 'succeeded');
  assert.equal(readStdin(outStdin), hostile);

  const outArgv = mkStubOut();
  const rowArgv = mkRow('gemini', { repo, prompt: hostile, env: stubEnv(bin, outArgv) }, { candidateId: 'gem-hostile' });
  assert.equal(runCandidate(ws, rowArgv, { now: NOW }).status, 'succeeded');
  const argv = readArgv(outArgv);
  assert.equal(argv[argv.length - 1], hostile);
  assert.equal(fs.existsSync(path.join(repo, 'pwned')), false, '$() must never execute');
});

// ---------- fault contract per adapter ----------

test('unavailable CLI (not on PATH) → status unavailable with the full artifact set, for every adapter', () => {
  const repo = mkRepo(); const ws = mkWorkspace();
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-adapters-empty-'));
  for (const key of PROVIDER_KEYS) {
    const row = mkRow(key, { repo, prompt: 'x', env: { PATH: emptyBin } }, { candidateId: `${key}-missing` });
    const result = runCandidate(ws, row, { now: NOW });
    assert.equal(result.status, 'unavailable', `${key} should be unavailable`);
    assert.match(result.reason, new RegExp(`${BIN_BY_KEY[key]} CLI not found on PATH`));
    assertArtifactSet(ws, row);
    const metrics = readMetrics(ws, row);
    assert.equal(metrics.status, 'unavailable');
    assert.equal(metrics.fault, 'unavailable');
    assert.equal(metrics.task_complete, false);
  }
});

test('missing repo → unavailable; missing prompt (no config.prompt, no tl spec) → failed with a pointed reason', () => {
  const ws = mkWorkspace(); const bin = mkStubBin();
  const noRepo = mkRow('claude', { prompt: 'x', env: stubEnv(bin, mkStubOut()) }, { candidateId: 'no-repo' });
  const r1 = runCandidate(ws, noRepo, { now: NOW });
  assert.equal(r1.status, 'unavailable');
  assert.match(r1.reason, /requires config\.repo/);

  const repo = mkRepo();
  const noPrompt = mkRow('claude', { repo, env: stubEnv(bin, mkStubOut()) }, { candidateId: 'no-prompt' });
  const r2 = runCandidate(ws, noPrompt, { now: NOW });
  assert.equal(r2.status, 'failed');
  assert.match(r2.reason, /no prompt/);
  assertArtifactSet(ws, noPrompt);
});

test('budget and timeout are honored like shell: over_budget stops before exec; a slow CLI times out', () => {
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin();

  const outB = mkStubOut();
  const costly = mkRow('codex', { repo, prompt: 'x', estimated_cost_usd: 5, env: stubEnv(bin, outB) },
    { candidateId: 'costly', budgetUsd: 1 });
  const rb = runCandidate(ws, costly, { now: NOW });
  assert.equal(rb.status, 'over_budget');
  assert.equal(fs.existsSync(path.join(outB, 'argv.json')), false, 'over_budget must stop BEFORE the CLI runs');
  assertArtifactSet(ws, costly);

  const slow = mkRow('gemini', { repo, prompt: 'x', env: stubEnv(bin, mkStubOut(), { STUB_SLEEP: '5000' }) },
    { candidateId: 'slow', timeoutMinutes: 0.02 }); // 1.2s
  const rt = runCandidate(ws, slow, { now: NOW });
  assert.equal(rt.status, 'timed_out');
  assertArtifactSet(ws, slow);
  assert.equal(readMetrics(ws, slow).fault, 'timed_out');
});

test('non-zero exit → failed; the canonical repo is never mutated and no worktree leaks', () => {
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin();
  const broken = mkRow('cursor', { repo, prompt: 'x', env: stubEnv(bin, mkStubOut(), { STUB_EXIT: '3' }) },
    { candidateId: 'broken' });
  const r = runCandidate(ws, broken, { now: NOW });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /exited 3/);
  assertArtifactSet(ws, broken);

  assert.deepEqual(fs.readdirSync(repo).filter(f => f !== '.git').sort(), ['existing.txt']);
  assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1);
});

// ---------- turnkey cohort-config path (queueExperiment → drainQueue) ----------

test('cohort config says agent_tool "codex" and it just works: structured overrides survive to the row, prompt defaults to the tl spec', () => {
  const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin(); const out = mkStubOut();
  queueExperiment(ws, {
    spec: 'specs/demo/',
    repoDir: repo,
    experimentId: 'exp-turnkey',
    candidates: [{
      id: 'cdx', role: 'primary', agent_tool: 'codex',
      repo, profile: 'todoapp', extra_flags: ['--flag-x'], env: stubEnv(bin, out),
    }],
    now: NOW,
  });

  // The overrides rode the queue row as structured config fields.
  const row = readQueueRows(ws).find(r => r.candidate_id === 'cdx');
  assert.equal(row.config.profile, 'todoapp');
  assert.deepEqual(row.config.extra_flags, ['--flag-x']);

  const result = drainQueue(ws, { agent: 'codex', now: NOW });
  assert.deepEqual(result.ran.map(r => [r.row.candidate_id, r.status]), [['cdx', 'succeeded']]);

  // Flag order encoded, profile in place, and the DEFAULT prompt is the spec.
  assert.deepEqual(readArgv(out), ['exec', '--sandbox', 'workspace-write', '-p', 'todoapp', '--flag-x', '-']);
  const stdin = readStdin(out);
  assert.match(stdin, /Demo spec/);
  assert.match(stdin, /controlled experiment/);
});

// ---------- the cockpit local-request bridge ----------

function writeRequest(ws, name, cfg) {
  const qdir = path.join(ws, '_experiments', 'queue');
  fs.mkdirSync(qdir, { recursive: true });
  fs.writeFileSync(path.join(qdir, name), JSON.stringify(cfg, null, 2));
  return path.join(qdir, name);
}

test('processQueueRequests bridges a runtime:"local" request (runner + repo) into real rows in that runner lane', () => {
  const repo = mkRepo(); const ws = mkWorkspace();
  writeRequest(ws, '20260714120000-local.json', {
    status: 'queued', source: 'ui-dashboard', runtime: 'local',
    runner: 'claude', repo,
    tl_spec: 'specs/demo', primary: 'cl-a', shadows: ['cl-b'], judge: 'fixture-judge',
    budget_usd: 2, timeout_minutes: 30, models: { 'cl-a': 'claude-opus' },
  });

  const results = processQueueRequests(ws, { now: NOW });
  const accepted = results.find(r => r.file === '20260714120000-local.json');
  assert.equal(accepted.status, 'accepted');

  const rows = readQueueRows(ws).filter(r => r.experiment_id === accepted.experimentId);
  assert.deepEqual(rows.map(r => [r.candidate_id, r.role, r.agent_tool, r.agent_model_requested]), [
    ['cl-a', 'primary', 'claude', 'claude-opus'],
    ['cl-b', 'shadow', 'claude', null],
  ]);
  for (const row of rows) {
    assert.equal(row.config.repo, repo); // every candidate carries the repo for isolation
    assert.equal(row.budget_usd, 2);
    assert.equal(row.timeout_minutes, 30);
  }

  // Audit trail: the request file is rewritten accepted, never deleted.
  const rewritten = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'queue', '20260714120000-local.json'), 'utf8'));
  assert.equal(rewritten.status, 'accepted');
  assert.equal(rewritten.experiment_id, accepted.experimentId);

  // Idempotent: a second pass does not re-queue it.
  assert.equal(processQueueRequests(ws, { now: NOW }).some(r => r.status === 'accepted'), false);
});

test('bridge hardening: same-spec requests in one pass get distinct ids; null budget/timeout stays null (never 0)', () => {
  const repo = mkRepo(); const ws = mkWorkspace();
  // Two requests for the SAME spec folded in the SAME pass — the experiment id
  // derives from the unique request filename, so they cannot collide.
  writeRequest(ws, '20260714130000-demo.json', {
    status: 'queued', runtime: 'local', runner: 'claude', repo, tl_spec: 'specs/demo',
    budget_usd: null, timeout_minutes: null, // the UI writes null for empty fields
  });
  writeRequest(ws, '20260714130001-demo.json', {
    status: 'queued', runtime: 'local', runner: 'codex', repo, tl_spec: 'specs/demo',
  });

  const results = processQueueRequests(ws, { now: NOW });
  assert.deepEqual(results.map(r => r.status), ['accepted', 'accepted']);
  assert.deepEqual(results.map(r => r.experimentId), ['exp-20260714130000-demo', 'exp-20260714130001-demo']);

  // null budget/timeout must NOT coerce to 0 — a 0-minute timeout means a
  // ~1ms spawn timeout, instantly killing every real run.
  const row = readQueueRows(ws).find(r => r.experiment_id === 'exp-20260714130000-demo');
  assert.equal(row.budget_usd, null);
  assert.equal(row.timeout_minutes, null);
});

test('malformed local requests are marked invalid with the reason — never silently dropped', () => {
  const repo = mkRepo(); const ws = mkWorkspace();
  writeRequest(ws, '20260714120001-no-runner.json', { status: 'queued', runtime: 'local', repo, tl_spec: 'specs/demo' });
  writeRequest(ws, '20260714120002-bad-runner.json', { status: 'queued', runtime: 'local', runner: 'windsurf', repo });
  writeRequest(ws, '20260714120003-no-repo.json', { status: 'queued', runtime: 'local', runner: 'codex' });
  writeRequest(ws, '20260714120004-ghost-repo.json', { status: 'queued', runtime: 'local', runner: 'codex', repo: '/nope/nowhere' });
  writeRequest(ws, '20260714120005-shell-no-cmd.json', { status: 'queued', runtime: 'local', runner: 'shell', repo });
  fs.writeFileSync(path.join(ws, '_experiments', 'queue', '20260714120006-corrupt.json'), '{not json');

  const results = processQueueRequests(ws, { now: NOW });
  const byFile = Object.fromEntries(results.map(r => [r.file, r]));

  assert.match(byFile['20260714120001-no-runner.json'].reason, /requires "runner"/);
  assert.match(byFile['20260714120002-bad-runner.json'].reason, /unknown runner "windsurf"/);
  assert.match(byFile['20260714120003-no-repo.json'].reason, /requires "repo"/);
  assert.match(byFile['20260714120004-ghost-repo.json'].reason, /repo not found/);
  assert.match(byFile['20260714120005-shell-no-cmd.json'].reason, /requires "command"/);
  for (const f of Object.keys(byFile).filter(f => !f.includes('corrupt'))) {
    assert.equal(byFile[f].status, 'invalid');
    const rewritten = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'queue', f), 'utf8'));
    assert.equal(rewritten.status, 'invalid', `${f} not rewritten invalid`);
    assert.ok(rewritten.error, `${f} carries no error`);
  }

  // Unparseable JSON: reported invalid, file left byte-identical (it may be a
  // corrupted audit record — never clobbered blind).
  assert.equal(byFile['20260714120006-corrupt.json'].status, 'invalid');
  assert.match(byFile['20260714120006-corrupt.json'].reason, /unparseable/);
  assert.equal(fs.readFileSync(path.join(ws, '_experiments', 'queue', '20260714120006-corrupt.json'), 'utf8'), '{not json');

  // No experiment was created for any malformed request.
  assert.equal(fs.readdirSync(path.join(ws, '_experiments')).filter(f => f.startsWith('exp-')).length, 0);
});

test('unknown future runtimes stay left-queued (reported, unmodified) — the forward-compat lane', () => {
  const ws = mkWorkspace();
  writeRequest(ws, '20260714120010-cloud.json', { status: 'queued', runtime: 'cloud', runner: 'codex' });
  const results = processQueueRequests(ws, { now: NOW });
  assert.deepEqual(results, [{ file: '20260714120010-cloud.json', status: 'left-queued', reason: 'runtime "cloud" needs explicit candidate config' }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'queue', '20260714120010-cloud.json'), 'utf8')).status, 'queued');
});

// ---------- cockpit queue form → /api/experiment-queue (local bridge fields) ----------

function makeUiRoot(wsName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-adapters-ui-'));
  const dir = path.join(root, 'projects', wsName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), 'goals: []\n');
  return { root, dir, wsName };
}

function startUiServer(root, port) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('tl ui')) resolve(); });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => reject(new Error('server exited early (' + code + '): ' + out)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 8000).unref();
  });
  return { child, ready };
}

async function postExperimentQueue(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/api/experiment-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('cockpit /api/experiment-queue writes runner+repo(+command) for runtime:local', async () => {
  const wsName = 'wsadapters';
  const { root, dir } = makeUiRoot(wsName);
  const repo = mkRepo();
  const port = 43000 + (process.pid % 2000);
  const { child, ready } = startUiServer(root, port);
  try {
    await ready;

    const ok = await postExperimentQueue(port, {
      ws: wsName, runtime: 'local', runner: 'claude', repo,
      spec: 'specs/local-claude/', primary: 'cl-a', shadows: ['cl-b'], judge: 'judge',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.queued.runtime, 'local');
    assert.equal(ok.body.queued.runner, 'claude');
    assert.equal(ok.body.queued.repo, repo);
    assert.equal(ok.body.queued.command, undefined);
    const written = JSON.parse(fs.readFileSync(path.join(dir, ok.body.path), 'utf8'));
    assert.equal(written.runner, 'claude');
    assert.equal(written.repo, repo);
    assert.equal(written.status, 'queued');

    // shell requires command — 400 without; written with command when present
    const noCmd = await postExperimentQueue(port, {
      ws: wsName, runtime: 'local', runner: 'shell', repo, spec: 'specs/shell-no-cmd/',
    });
    assert.equal(noCmd.status, 400);
    assert.match(noCmd.body.error, /shell runner requires a command/);

    const shell = await postExperimentQueue(port, {
      ws: wsName, runtime: 'local', runner: 'shell', repo, command: 'npm test',
      spec: 'specs/local-shell/',
    });
    assert.equal(shell.status, 200, JSON.stringify(shell.body));
    assert.equal(shell.body.queued.command, 'npm test');
    const shellFile = JSON.parse(fs.readFileSync(path.join(dir, shell.body.path), 'utf8'));
    assert.equal(shellFile.command, 'npm test');
    assert.equal(shellFile.runner, 'shell');

    // missing bridge fields fail fast (bridge re-validates on drain too)
    const noRunner = await postExperimentQueue(port, {
      ws: wsName, runtime: 'local', repo, spec: 'specs/no-runner/',
    });
    assert.equal(noRunner.status, 400);
    assert.match(noRunner.body.error, /requires a runner/);
    const noRepo = await postExperimentQueue(port, {
      ws: wsName, runtime: 'local', runner: 'codex', spec: 'specs/no-repo/',
    });
    assert.equal(noRepo.status, 400);
    assert.match(noRepo.body.error, /requires a repo/);

    // fixture path unchanged — no runner/repo on the request file
    const fixture = await postExperimentQueue(port, {
      ws: wsName, runtime: 'fixture', spec: 'specs/fixture-ok/',
    });
    assert.equal(fixture.status, 200, JSON.stringify(fixture.body));
    assert.equal(fixture.body.queued.runtime, 'fixture');
    assert.equal(fixture.body.queued.runner, undefined);
    assert.equal(fixture.body.queued.repo, undefined);
  } finally {
    child.kill();
  }
});

test('cockpit queue form markup exposes local runner/repo/command controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /class="q-local"/);
  assert.match(html, /class="q-runner"/);
  for (const r of ['codex', 'gemini', 'claude', 'cursor', 'shell']) {
    assert.match(html, new RegExp(`value="${r}"`));
  }
  assert.match(html, /class="q-repo"/);
  assert.match(html, /class="q-command"/);
  assert.match(html, /class="q-shell-only"/);
  assert.match(html, /body\.runner\s*=/);
  assert.match(html, /body\.repo\s*=/);
  assert.match(html, /body\.command\s*=/);
});

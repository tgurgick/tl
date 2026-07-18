'use strict';

// Experiment execution trust boundary — lib/env-policy.js and its wiring into
// lib/experiment-runner.js / lib/experiment-judge.js.
//
// What these tests pin:
//   1. The scrubber: representative ambient credentials (CLAUDE_CODE_OAUTH_TOKEN,
//      ANTHROPIC_API_KEY, JIRA_API_TOKEN, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY,
//      generic *_TOKEN/*_SECRET/*_PASSWORD names, SSH_AUTH_SOCK) never reach a
//      spawned candidate or judge command by default; benign runtime plumbing
//      (PATH, HOME, LANG, GIT_AUTHOR_NAME) does.
//   2. The per-lane allowlist: each provider CLI receives back exactly its OWN
//      auth variables — claude sees CLAUDE_CODE_OAUTH_TOKEN, never OPENAI_API_KEY;
//      shell receives no ambient credential at all.
//   3. Explicit widening: config.pass_env names pass through by explicit scoped
//      configuration; passed values are redacted from FEEDBACK.md, PATCH.diff,
//      and TRACE.jsonl (names are logged, values never are).
//   4. Default denial for unsandboxed shell: without the explicit trust opt-in
//      (row config.unsafe_host_exec: true or drain allowUnsafeHostExec) a shell
//      row fails closed with a concrete message and the command NEVER executes.
//      Both opt-in paths restore the old behavior (back-compat).
//   5. The judge's test command runs with a scrubbed environment.
//   6. Fixture behavior is unchanged — no env, no gate, no opt-in needed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  LANE_ENV_ALLOWLIST,
  isSecretEnvName,
  scrubEnvironment,
  buildLaneEnv,
  redactSecretValues,
  hostExecAllowed,
} = require('../lib/env-policy');
const { runCandidate } = require('../lib/experiment-runner');
const { queueExperiment, drainQueue, readQueueRows } = require('../lib/experiment-queue');

const NOW = new Date('2026-07-17T12:00:00Z');

// Representative ambient secrets — the exact shapes the 2026-07-17 audit named,
// plus generic vendor-agnostic ones. Values are unmistakable sentinels so any
// leak into an env dump or artifact is caught by exact match.
const AMBIENT_SECRETS = {
  CLAUDE_CODE_OAUTH_TOKEN: 'sentinel-claude-oauth-value-1234',
  ANTHROPIC_API_KEY: 'sentinel-anthropic-key-value-1234',
  OPENAI_API_KEY: 'sentinel-openai-key-value-1234',
  GEMINI_API_KEY: 'sentinel-gemini-key-value-1234',
  CURSOR_API_KEY: 'sentinel-cursor-key-value-1234',
  JIRA_API_TOKEN: 'sentinel-jira-token-value-1234',
  GITHUB_TOKEN: 'sentinel-github-token-value-1234',
  AWS_SECRET_ACCESS_KEY: 'sentinel-aws-secret-value-1234',
  NPM_TOKEN: 'sentinel-npm-token-value-1234',
  MY_APP_TOKEN: 'sentinel-generic-token-value-1234',
  DB_PASSWORD: 'sentinel-db-password-value-1234',
  SSH_AUTH_SOCK: '/tmp/sentinel-ssh-agent.sock',
};

// Run fn with the sentinel secrets present in process.env, then restore.
function withAmbientSecrets(fn) {
  const saved = {};
  for (const [k, v] of Object.entries(AMBIENT_SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, prev] of Object.entries(saved)) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

// ---------- fixtures (mirrors experiment-queue.test.js) ----------

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-envpol-repo-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'untouched\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  return dir;
}

function mkWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-envpol-ws-'));
  const specDir = path.join(ws, 'specs', 'demo');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'SPEC.md'), [
    '---', 'title: "Demo spec"', 'type: "feature"', 'status: "ready"', 'priority: "p2"', '---',
    '', '# Demo spec', '', '## Objective', '', 'Do the demo thing.', '',
  ].join('\n'));
  return ws;
}

function queueDemo(ws, repo, candidates, extra = {}) {
  return queueExperiment(ws, {
    spec: 'specs/demo/',
    repoDir: repo,
    experimentId: extra.experimentId || 'exp-t',
    candidates,
    judge: extra.judge || { id: 'fixture-judge', agent_tool: 'fixture' },
    budgetUsd: extra.budgetUsd,
    timeoutMinutes: extra.timeoutMinutes,
    now: NOW,
  });
}

// Stub provider CLI: records its full environment to $STUB_OUT/env.json and
// fabricates one edit so the collected diff is non-empty.
const STUB_SOURCE = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
if (process.env.STUB_OUT) {
  fs.writeFileSync(require('path').join(process.env.STUB_OUT, 'env.json'), JSON.stringify(process.env));
}
try { fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
fs.writeFileSync('candidate-output.txt', 'stub ran\\n');
`;

const PROVIDER_BINS = { codex: 'codex', gemini: 'agy', claude: 'claude', cursor: 'cursor-agent' };

function mkStubBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-envpol-bin-'));
  for (const name of Object.values(PROVIDER_BINS)) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, STUB_SOURCE);
    fs.chmodSync(file, 0o755);
  }
  return bin;
}

function mkRow(agentTool, config, extra = {}) {
  return {
    experiment_id: extra.experimentId || `exp-${agentTool}`,
    candidate_id: extra.candidateId || `${agentTool}-p`,
    role: 'primary',
    agent_tool: agentTool,
    agent_model_requested: null,
    status: 'running',
    attempt: 1,
    budget_usd: null,
    timeout_minutes: null,
    claimed_by: 'test',
    config,
  };
}

function candDir(ws, row) {
  return path.join(ws, '_experiments', row.experiment_id, 'candidates', row.candidate_id);
}

function readArtifact(ws, row, file) {
  return fs.readFileSync(path.join(candDir(ws, row), file), 'utf8');
}

// ---------- the scrubber ----------

test('scrubEnvironment drops representative credential names and keeps runtime plumbing', () => {
  const source = {
    ...AMBIENT_SECRETS,
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    GIT_AUTHOR_NAME: 'someone', // AUTHOR is not AUTH — segment matching, no false positive
    npm_config_cache: '/tmp/npm', // npm_* is credential-scoped (NPM_ prefix, case-insensitive) — verifier parity
  };
  const scrubbed = scrubEnvironment(source);
  for (const name of [...Object.keys(AMBIENT_SECRETS), 'npm_config_cache']) {
    assert.equal(name in scrubbed, false, `${name} must be scrubbed`);
  }
  for (const name of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'GIT_AUTHOR_NAME']) {
    assert.equal(scrubbed[name], source[name], `${name} must survive the scrub`);
  }
  // Explicit keep values overlay last — a decision, not ambient inheritance.
  assert.equal(scrubEnvironment(source, { PATH: '/stub' }).PATH, '/stub');
});

test('isSecretEnvName: vendor prefixes and secret name segments, without dumb false positives', () => {
  for (const name of Object.keys(AMBIENT_SECRETS)) assert.equal(isSecretEnvName(name), true, name);
  for (const name of ['ANTHROPIC_MODEL', 'CLAUDE_ANYTHING', 'GH_HOST']) assert.equal(isSecretEnvName(name), true, name);
  for (const name of ['PATH', 'HOME', 'SHELL', 'GIT_AUTHOR_EMAIL', 'TERM_PROGRAM', 'XPC_SERVICE_NAME']) {
    assert.equal(isSecretEnvName(name), false, name);
  }
});

// ---------- the per-lane allowlist ----------

test('buildLaneEnv: each provider lane receives back exactly its own auth, never another vendor\'s', () => {
  const source = { ...AMBIENT_SECRETS, PATH: '/usr/bin' };
  const expectOwn = {
    claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    codex: ['OPENAI_API_KEY'],
    gemini: ['GEMINI_API_KEY'],
    cursor: ['CURSOR_API_KEY'],
  };
  for (const [lane, own] of Object.entries(expectOwn)) {
    const { env, passed } = buildLaneEnv(lane, { source });
    for (const name of own) {
      assert.equal(env[name], source[name], `${lane} must receive ${name}`);
      assert.ok(passed.includes(name), `${lane} must record ${name} as passed`);
    }
    // Cross-lane and unrelated credentials never cross the boundary.
    const foreign = Object.keys(AMBIENT_SECRETS).filter(n => !(LANE_ENV_ALLOWLIST[lane] || []).includes(n));
    for (const name of foreign) assert.equal(name in env, false, `${lane} must not receive ${name}`);
    assert.equal(env.PATH, '/usr/bin');
  }
  // shell and unknown lanes get no ambient credential at all.
  for (const lane of ['shell', 'fixture', 'no-such-lane']) {
    const { env, passed } = buildLaneEnv(lane, { source });
    for (const name of Object.keys(AMBIENT_SECRETS)) assert.equal(name in env, false, `${lane}: ${name}`);
    assert.deepEqual(passed, []);
  }
});

test('buildLaneEnv: config.pass_env widens explicitly; config.env values overlay last; secret values registered for redaction', () => {
  const source = { ...AMBIENT_SECRETS, PATH: '/usr/bin' };
  const { env, passed, secretValues } = buildLaneEnv('shell', {
    source,
    passEnv: ['JIRA_API_TOKEN', 'NOT_SET_ANYWHERE'],
    configEnv: {
      PATH: '/stub',
      EXPLICIT_TOKEN: 'explicit-secret-value-1234',
      INNOCENT_NAME: 'credential-under-innocent-name-1234',
      SMALL: '1',
    },
  });
  assert.equal(env.JIRA_API_TOKEN, source.JIRA_API_TOKEN);
  assert.deepEqual(passed, ['JIRA_API_TOKEN']); // absent names are not invented
  assert.equal(env.PATH, '/stub');
  assert.equal(env.EXPLICIT_TOKEN, 'explicit-secret-value-1234');
  assert.ok(secretValues.includes(source.JIRA_API_TOKEN));
  assert.ok(secretValues.includes('explicit-secret-value-1234')); // secret-named config.env value
  assert.ok(secretValues.includes('credential-under-innocent-name-1234')); // names are not a redaction boundary
  assert.equal(secretValues.includes('1'), false); // short values are never redaction targets
  // Other ambient credentials still absent.
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false);
});

test('redactSecretValues replaces exact values, longest first, and ignores short values', () => {
  const out = redactSecretValues('token=abcdef123456 inner=abcdef', ['abcdef123456', 'abcdef', 'x']);
  assert.equal(out.includes('abcdef123456'), false);
  assert.equal(out, 'token=[redacted] inner=[redacted]');
  assert.equal(redactSecretValues('keep x here', ['x']), 'keep x here');
});

test('hostExecAllowed: only a literal true opts in — truthy look-alikes fail closed', () => {
  assert.equal(hostExecAllowed({ unsafe_host_exec: true }, {}), true);
  assert.equal(hostExecAllowed({}, { allowUnsafeHostExec: true }), true);
  for (const v of ['true', 1, 'yes', {}, []]) {
    assert.equal(hostExecAllowed({ unsafe_host_exec: v }, {}), false, String(v));
    assert.equal(hostExecAllowed({}, { allowUnsafeHostExec: v }), false, String(v));
  }
  assert.equal(hostExecAllowed({}, {}), false);
});

// ---------- runner end-to-end: provider lanes ----------

test('provider spawn env is scrubbed with the lane\'s own auth passed back — proven from inside the spawned CLI', () => {
  withAmbientSecrets(() => {
    const repo = mkRepo(); const ws = mkWorkspace(); const bin = mkStubBin();
    for (const [lane, own] of [['claude', 'CLAUDE_CODE_OAUTH_TOKEN'], ['codex', 'OPENAI_API_KEY']]) {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-envpol-out-'));
      const row = mkRow(lane, {
        repo, prompt: 'x',
        env: { PATH: bin + path.delimiter + process.env.PATH, STUB_OUT: out },
      }, { candidateId: `${lane}-env` });
      const result = runCandidate(ws, row, { now: NOW });
      assert.equal(result.status, 'succeeded', `${lane}: ${result.reason}`);

      const spawnedEnv = JSON.parse(fs.readFileSync(path.join(out, 'env.json'), 'utf8'));
      assert.equal(spawnedEnv[own], AMBIENT_SECRETS[own], `${lane} CLI must get its own ${own}`);
      const forbidden = Object.keys(AMBIENT_SECRETS).filter(n => !LANE_ENV_ALLOWLIST[lane].includes(n));
      for (const name of forbidden) {
        assert.equal(name in spawnedEnv, false, `${lane} CLI must not inherit ${name}`);
      }

      // The trace records passed-through NAMES, never values.
      const trace = readArtifact(ws, row, 'TRACE.jsonl');
      assert.match(trace, /Environment policy: ambient credentials scrubbed/);
      assert.match(trace, new RegExp(own));
      for (const value of Object.values(AMBIENT_SECRETS)) {
        assert.equal(trace.includes(value), false, `${lane} trace leaks a secret value`);
      }
    }
  });
});

// ---------- runner end-to-end: unsandboxed shell ----------

test('shell default denial: no opt-in → fails closed with a concrete message and the command never executes', () => {
  const repo = mkRepo(); const ws = mkWorkspace();
  const sentinel = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-envpol-sent-')), 'ran.txt');
  queueDemo(ws, repo, [
    { id: 'sh-denied', role: 'primary', agent_tool: 'shell', repo, command: `echo ran > ${sentinel}` },
  ]);

  const result = drainQueue(ws, { agent: 'shell', now: NOW });
  assert.deepEqual(result.ran.map(r => [r.row.candidate_id, r.status]), [['sh-denied', 'failed']]);
  assert.match(result.ran[0].reason, /unsandboxed shell execution declined/);
  assert.match(result.ran[0].reason, /unsafe_host_exec/);
  assert.match(result.ran[0].reason, /--unsafe-host-exec/);
  assert.match(result.ran[0].reason, /isolates the checkout, not the machine/);

  // Fails CLOSED: the command never ran, the repo is untouched, artifacts exist.
  assert.equal(fs.existsSync(sentinel), false, 'declined shell command must never execute');
  assert.deepEqual(fs.readdirSync(repo).filter(f => f !== '.git').sort(), ['existing.txt']);
  const row = readQueueRows(ws).find(r => r.candidate_id === 'sh-denied');
  assert.equal(row.status, 'failed');
  for (const f of ['PATCH.diff', 'FEEDBACK.md', 'METRICS.json', 'TRACE.jsonl']) {
    assert.ok(fs.existsSync(path.join(candDir(ws, row), f)), `${f} missing`);
  }
  assert.match(readArtifact(ws, row, 'FEEDBACK.md'), /unsandboxed shell execution declined/);
});

test('shell opt-in paths both work: row-level config.unsafe_host_exec and drain-level allowUnsafeHostExec (back-compat)', () => {
  const repo = mkRepo(); const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'sh-row', role: 'primary', agent_tool: 'shell', repo, command: 'echo a > a.txt', unsafe_host_exec: true },
    { id: 'sh-drain', role: 'shadow', agent_tool: 'shell', repo, command: 'echo b > b.txt' },
  ]);

  // Row-level opt-in: survives queueExperiment onto the row config and runs.
  const first = drainQueue(ws, { agent: 'shell', now: NOW, max: 1 });
  assert.deepEqual(first.ran.map(r => [r.row.candidate_id, r.status]), [['sh-row', 'succeeded']]);
  assert.equal(readQueueRows(ws).find(r => r.candidate_id === 'sh-row').config.unsafe_host_exec, true);

  // Drain-level opt-in: the explicit trusted drain runs the remaining row.
  const second = drainQueue(ws, { agent: 'shell', now: NOW, allowUnsafeHostExec: true });
  assert.deepEqual(second.ran.map(r => [r.row.candidate_id, r.status]), [['sh-drain', 'succeeded']]);
});

test('a trusted shell command still gets a scrubbed environment: ambient credentials are empty inside the run', () => {
  withAmbientSecrets(() => {
    const repo = mkRepo(); const ws = mkWorkspace();
    const row = mkRow('shell', {
      repo,
      unsafe_host_exec: true,
      command: 'printf "claude=[%s] jira=[%s] aws=[%s]" "$CLAUDE_CODE_OAUTH_TOKEN" "$JIRA_API_TOKEN" "$AWS_SECRET_ACCESS_KEY" > probe.txt',
    }, { candidateId: 'sh-scrub' });
    const result = runCandidate(ws, row, { now: NOW });
    assert.equal(result.status, 'succeeded', result.reason);
    // The probe landed in the patch — and every ambient credential was empty.
    const patch = readArtifact(ws, row, 'PATCH.diff');
    assert.match(patch, /claude=\[\] jira=\[\] aws=\[\]/);
  });
});

test('pass_env values cross the boundary by name but are redacted from FEEDBACK.md, PATCH.diff, and TRACE.jsonl', () => {
  withAmbientSecrets(() => {
    const repo = mkRepo(); const ws = mkWorkspace();
    const secret = AMBIENT_SECRETS.MY_APP_TOKEN;
    const row = mkRow('shell', {
      repo,
      unsafe_host_exec: true,
      pass_env: ['MY_APP_TOKEN'],
      command: 'echo "token is $MY_APP_TOKEN"; echo "$MY_APP_TOKEN" > leaked.txt',
    }, { candidateId: 'sh-passenv' });
    const result = runCandidate(ws, row, { now: NOW });
    assert.equal(result.status, 'succeeded', result.reason);

    // The value reached the command (leaked.txt is in the diff)…
    const patch = readArtifact(ws, row, 'PATCH.diff');
    assert.match(patch, /leaked\.txt/);
    // …but the VALUE never lands in any artifact; the NAME is logged.
    for (const f of ['FEEDBACK.md', 'PATCH.diff', 'TRACE.jsonl']) {
      assert.equal(readArtifact(ws, row, f).includes(secret), false, `${f} leaks the pass_env value`);
    }
    assert.match(readArtifact(ws, row, 'FEEDBACK.md'), /\[redacted\]/);
    assert.match(readArtifact(ws, row, 'TRACE.jsonl'), /MY_APP_TOKEN/);
  });
});

// ---------- judge: test command env ----------

test('the judge test command runs with a scrubbed environment — ambient credentials invisible to candidate-authored code', () => {
  withAmbientSecrets(() => {
    const repo = mkRepo(); const ws = mkWorkspace();
    queueDemo(ws, repo, [
      { id: 'sh-p', role: 'primary', agent_tool: 'shell', repo, command: 'echo new > added.txt', unsafe_host_exec: true },
    ]);
    drainQueue(ws, { agent: 'shell', now: NOW, allowUnsafeHostExec: true });

    // The test command PASSES only when every ambient credential is absent.
    const result = drainQueue(ws, {
      agent: 'fixture', now: NOW, judges: true, repoDir: repo,
      testCommand: 'test -z "$CLAUDE_CODE_OAUTH_TOKEN" && test -z "$JIRA_API_TOKEN" && test -z "$AWS_SECRET_ACCESS_KEY" && test -f added.txt',
    });
    assert.deepEqual(result.judged.map(j => [j.status, j.winner]), [['succeeded', 'sh-p']]);
    const scores = JSON.parse(fs.readFileSync(path.join(ws, '_experiments', 'exp-t', 'evaluation', 'fixture-judge', 'SCORES.json'), 'utf8'));
    assert.equal(scores.candidates['sh-p'].gates.tests_pass, true);
  });
});

// ---------- fixture behavior unchanged ----------

test('fixture candidates need no opt-in and no environment — the safe default path is untouched', () => {
  const repo = mkRepo(); const ws = mkWorkspace();
  queueDemo(ws, repo, [
    { id: 'fix-a', role: 'primary', agent_tool: 'fixture', complete: true },
    { id: 'fix-b', role: 'shadow', agent_tool: 'fixture', complete: false },
  ]);
  const result = drainQueue(ws, { agent: 'fixture', now: NOW });
  assert.deepEqual(result.ran.map(r => [r.row.candidate_id, r.status]).sort(),
    [['fix-a', 'succeeded'], ['fix-b', 'succeeded']]);
});

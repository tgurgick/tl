'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RESULT_BEGIN, RESULT_END, scrubEnvironment, normalizePolicy, buildGeminiInvocation,
  parseStructuredResult, runIsolatedVerification, recordVerificationOutcome,
} = require('../lib/verifier-worker');

test('scrubEnvironment removes common credential variables', () => {
  const env = scrubEnvironment({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'x', GEMINI_API_KEY: 'y', JIRA_EMAIL: 'z' });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('policy rejects dangerous bypass and commands in review-only mode', () => {
  assert.throws(() => normalizePolicy({ command: ['agy', '--dangerously-skip-permissions'] }), /forbidden/);
  assert.throws(() => normalizePolicy({ mode: 'review-only', allow_commands: ['npm test'] }), /cannot declare/);
});

test('Gemini invocation forces sandboxed plan mode and keeps -p last', () => {
  const got = buildGeminiInvocation({ command: ['agy'], mode: 'verify' }, 'brief');
  assert.deepEqual(got, { file: 'agy', args: ['--sandbox', '--mode', 'plan', '-p', 'brief'] });
});

test('structured result markers are required and validated', () => {
  const got = parseStructuredResult(`noise\n${RESULT_BEGIN}\n{"verdict":"pass","notes":["ok"],"proposed_mutations":[]}\n${RESULT_END}`);
  assert.equal(got.verdict, 'pass');
  assert.throws(() => parseStructuredResult('{"verdict":"pass"}'), /markers/);
});

function fakeRun(sequence, calls) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    const next = sequence.shift();
    if (!next) throw new Error('unexpected spawn: ' + file);
    return next;
  };
}

test('clean pass runs allowlisted checks, writes nothing canonical, and cleans isolation', () => {
  const calls = [], removed = [];
  const spawn = fakeRun([
    { status: 0, stdout: 'tests ok', stderr: '' },
    { status: 0, stdout: `${RESULT_BEGIN}\n{"verdict":"pass","notes":[],"proposed_mutations":[]}\n${RESULT_END}`, stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ], calls);
  const result = runIsolatedVerification({
    repo: '/canonical', brief: 'check it', policy: { command: ['agy'], allow_commands: ['npm test'] }, spawn,
    createWorktree: () => '/isolated', removeWorktree: (...args) => removed.push(args), env: { PATH: '/bin', GEMINI_API_KEY: 'secret' },
  });
  assert.equal(result.status, 'pass');
  assert.equal(calls[0].file, '/bin/sh');
  assert.equal(calls[1].file, 'agy');
  assert.equal(calls[1].opts.env.GEMINI_API_KEY, undefined);
  assert.equal(removed.length, 1);
});

test('proposed or actual mutation raises to human and never becomes a pass', () => {
  const spawn = fakeRun([
    { status: 0, stdout: `${RESULT_BEGIN}\n{"verdict":"pass","notes":["change it"],"proposed_mutations":[{"file":"a.js","reason":"bug"}]}\n${RESULT_END}`, stderr: '' },
    { status: 0, stdout: ' M b.js\n', stderr: '' },
  ], []);
  const result = runIsolatedVerification({
    repo: '/canonical', brief: 'review', policy: { command: ['agy'], mode: 'review-only' }, spawn,
    createWorktree: () => '/isolated', removeWorktree: () => {}, env: { PATH: '/bin' },
  });
  assert.equal(result.status, 'human-decision-required');
  assert.deepEqual(result.proposed_mutations.map(x => x.file), ['a.js', 'b.js']);
});

test('failed allowlisted check blocks even when model says pass', () => {
  const spawn = fakeRun([
    { status: 1, stdout: '', stderr: 'red' },
    { status: 0, stdout: `${RESULT_BEGIN}\n{"verdict":"pass","notes":[],"proposed_mutations":[]}\n${RESULT_END}`, stderr: '' },
    { status: 0, stdout: '', stderr: '' },
  ], []);
  const result = runIsolatedVerification({
    repo: '/canonical', brief: 'review', policy: { command: ['agy'], allow_commands: ['npm test'] }, spawn,
    createWorktree: () => '/isolated', removeWorktree: () => {}, env: { PATH: '/bin' },
  });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /acceptance command failed/);
});

function workspaceSpec() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-verifier-record-'));
  const dir = path.join(ws, 'tests', 'demo');
  fs.mkdirSync(path.join(dir, 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SPEC.md'), '---\ntitle: Demo\ntype: feature\nstatus: tests\nawaiting_verifier: true\n---\n\n# Demo\n');
  return { ws, dir };
}

test('mutation proposal writes notes and stays blocked at tests', t => {
  const { ws, dir } = workspaceSpec(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const got = recordVerificationOutcome({ wsDir: ws, slug: 'demo', builder: 'cursor', verifier: 'gemini', result: {
    status: 'human-decision-required', notes: ['behavior concern'], proposed_mutations: [{ file: 'a.js', reason: 'fix it' }],
  } });
  assert.equal(got.path, 'tests/demo/');
  assert.match(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), /No mutation was applied/);
  assert.match(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'), /status: "blocked"/);
  assert.equal(fs.existsSync(path.join(ws, 'in-review', 'demo')), false);
});

test('clean pass is the only outcome that trusted TL advances', t => {
  const { ws } = workspaceSpec(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const got = recordVerificationOutcome({ wsDir: ws, slug: 'demo', builder: 'cursor', verifier: 'gemini', result: {
    status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [],
  } });
  assert.equal(got.path, 'in-review/demo/');
  const spec = fs.readFileSync(path.join(ws, 'in-review', 'demo', 'SPEC.md'), 'utf8');
  assert.match(spec, /verified_by: "gemini"/);
  assert.match(spec, /verification_type: "independent"/);
});

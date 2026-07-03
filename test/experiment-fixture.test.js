'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runFixtureExperiment } = require('../lib/experiment-fixture');

function mkWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-fixture-'));
  for (const name of ['specs', 'in-progress', 'tests', 'in-review', 'done', '_metrics']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'specs', '.keep'), '');
  fs.writeFileSync(path.join(dir, 'in-progress', '.keep'), '');
  fs.writeFileSync(path.join(dir, 'tests', '.keep'), '');
  return dir;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('fixture experiment writes candidates, evaluation, logs, and leaves canonical stages alone', () => {
  const ws = mkWorkspace();
  const before = {
    specs: fs.readdirSync(path.join(ws, 'specs')).sort(),
    inProgress: fs.readdirSync(path.join(ws, 'in-progress')).sort(),
    tests: fs.readdirSync(path.join(ws, 'tests')).sort(),
  };

  const result = runFixtureExperiment(ws, {
    experimentId: 'fixture-test',
    now: new Date('2026-07-03T12:00:00Z'),
    baseCommit: 'abc123',
  });

  assert.equal(result.experimentId, 'fixture-test');
  assert.equal(result.winner, 'fixture-a');

  const exp = path.join(ws, '_experiments', 'fixture-test');
  assert.equal(fs.existsSync(path.join(exp, 'EXPERIMENT.md')), true);
  for (const candidate of ['fixture-a', 'fixture-b']) {
    const dir = path.join(exp, 'candidates', candidate);
    assert.match(fs.readFileSync(path.join(dir, 'PATCH.diff'), 'utf8'), /diff --git/);
    assert.equal(fs.existsSync(path.join(dir, 'FEEDBACK.md')), true);
    assert.equal(readJson(path.join(dir, 'METRICS.json')).agent_tool, 'fixture');
    assert.match(fs.readFileSync(path.join(dir, 'TRACE.jsonl'), 'utf8'), /"type":"start"/);
  }

  const scores = readJson(path.join(exp, 'evaluation', 'fixture-judge', 'SCORES.json'));
  assert.equal(scores.winner, 'fixture-a');
  assert.equal(scores.candidates['fixture-a'].hard_gates_passed, true);
  assert.equal(scores.candidates['fixture-b'].hard_gates_passed, false);
  assert.match(fs.readFileSync(path.join(exp, 'evaluation', 'fixture-judge', 'EVALUATION.md'), 'utf8'), /Winner: `fixture-a`/);

  assert.equal(readJsonl(path.join(ws, '_metrics', 'candidate-run-log.jsonl')).length, 2);
  assert.equal(readJsonl(path.join(ws, '_metrics', 'judge-log.jsonl')).length, 1);
  assert.equal(readJsonl(path.join(ws, '_metrics', 'experiment-log.jsonl')).length, 2);

  assert.deepEqual(fs.readdirSync(path.join(ws, 'specs')).sort(), before.specs);
  assert.deepEqual(fs.readdirSync(path.join(ws, 'in-progress')).sort(), before.inProgress);
  assert.deepEqual(fs.readdirSync(path.join(ws, 'tests')).sort(), before.tests);
});

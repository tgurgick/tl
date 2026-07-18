'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildProjectInsights,
  countAddedLinesFromDiff,
  gitLineStats,
  sumNumstatAdded,
  aggregateToolActivity,
  aggregateActiveAgents,
  summarizeExperiments,
  normTool,
} = require('../lib/project-insights');

test('countAddedLinesFromDiff ignores headers and counts + lines', () => {
  const diff = [
    '--- a/foo.js',
    '+++ b/foo.js',
    '+added',
    '+also',
    ' context',
    '-removed',
  ].join('\n');
  assert.equal(countAddedLinesFromDiff(diff), 2);
});

test('normTool normalizes claude-code', () => {
  assert.equal(normTool('claude-code'), 'claude');
  assert.equal(normTool('Codex'), 'codex');
});

test('aggregateActiveAgents groups in-progress and tests by claimed_by', () => {
  const specs = [
    { stage: 'in-progress', title: 'A', path: 'in-progress/a/', meta: { claimed_by: 'cursor' } },
    { stage: 'tests', title: 'B', path: 'tests/b/', meta: { claimed_by: 'cursor' } },
    { stage: 'in-progress', title: 'C', path: 'in-progress/c/', meta: { claimed_by: 'claude' } },
    { stage: 'ready', title: 'D', path: 'specs/d/', meta: { claimed_by: 'cursor' } },
  ];
  const agents = aggregateActiveAgents(specs);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].agent, 'cursor');
  assert.equal(agents[0].count, 2);
});

test('aggregateToolActivity merges metrics and done feedback with perf stats', () => {
  const specs = [
    { stage: 'done', feedback: { agent_tool: 'codex', duration_minutes: 10, cost_usd: 0.5, tokens_used: 20000 } },
    { stage: 'done', feedback: { agent_tool: 'codex', duration_minutes: 20, cost_usd: 1.0, tokens_used: 40000 } },
  ];
  const metrics = {
    'candidate-run-log': [
      { agent_tool: 'cursor', duration_minutes: 5, cost_usd: 0.1, tokens_used: 5000 },
      { agent_tool: 'cursor', duration_minutes: 15, cost_usd: 0.3, tokens_used: 15000 },
      { agent_tool: 'codex' },
    ],
    'cycle-log': [{ agent_tool: 'claude-code', duration_minutes: 8, cost_usd: 0.2, tokens_used: 8000 }],
  };
  const tools = aggregateToolActivity(specs, metrics);
  assert.equal(tools[0].tool, 'codex');
  assert.equal(tools[0].count, 3);
  assert.equal(tools[0].avg_duration_minutes, 15);
  assert.equal(tools[0].avg_cost_usd, 0.75);
  assert.equal(tools[0].avg_tokens_used, 30000);
  assert.equal(tools[1].tool, 'cursor');
  assert.equal(tools[1].avg_duration_minutes, 10);
});

test('aggregateModelPerformance groups by agent_model', () => {
  const { aggregateModelPerformance } = require('../lib/project-insights');
  const metrics = {
    'candidate-run-log': [
      { agent_tool: 'claude', agent_model: 'claude-fable-5', duration_minutes: 12, cost_usd: 0.4, tokens_used: 30000 },
      { agent_tool: 'claude', agent_model: 'claude-fable-5', duration_minutes: 18, cost_usd: 0.6, tokens_used: 50000 },
      { agent_tool: 'codex', agent_model: 'gpt-5.3-codex', duration_minutes: 6, cost_usd: 0.15, tokens_used: 12000 },
    ],
  };
  const models = aggregateModelPerformance([], metrics);
  assert.equal(models.length, 2);
  assert.equal(models[0].model, 'claude-fable-5');
  assert.equal(models[0].count, 2);
  assert.equal(models[0].avg_duration_minutes, 15);
  assert.equal(models[0].tool, 'claude');
});

test('summarizeExperiments aggregates status and latest highlight', () => {
  const { buildExperimentHighlight } = require('../lib/project-insights');
  const summary = summarizeExperiments([
    {
      id: 'fixture-1',
      status: 'succeeded',
      task_type: 'fixture',
      winner: 'fixture-a',
      winner_tool: 'fixture',
      winner_model: 'deterministic',
      rationale: 'fixture-a passed the fixture hard gates with the highest utility.',
      candidate_count: 2,
    },
    {
      id: 'bakeoff',
      status: 'judged',
      task_type: 'feature',
      summary: 'Implement the per-agent owner badge on cockpit cards.',
      winner: 'claude',
      winner_tool: 'claude-code',
      winner_model: 'claude-opus-4-8',
      rationale: 'Claude wins: corner-badge approach adds no card height.',
      candidate_count: 3,
      created: '2026-07-02',
    },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.candidate_runs, 5);
  assert.equal(summary.latest.experiment_id, 'bakeoff');
  assert.equal(summary.latest.winner_model, 'claude-opus-4-8');
  assert.equal(summary.latest.winner_tool, 'claude');
  assert.match(summary.latest.rationale, /corner-badge/);
});

test('buildExperimentHighlight formats winner model and rationale', () => {
  const { buildExperimentHighlight } = require('../lib/project-insights');
  const h = buildExperimentHighlight({
    id: 'x',
    task_type: 'feature',
    summary: 'Owner badge bake-off',
    winner: 'claude',
    winner_tool: 'claude-code',
    winner_model: 'claude-opus-4-8',
    rationale: 'Best scope discipline.',
    winner_set_by: 'gemini',
  });
  assert.equal(h.winner_tool, 'claude');
  assert.equal(h.winner_model, 'claude-opus-4-8');
  assert.equal(h.rationale, 'Best scope discipline.');
});

// ---------- git-derived line counts ----------

test('sumNumstatAdded sums the insertions column and skips binary rows', () => {
  const numstat = [
    '10\t2\tlib/a.js',
    '3\t0\ttest/a.test.js',
    '-\t-\tassets/logo.png',   // binary — skipped
    '',
    'not a numstat line',
  ].join('\n');
  assert.equal(sumNumstatAdded(numstat), 13);
  assert.equal(sumNumstatAdded(''), 0);
  assert.equal(sumNumstatAdded(null), 0);
});

function fakeCheckoutDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-insights-git-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

test('gitLineStats derives total and last-7-days from git log --numstat', () => {
  const dir = fakeCheckoutDir();
  const calls = [];
  const exec = (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes('--since=7.days')) return '4\t1\tlib/a.js\n';
    return '100\t20\tlib/a.js\n7\t0\tui/x.html\n-\t-\tbin.png\n';
  };
  const stats = gitLineStats(dir, { exec });
  assert.deepEqual(stats, { available: true, total: 107, week: 4 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.cwd === dir));
  assert.ok(calls.every(c => c.args[0] === 'log' && c.args.includes('--numstat')));
  assert.ok(calls[1].args.includes('--since=7.days'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gitLineStats degrades gracefully: no repo, not a checkout, git errors', () => {
  // no repo path at all
  assert.deepEqual(gitLineStats(null), { available: false, total: 0, week: 0 });
  assert.deepEqual(gitLineStats(''), { available: false, total: 0, week: 0 });

  // dir exists but is not a checkout (no .git) — never asks git, so an
  // enclosing repo can't be misattributed to this workspace
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-insights-plain-'));
  let asked = 0;
  assert.deepEqual(gitLineStats(plain, { exec: () => { asked++; return '1\t0\tx\n'; } }),
    { available: false, total: 0, week: 0 });
  assert.equal(asked, 0);
  fs.rmSync(plain, { recursive: true, force: true });

  // checkout, but git errors (exec seam returns null) — unavailable, no throw
  const dir = fakeCheckoutDir();
  assert.deepEqual(gitLineStats(dir, { exec: () => null }),
    { available: false, total: 0, week: 0 });
  fs.rmSync(dir, { recursive: true, force: true });

  // missing dir
  assert.deepEqual(gitLineStats(path.join(os.tmpdir(), 'tl-no-such-dir-xyz'), { exec: () => '1\t0\tx\n' }),
    { available: false, total: 0, week: 0 });
});

test('gitLineStats reads a real fixture repo end to end', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-insights-real-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git('init');
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return t.skip('git unavailable');
  }
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'tl test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-m', 'fixture');

  const stats = gitLineStats(dir); // real exec — commit is fresh, so week == total
  assert.equal(stats.available, true);
  assert.equal(stats.total, 3);
  assert.equal(stats.week, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildProjectInsights sources lines_added from git when the repo is a checkout', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-insights-ws-'));
  const patchDir = path.join(ws, '_experiments', 'exp-1', 'candidates', 'cand-1');
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, 'PATCH.diff'), '--- a/x\n+++ b/x\n+one\n+two\n');
  const repo = fakeCheckoutDir();

  const insights = buildProjectInsights({
    wsDir: ws,
    specs: [],
    metrics: {},
    experiments: [],
    repoDir: repo,
    gitExec: (args) => (args.includes('--since=7.days') ? '5\t0\ta\n' : '40\t3\ta\n2\t0\tb\n'),
  });
  assert.equal(insights.lines_added.git_available, true);
  assert.equal(insights.lines_added.total, 42);   // git replaces, no double count
  assert.equal(insights.lines_added.week, 5);
  assert.equal(insights.lines_added.source, 'git');
  assert.equal(insights.lines_added.experiments, 2); // artifact count preserved

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('buildProjectInsights without a usable repo keeps the honest degradation', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-insights-bare-'));

  // no repo, no artifacts → source none, total 0 (UI renders an em dash)
  const none = buildProjectInsights({ wsDir: bare, repoDir: null });
  assert.equal(none.lines_added.git_available, false);
  assert.equal(none.lines_added.source, 'none');
  assert.equal(none.lines_added.total, 0);
  assert.equal(none.lines_added.week, null);

  // no repo, but experiment patches exist → legacy source still works
  const patchDir = path.join(bare, '_experiments', 'e', 'candidates', 'c');
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, 'PATCH.diff'), '+++ b/x\n+a\n+b\n+c\n');
  const legacy = buildProjectInsights({ wsDir: bare, repoDir: null });
  assert.equal(legacy.lines_added.source, 'experiments');
  assert.equal(legacy.lines_added.total, 3);

  // repo set but git errors → falls back to experiments, never throws
  const repo = fakeCheckoutDir();
  const broken = buildProjectInsights({ wsDir: bare, repoDir: repo, gitExec: () => null });
  assert.equal(broken.lines_added.git_available, false);
  assert.equal(broken.lines_added.source, 'experiments');
  assert.equal(broken.lines_added.total, 3);

  fs.rmSync(bare, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('buildProjectInsights counts patch lines from experiment artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-insights-'));
  const patchDir = path.join(root, '_experiments', 'exp-1', 'candidates', 'cand-1');
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, 'PATCH.diff'), '--- a/x\n+++ b/x\n+one\n+two\n');

  const insights = buildProjectInsights({
    wsDir: root,
    specs: [],
    metrics: {},
    experiments: [],
  });
  assert.equal(insights.lines_added.total, 2);
  assert.equal(insights.active_agent_count, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildProjectInsights,
  countAddedLinesFromDiff,
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

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { safeRead, isDir } = require('./workspace');

const ACTIVE_STAGES = new Set(['in-progress', 'tests']);
const STAGE_KEYS = ['ready', 'in-progress', 'tests', 'in-review', 'done', 'triage'];

function normTool(tool) {
  if (!tool) return '';
  const s = String(tool).toLowerCase().trim();
  if (s === 'claude-code') return 'claude';
  return s;
}

function countAddedLinesFromDiff(text) {
  let n = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) n++;
  }
  return n;
}

function countExperimentPatchLines(wsDir) {
  const base = path.join(wsDir, '_experiments');
  if (!isDir(base)) return 0;
  let total = 0;
  for (const expId of fs.readdirSync(base)) {
    if (expId.startsWith('.')) continue;
    const candDir = path.join(base, expId, 'candidates');
    if (!isDir(candDir)) continue;
    for (const cid of fs.readdirSync(candDir)) {
      if (cid.startsWith('.')) continue;
      const patch = path.join(candDir, cid, 'PATCH.diff');
      const text = safeRead(patch);
      if (text) total += countAddedLinesFromDiff(text);
    }
  }
  return total;
}

// ---------- git-derived line counts ----------
//
// The insights "Lines added" stat is derived from the workspace's repo, not
// from experiment artifacts (most workspaces have none, so that source reads
// 0 forever — cockpit report 2026-07-03). Semantics as shipped:
//   total — sum of the insertions column of `git log --numstat` over the full
//           history reachable from HEAD (all-time lines added).
//   week  — same sum over `git log --since=7.days` (rolling last-7-days
//           window by commit date, ending now).
// Binary rows (`-\t-\tpath`) are skipped. Defensive exec per the
// dirtyGitPaths pattern in bin/tl.js: any git failure (missing repo, not a
// checkout, git absent) yields { available: false } — never a throw, so the
// UI can show "—" instead of a misleading 0.

function sumNumstatAdded(text) {
  let added = 0;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\d+)\t\d+\t/);
    if (m) added += Number(m[1]);
  }
  return added;
}

function defaultGitExec(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
}

// 60s TTL cache for the default (real) exec only — readWorkspace runs on every
// cockpit fetch and `git log --numstat` over full history is not free on big
// repos. Injected execs (tests) always compute fresh.
const GIT_STATS_TTL_MS = 60 * 1000;
const gitStatsCache = new Map();

function gitLineStats(repoDir, opts = {}) {
  const none = { available: false, total: 0, week: 0 };
  if (!repoDir) return none;
  const exec = opts.exec || defaultGitExec;
  const cacheable = !opts.exec;
  if (cacheable) {
    const hit = gitStatsCache.get(repoDir);
    if (hit && Date.now() - hit.at < GIT_STATS_TTL_MS) return hit.value;
  }
  // Require the dir itself to be a checkout (`.git` present) — otherwise git
  // would silently report on an enclosing repo, which isn't this workspace's.
  let isCheckout = false;
  try { isCheckout = fs.existsSync(path.join(repoDir, '.git')); } catch { isCheckout = false; }
  let value = none;
  if (isCheckout) {
    const totalRaw = exec(['log', '--pretty=tformat:', '--numstat'], repoDir);
    if (totalRaw != null) {
      const weekRaw = exec(['log', '--since=7.days', '--pretty=tformat:', '--numstat'], repoDir);
      value = {
        available: true,
        total: sumNumstatAdded(totalRaw),
        week: weekRaw != null ? sumNumstatAdded(weekRaw) : 0,
      };
    }
  }
  if (cacheable) gitStatsCache.set(repoDir, { at: Date.now(), value });
  return value;
}

function bumpTool(map, tool, n = 1) {
  const key = normTool(tool);
  if (!key) return;
  map[key] = (map[key] || 0) + n;
}

function emptyToolStats(tool) {
  return {
    tool,
    count: 0,
    duration_minutes: 0,
    cost_usd: 0,
    tokens_used: 0,
    runs_with_duration: 0,
    runs_with_cost: 0,
    runs_with_tokens: 0,
  };
}

function emptyModelStats(model, tool) {
  return {
    model,
    tool: tool || '',
    count: 0,
    duration_minutes: 0,
    cost_usd: 0,
    tokens_used: 0,
    runs_with_duration: 0,
    runs_with_cost: 0,
    runs_with_tokens: 0,
  };
}

function numField(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ingestRunStats(bucket, row) {
  bucket.count++;
  const dur = numField(row.duration_minutes);
  if (dur != null) {
    bucket.duration_minutes += dur;
    bucket.runs_with_duration++;
  }
  const cost = numField(row.cost_usd);
  if (cost != null) {
    bucket.cost_usd += cost;
    bucket.runs_with_cost++;
  }
  const tok = numField(row.tokens_used);
  if (tok != null) {
    bucket.tokens_used += tok;
    bucket.runs_with_tokens++;
  }
}

function finalizeToolStats(bucket) {
  return {
    tool: bucket.tool,
    count: bucket.count,
    duration_minutes: bucket.duration_minutes,
    cost_usd: bucket.cost_usd,
    tokens_used: bucket.tokens_used,
    avg_duration_minutes: bucket.runs_with_duration
      ? +(bucket.duration_minutes / bucket.runs_with_duration).toFixed(1)
      : null,
    avg_cost_usd: bucket.runs_with_cost
      ? +(bucket.cost_usd / bucket.runs_with_cost).toFixed(3)
      : null,
    avg_tokens_used: bucket.runs_with_tokens
      ? Math.round(bucket.tokens_used / bucket.runs_with_tokens)
      : null,
    total_cost_usd: bucket.runs_with_cost ? +bucket.cost_usd.toFixed(3) : null,
    total_tokens_used: bucket.runs_with_tokens ? bucket.tokens_used : null,
  };
}

function finalizeModelStats(bucket) {
  const out = finalizeToolStats(bucket);
  return {
    model: bucket.model,
    tool: bucket.tool,
    count: out.count,
    avg_duration_minutes: out.avg_duration_minutes,
    avg_cost_usd: out.avg_cost_usd,
    avg_tokens_used: out.avg_tokens_used,
    total_cost_usd: out.total_cost_usd,
    total_tokens_used: out.total_tokens_used,
  };
}

function normModel(model) {
  const s = String(model || '').trim();
  return s || 'unknown';
}

function ingestMetricRows(specs, metrics, onRow) {
  for (const row of metrics['candidate-run-log'] || []) onRow(row);
  for (const row of metrics['cycle-log'] || []) onRow(row);
  for (const s of specs) {
    if (s.stage !== 'done' || !s.feedback) continue;
    onRow(s.feedback);
  }
}

function aggregateToolActivity(specs, metrics) {
  const map = {};
  ingestMetricRows(specs, metrics, (row) => {
    const tool = normTool(row.agent_tool);
    if (!tool) return;
    if (!map[tool]) map[tool] = emptyToolStats(tool);
    ingestRunStats(map[tool], row);
  });
  return Object.values(map)
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, 3)
    .map(finalizeToolStats);
}

function aggregateModelPerformance(specs, metrics) {
  const map = {};
  ingestMetricRows(specs, metrics, (row) => {
    const model = normModel(row.agent_model);
    if (model === 'unknown') return;
    const tool = normTool(row.agent_tool);
    if (!map[model]) map[model] = emptyModelStats(model, tool);
    else if (!map[model].tool && tool) map[model].tool = tool;
    ingestRunStats(map[model], row);
  });
  return Object.values(map)
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model))
    .slice(0, 3)
    .map(finalizeModelStats);
}

function aggregateActiveAgents(specs) {
  const map = {};
  for (const s of specs) {
    if (!ACTIVE_STAGES.has(s.stage)) continue;
    const agent = String(s.meta.claimed_by || s.meta.agent || 'unknown').toLowerCase();
    if (!map[agent]) map[agent] = { agent, count: 0, specs: [] };
    map[agent].count++;
    if (map[agent].specs.length < 3) {
      map[agent].specs.push({ title: s.title, path: s.path, stage: s.stage });
    }
  }
  return Object.values(map).sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent));
}

function aggregateStageCounts(specs) {
  const counts = Object.fromEntries(STAGE_KEYS.map(k => [k, 0]));
  for (const s of specs) {
    if (counts[s.stage] != null) counts[s.stage]++;
  }
  return counts;
}

function summarizeExperiments(experiments) {
  const byStatus = {};
  let candidateRuns = 0;
  for (const e of experiments || []) {
    const st = String(e.status || 'unknown').toLowerCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
    candidateRuns += e.candidate_count || 0;
  }
  const latest = buildExperimentHighlight(pickLatestExperiment(experiments));
  return {
    total: (experiments || []).length,
    by_status: byStatus,
    candidate_runs: candidateRuns,
    latest,
    recent_winner: latest?.winner_id || '',
    recent_winner_tool: latest?.winner_tool || '',
  };
}

function taskTitleFromBody(body) {
  const m = String(body || '').match(/^#\s+(.+)/m);
  return m ? m[1].trim() : '';
}

function firstParagraph(body) {
  for (const line of String(body || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.replace(/^\*\*[^*]+\*\*:?\s*/, '').slice(0, 200);
  }
  return '';
}

function specSlug(tlSpec) {
  return String(tlSpec || '').replace(/\/$/, '').split('/').pop() || '';
}

function pickLatestExperiment(experiments) {
  const withWinner = (experiments || []).filter(e => e.winner);
  return withWinner.find(e => e.task_type !== 'fixture') || withWinner[0] || null;
}

function buildExperimentHighlight(exp) {
  if (!exp || !exp.winner) return null;
  const summary = String(exp.summary || exp.task_title || specSlug(exp.tl_spec) || exp.task_type || '').trim();
  return {
    experiment_id: exp.id || '',
    task_summary: summary.slice(0, 220),
    task_title: exp.task_title || '',
    tl_spec: exp.tl_spec || '',
    task_type: exp.task_type || '',
    winner_id: exp.winner,
    winner_tool: normTool(exp.winner_tool) || normTool(exp.winner),
    winner_model: String(exp.winner_model || '').trim(),
    rationale: String(exp.rationale || '').trim().slice(0, 280),
    winner_set_by: exp.winner_set_by || '',
  };
}

function buildProjectInsights({ wsDir, specs = [], metrics = {}, experiments = [], repoDir = null, gitExec } = {}) {
  const activeAgents = aggregateActiveAgents(specs);
  const stageCounts = aggregateStageCounts(specs);
  const tools = aggregateToolActivity(specs, metrics);
  const models = aggregateModelPerformance(specs, metrics);
  const expLines = wsDir ? countExperimentPatchLines(wsDir) : 0;
  const git = gitLineStats(repoDir, { exec: gitExec });
  const experimentsSummary = summarizeExperiments(experiments);

  // `total` stays the headline number: git when available (experiment patches
  // land as commits eventually — summing both would double-count), else the
  // legacy experiment-artifact count. `source` lets the UI degrade honestly:
  // 'none' renders as "—", never a misleading 0.
  return {
    active_agents: activeAgents,
    active_agent_count: activeAgents.reduce((n, a) => n + a.count, 0),
    stage_counts: stageCounts,
    lines_added: {
      experiments: expLines,
      git_available: git.available,
      week: git.available ? git.week : null,
      source: git.available ? 'git' : (expLines > 0 ? 'experiments' : 'none'),
      total: git.available ? git.total : expLines,
    },
    tools,
    models,
    experiments: experimentsSummary,
  };
}

module.exports = {
  buildProjectInsights,
  countAddedLinesFromDiff,
  gitLineStats,
  sumNumstatAdded,
  aggregateToolActivity,
  aggregateModelPerformance,
  aggregateActiveAgents,
  aggregateStageCounts,
  summarizeExperiments,
  buildExperimentHighlight,
  pickLatestExperiment,
  taskTitleFromBody,
  firstParagraph,
  normTool,
  finalizeToolStats,
};

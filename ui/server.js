#!/usr/bin/env node
// tl UI server — zero dependencies (Node stdlib only).
//
// GET serves the cockpit read-only. A small set of localhost POST actions
// (capture, priority override, thread status, research, review accept/kick,
// notes) mutate the markdown workspace. Trust model: the server binds to
// 127.0.0.1 for a single local user — there is no auth, but every mutating
// POST must carry a per-process write token injected into the served HTML
// (see "write guard" below), so an arbitrary web page open in the same
// browser cannot fire cross-origin POSTs at the cockpit. Every write resolves
// through safePath (can't escape the workspace) and mutates records via
// lib/frontmatter (scoped, sanitized — no whole-file string surgery).
// Usage: node ui/server.js [--port 4400] [--root <repo root>]

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(arg('port', '4400'), 10);
const ROOT = path.resolve(arg('root', process.cwd()));

// Shared parsing, path-guard, and frontmatter helpers live in lib/ — the same
// modules the CLI (bin/tl.js) uses, so parsing and mutation rules can't drift.
const { parseYaml, parseFrontmatter } = require('../lib/parse');
const { safeRead, readFirst, isDir, mtime, safePath: libSafePath } = require('../lib/workspace');
const {
  fmValue, setFrontmatterField, appendToFrontmatterList, setFrontmatterList,
} = require('../lib/frontmatter');
const { buildProjectInsights, taskTitleFromBody, firstParagraph } = require('../lib/project-insights');
const { localRepoPath, specSlug } = require('../lib/batch');
const { automationStatus } = require('../lib/automation');
const {
  writeVerifyRequest, applyVerifyHumanDecision, readVerifierLanes,
  verifierStatusOf, readVerifyRequests, loadSpecTracePayload,
  readPendingContinuations, appendSpecTraceEvent,
} = require('../lib/worker');
const { canAdvanceToReview } = require('../lib/verification-gate');
const { recallSearch } = require('../lib/recall');
const { buildBenchmarkRecord, appendBenchmarkRecord, intentGoalIds } = require('../lib/benchmark-log');
const { detectStalledClaims, reclaimStalled, stallThresholdMs } = require('../lib/stall');

// "did we already discuss this?" is the product — capped and grouped, not a
// search engine. The cap truncates the ranked list; grouping stays identical
// to `tl recall` (both call lib/recall.js recallSearch).
const RECALL_CAP = 30;

// ---------- workspace reading ----------

function listWorkspaces() {
  const out = [];
  const projects = path.join(ROOT, 'projects');
  if (isDir(projects)) {
    for (const name of fs.readdirSync(projects).sort()) {
      if (isDir(path.join(projects, name))) out.push({ name, dir: path.join(projects, name), example: false });
    }
  }
  const sample = path.join(ROOT, 'examples', 'sample-project');
  if (isDir(sample)) out.push({ name: 'sample-project', dir: sample, example: true });
  return out;
}

function readStage(dir, stage, folder) {
  const stageDir = path.join(dir, folder);
  if (!isDir(stageDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(stageDir).sort()) {
    if (entry.startsWith('.')) continue;
    const p = path.join(stageDir, entry);
    let file = null, isFolder = false;
    if (isDir(p)) { file = path.join(p, 'SPEC.md'); isFolder = true; }
    else if (entry.endsWith('.md')) file = p;
    if (!file) continue;
    const text = safeRead(file);
    if (text === null) continue;
    const { meta, body } = parseFrontmatter(text);
    const item = {
      stage, path: folder + '/' + entry + (isFolder ? '/' : ''),
      title: meta.title || entry.replace(/\.md$/, ''),
      meta, body, mtime: mtime(file),
    };
    if (stage === 'done' && isFolder) {
      const fb = readFirst(path.join(p, 'outcome', 'FEEDBACK.md'), path.join(p, 'outcome', 'feedback.md'));
      if (fb) item.feedback = parseFrontmatter(fb).meta;
    }
    if (isFolder) {
      const outDir = path.join(p, 'outcome');
      if (isDir(outDir)) {
        const outs = [];
        for (const of of fs.readdirSync(outDir).sort()) {
          if (!of.endsWith('.md')) continue;
          const c = safeRead(path.join(outDir, of));
          if (c) outs.push({ name: of.replace(/\.md$/, ''), body: parseFrontmatter(c).body });
        }
        // recommendation first — it's the thing to review
        outs.sort((a, b) => (a.name === 'RECOMMENDATION' ? -1 : b.name === 'RECOMMENDATION' ? 1 : 0));
        if (outs.length) item.outcome = outs;
      }
      const notes = safeRead(path.join(p, 'NOTES.md'));
      if (notes) item.notes = notes;
      if (stage === 'tests' || stage === 'in-progress' || stage === 'in-review') {
        item.verifier = verifierStatusOf(item, { wsDir: dir });
        // Spec-scoped activity trace (TRACE.jsonl) — omit key when absent so
        // the drawer falls back to body/notes. Rides the existing workspace
        // payload + file-watch/SSE; no new endpoint or server-side execution.
        const trace = loadSpecTracePayload(p);
        if (trace) item.trace = trace;
      }
    }
    out.push(item);
  }
  return out;
}

function readWorkspace(ws) {
  const dir = ws.dir;
  const configText = readFirst(path.join(dir, 'TRIAGE.yml'), path.join(dir, 'triage.yml'));
  let config = null;
  try { config = configText ? parseYaml(configText) : null; } catch { config = null; }

  const intents = [];
  const intentsDir = path.join(dir, 'intents');
  if (isDir(intentsDir)) {
    for (const f of fs.readdirSync(intentsDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const { meta, body } = parseFrontmatter(safeRead(path.join(intentsDir, f)) || '');
      intents.push({ path: 'intents/' + f, title: meta.title || f, meta, body });
    }
  }

  const specs = [
    ...readStage(dir, 'triage', 'triage'),
    ...readStage(dir, 'ready', 'specs'),
    ...readStage(dir, 'in-progress', 'in-progress'),
    ...readStage(dir, 'tests', 'tests'),
    ...readStage(dir, 'in-review', 'in-review'),
    ...readStage(dir, 'done', 'done'),
  ];

  // Stall assessment for in-progress cards — eligibility comes from lib/stall.js
  // (threshold + guards), never duplicated thresholds in the UI. Annotate only
  // stalled claims so the cockpit can badge + offer an explicit per-spec reclaim.
  try {
    const thresholdMs = stallThresholdMs(config);
    const forDetect = specs.filter(s => s.stage === 'in-progress' && String(s.path || '').endsWith('/')).map(s => ({
      ...s,
      dir: path.join(dir, s.path.replace(/\/$/, '')),
    }));
    const continuations = { live: readPendingContinuations(dir, specs) };
    const stalled = detectStalledClaims(dir, forDetect, { thresholdMs, continuations });
    const bySlug = new Map(stalled.map(x => [x.slug, x]));
    for (const s of specs) {
      if (s.stage !== 'in-progress') continue;
      const hit = bySlug.get(specSlug(s.path));
      if (!hit) continue;
      s.stall = {
        stalled: true,
        idle_hours: hit.idleHours,
        idle_ms: hit.idleMs,
        last_seen_ms: hit.lastSeenMs,
        reason: hit.reason,
        owner: (s.meta && s.meta.claimed_by) || null,
        threshold_hours: Math.round(thresholdMs / 3600000),
      };
    }
  } catch { /* stall annotation is advisory — never break the board payload */ }

  const threads = [];
  const threadsDir = path.join(dir, 'threads');
  if (isDir(threadsDir)) {
    for (const f of fs.readdirSync(threadsDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const { meta, body } = parseFrontmatter(safeRead(path.join(threadsDir, f)) || '');
      threads.push({ path: 'threads/' + f, title: meta.title || f, meta, body, mtime: mtime(path.join(threadsDir, f)) });
    }
  }

  const metrics = {};
  const metricsDir = path.join(dir, '_metrics');
  if (isDir(metricsDir)) {
    for (const f of fs.readdirSync(metricsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const linesOut = [];
      for (const line of (safeRead(path.join(metricsDir, f)) || '').split('\n')) {
        if (!line.trim()) continue;
        try { linesOut.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
      metrics[f.replace('.jsonl', '')] = linesOut;
    }
  }

  // Read-only automation chip for Human/Resume — observe only; never spawn.
  let automation = null;
  try {
    const st = automationStatus({ wsDir: dir, wsName: ws.name, root: ROOT, cfg: config || {} });
    automation = {
      signal: st.signal,                 // up | paused | misconfigured | off | not-installed
      stuckAtTests: st.stuckAtTests,     // count at the verifier gate
      paused: st.paused,
      enabled: st.automation.enabled,
      configured: st.automation.configured,
      intervalMinutes: st.automation.intervalMinutes,
      lanes: st.lanes,
      issues: st.issues.map(i => ({ lane: i.lane, problem: i.problem })),
      experiment: st.automation.experiment,
      // Shared doctor payload (lib/doctor.js) — observe only.
      health: st.health ? {
        ok: st.health.ok,
        stuck_at_tests: st.health.stuck_at_tests,
        lifecycle: {
          ok: st.health.lifecycle.summary.ok,
          total: st.health.lifecycle.summary.total,
          findings: (st.health.lifecycle.findings || []).slice(0, 20).map(f => ({
            kind: f.kind, slug: f.slug, stage: f.stage || null, detail: f.detail || null, fix: f.fix || null,
          })),
        },
        capacity: {
          ok: st.health.capacity.summary.ok,
          available: st.health.capacity.summary.available || [],
          lanes: (st.health.capacity.verifier_lanes || []).map(r => ({
            id: r.id, agent: r.agent, state: r.state, ok: r.ok,
            reason: r.reason || null, fix: r.fix || null,
          })),
        },
      } : null,
    };
  } catch { automation = null; }

  let verifierLanes = [];
  try { verifierLanes = readVerifierLanes(config || {}); } catch { verifierLanes = []; }
  let verifyRequests = [];
  try {
    verifyRequests = readVerifyRequests(dir)
      .filter(r => r.request && r.request.status === 'pending')
      .map(r => ({ path: r.file, spec: r.request.spec, target_lane: r.request.target_lane }));
  } catch { verifyRequests = []; }

  // The workspace's own repo (PROJECT.md `repo:`) feeds the git-derived
  // lines-of-code stat. localRepoPath ~-expands local refs and returns null
  // for URLs/unset — gitLineStats degrades to unavailable, never throws.
  const projectMeta = parseFrontmatter(safeRead(path.join(dir, 'PROJECT.md')) || '').meta;
  return {
    name: ws.name, example: ws.example,
    config, intents, specs, threads, metrics, automation,
    verifierLanes: verifierLanes.map(l => ({ id: l.id, agent: l.agent })),
    verifyRequests,
    insights: buildProjectInsights({
      wsDir: dir,
      specs,
      metrics,
      experiments: readExperiments(ws),
      repoDir: localRepoPath(projectMeta.repo),
    }),
    priorities: readFirst(path.join(dir, 'PRIORITIES.md'), path.join(dir, 'priorities.md')),
    project: projectMeta,
  };
}

// ---------- experiments (read-only observation of _experiments/ + _metrics/) ----------
//
// The UI reads experiment artifacts; it never executes agents. Artifacts follow
// docs/agent-experiments.md: _experiments/<id>/EXPERIMENT.md (index frontmatter),
// candidates/<cid>/{METRICS.json,PATCH.diff,TRACE.jsonl,FEEDBACK.md,REASONING.md},
// evaluation/<jid>/{SCORES.json,EVALUATION.md}. Markdown is human narrative; JSON/JSONL
// is the learning surface — so we read the JSON for structure and only surface prose on demand.

const TRACE_CAP = 200;      // hard cap on trace rows returned — large traces are capped, not streamed
const PATCH_CAP = 600;      // hard cap on diff lines returned per candidate — big patches are capped, not streamed
const SECRET_RE = /(sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|(?:api[_-]?key|secret|token|password|bearer)["'\s:=]+[A-Za-z0-9._\-]{8,})/gi;

// scrub anything that looks like a credential from trace/reasoning text before it leaves the server
function redact(s) {
  return String(s == null ? '' : s).replace(SECRET_RE, '[redacted]');
}

function readJsonFile(p) {
  const t = safeRead(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// one experiment's index-level summary (cheap — used for the queue list)
function experimentSummary(expDir, id) {
  const raw = safeRead(path.join(expDir, 'EXPERIMENT.md')) || '';
  const { meta, body } = parseFrontmatter(raw);
  const candDir = path.join(expDir, 'candidates');
  const candidates = isDir(candDir) ? fs.readdirSync(candDir).filter(c => !c.startsWith('.') && isDir(path.join(candDir, c))).sort() : [];
  // winner comes from the judge's SCORES.json (the learning surface), not prose
  let winner = '', winnerSetBy = '', judgeStatus = '', rationale = '';
  const evalDir = path.join(expDir, 'evaluation');
  if (isDir(evalDir)) {
    for (const jid of fs.readdirSync(evalDir).sort()) {
      const scores = readJsonFile(path.join(evalDir, jid, 'SCORES.json'));
      if (scores) {
        winner = scores.winner || '';
        winnerSetBy = scores.winner_set_by || '';
        judgeStatus = scores.status || '';
        rationale = scores.rationale || '';
        break;
      }
    }
  }
  let winnerTool = '', winnerModel = '';
  if (winner && isDir(candDir)) {
    const wm = readJsonFile(path.join(candDir, winner, 'METRICS.json'));
    if (wm) {
      winnerTool = wm.agent_tool || '';
      winnerModel = wm.agent_model || '';
    }
  }
  const taskTitle = taskTitleFromBody(body);
  const summary = meta.summary || firstParagraph(body) || taskTitle;
  // "running" = something is actively moving in shadow — the experiment status is
  // an active state, or any candidate's METRICS.json reports one. Drives the live
  // dot on the Experiments tab so it only shows while a test is in flight.
  const ACTIVE = new Set(['running', 'in-progress', 'in_progress', 'working', 'started', 'evaluating']);
  let running = ACTIVE.has(String(meta.status || '').toLowerCase());
  if (!running && isDir(candDir)) {
    for (const c of candidates) {
      const cm = readJsonFile(path.join(candDir, c, 'METRICS.json'));
      if (cm && ACTIVE.has(String(cm.status || '').toLowerCase())) { running = true; break; }
    }
  }
  return {
    id,
    status: meta.status || 'unknown',
    running,
    task_type: meta.task_type || '',
    tl_spec: meta.tl_spec || '',
    summary,
    task_title: taskTitle,
    primary_agent: meta.primary_agent || '',
    shadow_agents: meta.shadow_agents || [],
    judge_agent: meta.judge_agent || '',
    created: meta.created || '',
    replay_of: meta.replay_of || '',
    winner, winner_set_by: winnerSetBy, judge_status: judgeStatus, rationale,
    winner_tool: winnerTool, winner_model: winnerModel,
    candidate_count: candidates.length,
    mtime: mtime(path.join(expDir, 'EXPERIMENT.md')),
  };
}

// list every experiment under a workspace's _experiments/, newest first
function readExperiments(ws) {
  const base = path.join(ws.dir, '_experiments');
  if (!isDir(base)) return [];
  const out = [];
  for (const id of fs.readdirSync(base).sort()) {
    if (id.startsWith('.') || !isDir(path.join(base, id))) continue;
    // only real experiment dirs — an experiment is defined by its EXPERIMENT.md
    // (docs/agent-experiments.md). queue/ holds pending request JSONs, not an
    // experiment, and must never render as a phantom "UNKNOWN" row or count in
    // insights; same for any other non-experiment dir under _experiments/.
    if (id === 'queue' || !fs.existsSync(path.join(base, id, 'EXPERIMENT.md'))) continue;
    out.push(experimentSummary(path.join(base, id), id));
  }
  return out.sort((a, b) => (b.created || '').localeCompare(a.created || '') || b.mtime - a.mtime);
}

// one candidate's full record: metrics fields + a capped, redacted trace + reasoning presence
function readCandidate(candDir, cid) {
  const metrics = readJsonFile(path.join(candDir, 'METRICS.json')) || {};
  const traceRaw = safeRead(path.join(candDir, 'TRACE.jsonl')) || '';
  const traceLines = traceRaw.split('\n').filter(l => l.trim());
  const total = traceLines.length;
  const rows = [];
  for (const line of traceLines.slice(0, TRACE_CAP)) {
    try {
      const r = JSON.parse(line);
      rows.push({ ts: r.ts || '', type: r.type || '', status: r.status || '', summary: redact(r.summary || r.message || '') });
    } catch { /* skip bad trace line */ }
  }
  const reasoningRaw = safeRead(path.join(candDir, 'REASONING.md'));
  // the candidate's diff, for side-by-side comparison — secret-redacted and line-capped like the trace
  const patchRaw = safeRead(path.join(candDir, 'PATCH.diff'));
  const patchLines = patchRaw ? redact(patchRaw).split('\n') : [];
  return {
    candidate_id: cid,
    role: metrics.role || '',
    status: metrics.status || 'unknown',
    agent_tool: metrics.agent_tool || '',
    agent_model: metrics.agent_model || '',
    agent_model_auto: !!metrics.agent_model_auto,
    agent_model_source: metrics.agent_model_source || 'unknown',
    runtime_version: metrics.runtime_version || '',
    framework: metrics.framework || '',
    cost_usd: metrics.cost_usd ?? null,
    duration_minutes: metrics.duration_minutes ?? null,
    tokens_used: metrics.tokens_used ?? null,
    task_complete: metrics.task_complete ?? null,
    fault: metrics.fault ?? null,
    has_patch: patchLines.length > 0,
    patch: patchLines.length ? patchLines.slice(0, PATCH_CAP).join('\n') : null,
    patch_capped: patchLines.length > PATCH_CAP,
    patch_total: patchLines.length,
    trace: rows,
    trace_total: total,
    trace_capped: total > TRACE_CAP,
    reasoning: reasoningRaw ? redact(reasoningRaw) : null,
  };
}

// full detail for one experiment: index, candidates, judge scores, winner/apply state
function readExperimentDetail(ws, id) {
  const expDir = path.join(ws.dir, '_experiments', id);
  if (!isDir(expDir)) return null;
  const { meta, body } = parseFrontmatter(safeRead(path.join(expDir, 'EXPERIMENT.md')) || '');
  const candDir = path.join(expDir, 'candidates');
  const candidates = [];
  if (isDir(candDir)) {
    for (const cid of fs.readdirSync(candDir).sort()) {
      if (cid.startsWith('.') || !isDir(path.join(candDir, cid))) continue;
      candidates.push(readCandidate(path.join(candDir, cid), cid));
    }
  }
  // sort primary first, then shadows, then anything else
  candidates.sort((a, b) => (a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : 0));
  let judge = null;
  const evalDir = path.join(expDir, 'evaluation');
  if (isDir(evalDir)) {
    for (const jid of fs.readdirSync(evalDir).sort()) {
      const scores = readJsonFile(path.join(evalDir, jid, 'SCORES.json'));
      if (!scores) continue;
      judge = { judge_id: jid, ...scores, evaluation: safeRead(path.join(evalDir, jid, 'EVALUATION.md')) };
      break;
    }
  }
  // winner / application state — reserved application fields (docs/agent-experiments.md)
  // live in an optional WINNER.json; degrade to just the judge's pick when absent.
  const winnerFile = readJsonFile(path.join(expDir, 'WINNER.json')) || {};
  const winner = {
    candidate_id: winnerFile.candidate_id || (judge && judge.winner) || '',
    set_by: winnerFile.set_by || (judge && judge.winner_set_by) || '',
    apply_state: winnerFile.apply_state || '',
    patch_path: winnerFile.patch_path || '',
    apply_error: winnerFile.apply_error || '',
    human_override: winnerFile.human_override ?? (judge && judge.winner_set_by === 'human') ?? false,
  };
  return { id, meta, body, candidates, judge, winner };
}

// ---------- change tracking (snapshot diffs — workspaces aren't in git) ----------

const TEXT_RE = /\.(md|yml|yaml|jsonl|json)$/;
const snapshots = new Map();   // full path -> array of lines
const changes = new Map();     // ws|path -> {ws, path, status, added, removed, ts}

function readLines(p) { const t = safeRead(p); return t === null ? null : t.split('\n'); }

function walkFiles(dir, cb) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const full = path.join(dir, e);
    if (isDir(full)) walkFiles(full, cb);
    else if (TEXT_RE.test(e)) cb(full);
  }
}

function primeSnapshots() {
  for (const ws of listWorkspaces()) walkFiles(ws.dir, f => snapshots.set(f, readLines(f)));
}

function diffCounts(oldL, newL) {
  const m = new Map();
  for (const l of oldL) m.set(l, (m.get(l) || 0) + 1);
  let added = 0;
  for (const l of newL) {
    const c = m.get(l) || 0;
    if (c > 0) m.set(l, c - 1); else added++;
  }
  let removed = 0;
  for (const c of m.values()) removed += c;
  return { added, removed };
}

// LCS line diff -> ops [type, line] where type is ' ', '+', '-'
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4000000) return null; // too big — counts only
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

// keep 2 context lines around changes, collapse the rest into gap markers
function toHunks(ops, maxLines = 120) {
  if (!ops) return null;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o[0] !== ' ') for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
  });
  const out = [];
  let gap = 0;
  for (let i = 0; i < ops.length && out.length < maxLines; i++) {
    if (keep[i]) {
      if (gap) { out.push({ t: '.', n: gap }); gap = 0; }
      out.push({ t: ops[i][0], s: ops[i][1].slice(0, 200) });
    } else gap++;
  }
  if (gap) out.push({ t: '.', n: gap });
  return out;
}

const diffBuffer = [];
function pushDiff(rec, hunks) {
  diffBuffer.push({ ...rec, hunks });
  if (diffBuffer.length > 60) diffBuffer.shift();
}

function trackChange(wsName, rel, full, exists) {
  if (!TEXT_RE.test(rel)) return null;
  let status, added = 0, removed = 0, hunks = null;
  const before = snapshots.get(full);
  if (!exists) {
    if (before == null) return null;
    status = 'D'; removed = before.length;
    hunks = toHunks(before.map(l => ['-', l]));
    snapshots.delete(full);
  } else {
    const now = readLines(full) || [];
    if (before == null) {
      status = 'A'; added = now.length;
      hunks = toHunks(now.map(l => ['+', l]));
    } else {
      status = 'M';
      ({ added, removed } = diffCounts(before, now));
      hunks = toHunks(lcsOps(before, now));
    }
    snapshots.set(full, now);
  }
  const key = wsName + '|' + rel;
  const prev = changes.get(key);
  if (exists && prev && added === 0 && removed === 0) return null; // duplicate watch event, content unchanged
  if (prev && prev.status === 'A' && status === 'M') status = 'A';
  const rec = { ws: wsName, path: rel, status, added, removed, ts: Date.now() };
  changes.set(key, rec);
  if (changes.size > 300) changes.delete(changes.keys().next().value);
  if (added || removed) pushDiff(rec, hunks);
  return rec;
}

// ---------- live events (SSE + fs watch) ----------

const clients = new Set();
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 30000).unref();

// Lifecycle stage folders. Near-simultaneous delete+add of the same slug across
// these is a status move (specs→in-progress, …), not a scary delete+create.
const STAGE_DIRS = new Set(['specs', 'in-progress', 'tests', 'in-review', 'done', 'triage']);
const STAGE_PATH_RE = /^(specs|in-progress|tests|in-review|done|triage)\/([^/]+)(?:\/(.*))?$/;
const FIXTURE_WS_RE = /^tl-clitest-/;
const MOVE_CORRELATE_MS = 900;

function stageParts(rel) {
  const m = String(rel || '').match(STAGE_PATH_RE);
  if (!m) return null;
  return { stage: m[1], slug: m[2], rest: m[3] || '' };
}

// Buffer stage-folder events by workspace+slug so a rename across stages
// collapses to one `move` SSE event instead of a DEL + ADD pair.
const pendingMoves = new Map(); // ws|slug -> { events, timer }

function flushMoveBucket(key) {
  const bucket = pendingMoves.get(key);
  if (!bucket) return;
  pendingMoves.delete(key);
  const events = bucket.events;
  const deletedStages = new Set();
  const addedStages = new Set();
  for (const e of events) {
    if (e.exists) addedStages.add(e._stage.stage);
    else deletedStages.add(e._stage.stage);
  }
  const fromStages = [...deletedStages].filter(s => !addedStages.has(s));
  const toStages = [...addedStages].filter(s => !deletedStages.has(s));
  if (fromStages.length >= 1 && toStages.length >= 1) {
    const fromStage = fromStages[0];
    const toStage = toStages[0];
    const slug = events[0]._stage.slug;
    const ws = events[0].ws;
    broadcast({
      ws,
      path: `${toStage}/${slug}`,
      exists: true,
      ts: Date.now(),
      move: {
        from: `${fromStage}/${slug}`,
        to: `${toStage}/${slug}`,
        fromStage,
        toStage,
        slug,
      },
    });
    return;
  }
  for (const e of events) {
    const payload = { ...e };
    delete payload._stage;
    broadcast(payload);
  }
}

function enqueueOrBroadcast(payload) {
  const info = stageParts(payload.path);
  if (!info || !STAGE_DIRS.has(info.stage)) {
    broadcast(payload);
    return;
  }
  // Log line appends under a stage folder (cycle-log etc.) stay immediate —
  // they aren't folder moves and shouldn't wait for correlate.
  if (payload.log) {
    broadcast(payload);
    return;
  }
  const key = payload.ws + '|' + info.slug;
  let bucket = pendingMoves.get(key);
  if (!bucket) {
    bucket = { events: [] };
    pendingMoves.set(key, bucket);
  }
  payload._stage = info;
  bucket.events.push(payload);
  clearTimeout(bucket.timer);
  bucket.timer = setTimeout(() => flushMoveBucket(key), MOVE_CORRELATE_MS);
  if (bucket.timer.unref) bucket.timer.unref();
}

const debounceTimers = new Map();
function watchTree(base, wsOf) {
  if (!isDir(base)) return;
  let watcher;
  try {
    watcher = fs.watch(base, { recursive: true }, (event, rel) => {
      if (!rel) return;
      rel = String(rel).replace(/\\/g, '/');
      if (/(^|\/)\.|\.swp$|~$/.test(rel)) return; // dotfiles, editor temp files
      const key = base + '|' + rel;
      clearTimeout(debounceTimers.get(key));
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        const full = path.join(base, rel);
        const ws = wsOf(rel);
        // CLI test fixtures create/destroy projects/tl-clitest-* rapidly —
        // hide that churn from the Live feed (and from change/diff heat).
        if (FIXTURE_WS_RE.test(ws.name)) return;
        const payload = {
          ws: ws.name, path: ws.rel, exists: fs.existsSync(full), ts: Date.now(),
        };
        const change = trackChange(ws.name, ws.rel, full, payload.exists);
        if (change) {
          payload.change = { status: change.status, added: change.added, removed: change.removed };
          const d = diffBuffer[diffBuffer.length - 1];
          if (d && d.ws === change.ws && d.path === change.path && d.ts === change.ts) payload.diff = d;
        }
        if (ws.rel.endsWith('.jsonl') && payload.exists) {
          const lines = (safeRead(full) || '').trim().split('\n');
          try { payload.log = { file: path.basename(ws.rel, '.jsonl'), line: JSON.parse(lines[lines.length - 1]) }; }
          catch { payload.log = { file: path.basename(ws.rel, '.jsonl'), line: null }; }
        }
        enqueueOrBroadcast(payload);
      }, 250));
    });
    watcher.on('error', () => {});
  } catch { /* fs.watch recursive unavailable — feed stays quiet */ }
}

watchTree(path.join(ROOT, 'projects'), rel => {
  const ix = rel.indexOf('/');
  return ix < 0 ? { name: rel, rel: '' } : { name: rel.slice(0, ix), rel: rel.slice(ix + 1) };
});
watchTree(path.join(ROOT, 'examples', 'sample-project'), rel => ({ name: 'sample-project', rel }));
primeSnapshots();

// ---------- http ----------

const INDEX = path.join(__dirname, 'index.html');
const LOGO = path.join(ROOT, 'assets', 'logo.png');

// ---------- write guard (same-session token) ----------
// Binding to 127.0.0.1 keeps remote hosts out, but any web page open in the
// local browser can still fire cross-origin POSTs at localhost. So every
// mutating POST must carry a per-process random token: it is minted fresh at
// startup, injected into the HTML served at GET / (window.TL_WRITE_TOKEN),
// never persisted to disk, and required in the x-tl-token header by every
// POST /api/* route uniformly — a foreign page can neither read the token
// (same-origin policy; CORS stays closed) nor forge the header cross-site
// without a preflight the server never approves. Origin/Referer are checked
// as defense-in-depth: browsers stamp Origin on cross-site POSTs, so a
// non-local Origin is refused even with a valid token. This blocks ambient
// browser POSTs from other pages; it does NOT make the server internet-safe.

const WRITE_TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_HEADER = 'x-tl-token';
const TOKEN_SNIPPET = `<script>window.TL_WRITE_TOKEN=${JSON.stringify(WRITE_TOKEN)};</script>`;
const TOKEN_HINT = 'cockpit writes require the per-process write token served with the UI — '
  + `reload the cockpit tab; clients read it from GET / (window.TL_WRITE_TOKEN) and send it in the ${TOKEN_HEADER} header`;

// true when an Origin/Referer value points at this server (localhost-only)
function sameServer(v) {
  try {
    const h = new URL(v);
    if (h.hostname !== 'localhost' && h.hostname !== '127.0.0.1' && h.hostname !== '[::1]') return false;
    return (h.port || (h.protocol === 'https:' ? '443' : '80')) === String(PORT);
  } catch { return false; }
}

// null when the request may write; otherwise the reason for the 403.
// Missing Origin AND Referer is allowed (curl, local scripts) — the token is
// the guard of record; the Origin check only rejects browser-stamped foreign origins.
function writeGuardReject(req) {
  const origin = req.headers.origin;
  if (origin != null && !sameServer(origin)) return 'cross-origin POST refused';
  if (origin == null && req.headers.referer != null && !sameServer(req.headers.referer)) return 'cross-origin POST refused';
  const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
  const want = Buffer.from(WRITE_TOKEN);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'missing or bad write token';
  return null;
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// resolve a workspace-relative path, refusing anything that escapes the workspace
function safePath(ws, rel) { return libSafePath(ws.dir, rel); }

// replace-or-insert status: in a spec's SPEC.md frontmatter
function setSpecStatus(dir, st) {
  const f = path.join(dir, 'SPEC.md');
  const t = safeRead(f);
  if (t == null) return;
  fs.writeFileSync(f, setFrontmatterField(t, 'status', st));
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'note';
}

// classify a free-text capture into a thread type/status (mirrors /tl capture)
function inferThread(text) {
  const t = text.trim();
  if (/\?$/.test(t) || /^(does|can|should|is|are|how|why|what|when|will|could|would)\b/i.test(t)) return { type: 'question', status: 'open' };
  if (/\b(decid|chose|chosen|will use|going with|adopt)\b/i.test(t)) return { type: 'decision', status: 'closed' };
  if (/\b(risk|might break|could fail|may not|unsafe|vulnerab)\b/i.test(t)) return { type: 'risk', status: 'open' };
  if (/\b(clean ?up|refactor|tech debt|tidy)\b/i.test(t)) return { type: 'cleanup', status: 'parked' };
  if (/\b(follow ?up|later|revisit|then)\b/i.test(t)) return { type: 'followup', status: 'parked' };
  return { type: 'idea', status: 'parked' };
}

function isoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      // one gate for the whole write surface — every POST route, current and
      // future, sits behind the same-session token (never per-endpoint checks)
      const reject = writeGuardReject(req);
      if (reject) return json(res, 403, { error: reject, hint: TOKEN_HINT });
      readBody(req).then(body => handlePost(u.pathname, body, res)).catch(() => json(res, 400, { error: 'bad body' }));
      return;
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      const html = safeRead(INDEX);
      // hand the write token to the (same-origin) page — head injection, no template step
      res.end(html === null ? 'index.html missing'
        : html.includes('</head>') ? html.replace('</head>', TOKEN_SNIPPET + '\n</head>')
          : TOKEN_SNIPPET + '\n' + html);
    } else if (u.pathname === '/logo.png') {
      const buf = (() => { try { return fs.readFileSync(LOGO); } catch { return null; } })();
      if (buf) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(buf); }
      else { res.writeHead(404); res.end(); }
    } else if (u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (u.pathname === '/api/changes') {
      json(res, 200, Array.from(changes.values()).sort((a, b) => b.ts - a.ts).slice(0, 120));
    } else if (u.pathname === '/api/diffs') {
      json(res, 200, diffBuffer.slice().reverse().slice(0, 40));
    } else if (u.pathname === '/api/tree') {
      const ws = listWorkspaces().find(w => w.name === u.searchParams.get('ws'));
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      const build = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir).filter(e => !e.startsWith('.') && e !== 'node_modules'); } catch { return []; }
        const dirs = entries.filter(e => isDir(path.join(dir, e))).sort();
        const files = entries.filter(e => !isDir(path.join(dir, e))).sort();
        return [
          ...dirs.map(e => ({ name: e, path: rel + e, dir: true, children: build(path.join(dir, e), rel + e + '/') })),
          ...files.map(e => ({ name: e, path: rel + e, dir: false })),
        ];
      };
      json(res, 200, { name: ws.name, tree: build(ws.dir, '') });
    } else if (u.pathname === '/api/file') {
      const ws = listWorkspaces().find(w => w.name === u.searchParams.get('ws'));
      const rel = u.searchParams.get('path') || '';
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      const full = safePath(ws, rel);
      if (!full) return json(res, 400, { error: 'bad path' });
      const content = safeRead(full);
      if (content === null) return json(res, 404, { error: 'not found' });
      json(res, 200, { path: rel, content });
    } else if (u.pathname === '/api/workspaces') {
      json(res, 200, listWorkspaces().map(w => ({ name: w.name, example: w.example })));
    } else if (u.pathname === '/api/experiments') {
      const ws = listWorkspaces().find(w => w.name === u.searchParams.get('ws'));
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      json(res, 200, readExperiments(ws));
    } else if (u.pathname === '/api/experiment') {
      const ws = listWorkspaces().find(w => w.name === u.searchParams.get('ws'));
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      const id = u.searchParams.get('id') || '';
      // id is a single path segment — guard against traversal into the experiment folder
      if (!id || /[\\/]/.test(id) || id.startsWith('.')) return json(res, 400, { error: 'bad experiment id' });
      if (!safePath(ws, path.join('_experiments', id))) return json(res, 400, { error: 'bad path' });
      const detail = readExperimentDetail(ws, id);
      if (!detail) return json(res, 404, { error: 'experiment not found' });
      json(res, 200, detail);
    } else if (u.pathname === '/api/recall') {
      // read-only recall — same shared helpers as `tl recall` (lib/recall.js):
      // plain text search over the workspace markdown, no index, no embeddings,
      // no mutation. Results come back ranked, capped, and grouped by kind.
      const ws = listWorkspaces().find(w => w.name === u.searchParams.get('ws'));
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      const q = String(u.searchParams.get('q') || '').trim();
      if (!q) return json(res, 400, { error: 'missing query — /api/recall?ws=<name>&q=<query>' });
      json(res, 200, recallSearch(ws.dir, q, { cap: RECALL_CAP }));
    } else if (u.pathname.startsWith('/api/ws/')) {
      const name = decodeURIComponent(u.pathname.slice('/api/ws/'.length));
      const ws = listWorkspaces().find(w => w.name === name);
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      json(res, 200, readWorkspace(ws));
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

// ---------- POST write handlers (one per route) ----------
// Each takes the resolved workspace, the parsed body, and res. Writes stay
// inside the workspace via safePath and mutate frontmatter via lib/frontmatter
// (scoped + sanitized) rather than whole-file string surgery.

function hCapture(ws, body, res) {
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { error: 'empty thought' });
  const inf = inferThread(text);
  const type = body.type || inf.type;
  const status = body.status || inf.status;
  const file = `threads/${isoDate()}-${slugify(text)}.md`;
  const full = safePath(ws, file);
  if (!full) return json(res, 400, { error: 'bad path' });
  if (fs.existsSync(full)) return json(res, 409, { error: 'thread already exists' });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // sanitize every value so a newline / quote / stray `---` in user text can't
  // break the frontmatter open; the heading is the first line of the thought.
  const heading = text.split('\n')[0].trim();
  const fm = `---\ntitle: "${fmValue(text)}"\ncreated: ${isoDate()}\ntype: "${fmValue(type)}"\nstatus: "${fmValue(status)}"\norigin: "${fmValue(body.origin || 'captured in Resume')}"\nlinked_intent: "${fmValue(body.linked_intent || '')}"\nlinked_spec: "${fmValue(body.linked_spec || '')}"\n---\n\n# ${heading}\n`;
  fs.writeFileSync(full, fm);
  return json(res, 200, { ok: true, path: file, type, status });
}

function hGoal(ws, body, res) {
  const full = safePath(ws, 'TRIAGE.yml');
  const alt = safePath(ws, 'triage.yml');
  let yml = readFirst(full, alt);
  const target = fs.existsSync(full) ? full : alt;
  if (yml == null) return json(res, 404, { error: 'no TRIAGE.yml' });
  const oldV = String(body.old ?? ''), newV = String(body.new ?? '');
  // TRIAGE.yml is hand-authored with comments a full parse→serialize round-trip
  // would strip, so edit the exact line — but only when the old value occurs
  // exactly once. Ambiguous or missing => refuse (no silent wrong-goal edit).
  const occ = (hay, needle) => hay.split(needle).length - 1;
  let replaced = false;
  if (body.field === 'description') {
    const needle = `description: "${oldV}"`;
    const n = occ(yml, needle);
    if (n > 1) return json(res, 409, { error: 'ambiguous — description not unique' });
    if (n === 1) { yml = yml.replace(needle, `description: "${fmValue(newV)}"`); replaced = true; }
  } else if (body.field === 'weight') {
    const esc = oldV.replace(/[.]/g, '\\.');
    const all = yml.match(new RegExp(`weight:\\s*${esc}(\\s|$)`, 'gm')) || [];
    if (all.length > 1) return json(res, 409, { error: 'ambiguous — weight not unique' });
    const nw = newV.trim();
    if (!/^-?\d+(\.\d+)?$/.test(nw)) return json(res, 400, { error: 'weight must be a number' });
    const re = new RegExp(`weight:\\s*${esc}(\\s|$)`, 'm');
    if (re.test(yml)) { yml = yml.replace(re, `weight: ${nw}$1`); replaced = true; }
  } else if (body.field === 'kr') {
    const needle = `- "${oldV}"`;
    const n = occ(yml, needle);
    if (n > 1) return json(res, 409, { error: 'ambiguous — key result not unique' });
    if (n === 1) { yml = yml.replace(needle, `- "${fmValue(newV)}"`); replaced = true; }
  }
  if (!replaced) return json(res, 409, { error: 'value not found — may have changed' });
  fs.writeFileSync(target, yml);
  return json(res, 200, { ok: true });
}

function hPriority(ws, body, res) {
  const rel = String(body.spec || '');
  const full = safePath(ws, rel.endsWith('.md') ? rel : rel.replace(/\/$/, '') + '/SPEC.md');
  if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'spec not found' });
  const p = String(body.priority || '').toLowerCase();
  if (!/^p[0-3]$/.test(p)) return json(res, 400, { error: 'bad priority' });
  let text = safeRead(full);
  const fm0 = text.match(/^priority:\s*"?(p[0-3])"?/m);
  const from = fm0 ? fm0[1] : String(body.from || '').toLowerCase();
  text = setFrontmatterField(text, 'priority', p);
  text = setFrontmatterField(text, 'priority_set_by', 'human');
  fs.writeFileSync(full, text);
  // contrast memory: a human override is a 'this, not that' training example
  if (from && from !== p) {
    try {
      const md = path.join(ws.dir, '_metrics');
      fs.mkdirSync(md, { recursive: true });
      fs.appendFileSync(path.join(md, 'override-log.jsonl'),
        JSON.stringify({ date: isoDate(), spec: rel, from, to: p, reason: String(body.reason || ''), source: 'resume-ui' }) + '\n');
    } catch {}
  }
  return json(res, 200, { ok: true, from });
}

function hThreadStatus(ws, body, res) {
  const rel = String(body.path || '');
  if (!/^(threads|intents)\//.test(rel) || !rel.endsWith('.md')) return json(res, 400, { error: 'not a thread or intent' });
  const full = safePath(ws, rel);
  if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'file not found' });
  const st = String(body.status || '');
  if (!['open', 'parked', 'promoted', 'closed', 'draft', 'approved', 'decomposed', 'done'].includes(st)) return json(res, 400, { error: 'bad status' });
  const text = setFrontmatterField(safeRead(full), 'status', st);
  fs.writeFileSync(full, text);
  return json(res, 200, { ok: true });
}

// Move a thread file to another workspace's threads/ — write-then-unlink so
// a failed write never leaves the source gone.
function hThreadMove(ws, body, res) {
  const rel = String(body.path || '');
  if (!/^threads\/.+\.md$/.test(rel)) return json(res, 400, { error: 'not a thread' });
  const srcFull = safePath(ws, rel);
  if (!srcFull || !fs.existsSync(srcFull)) return json(res, 404, { error: 'file not found' });
  const destName = String(body.dest_ws || '').trim();
  if (!destName || destName === ws.name) return json(res, 400, { error: 'bad destination workspace' });
  const destWs = listWorkspaces().find(w => w.name === destName);
  if (!destWs) return json(res, 404, { error: 'unknown destination workspace' });
  const destFull = safePath(destWs, rel);
  if (!destFull) return json(res, 400, { error: 'bad destination path' });
  if (fs.existsSync(destFull)) return json(res, 409, { error: 'thread already exists at destination' });
  const text = safeRead(srcFull);
  if (text == null) return json(res, 500, { error: 'read failed' });
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.writeFileSync(destFull, text);
  try {
    fs.unlinkSync(srcFull);
  } catch (e) {
    // Roll back the destination copy so a failed unlink never leaves a
    // duplicate — the tree returns to its pre-move state (source intact).
    try { fs.unlinkSync(destFull); } catch {}
    return json(res, 500, { error: 'move failed — source not removed: ' + String(e && e.message || e) });
  }
  return json(res, 200, { ok: true, path: rel, from_ws: ws.name, to_ws: destName });
}

function hResearch(ws, body, res) {
  const title = String(body.title || '').trim();
  if (!title) return json(res, 400, { error: 'empty topic' });
  const slug = 'research-' + slugify(title);
  const dir = safePath(ws, 'specs/' + slug);
  if (!dir) return json(res, 400, { error: 'bad path' });
  if (fs.existsSync(dir)) return json(res, 409, { error: 'research spec already exists' });
  fs.mkdirSync(dir, { recursive: true });
  const src = body.source ? String(body.source) : '';
  const heading = title.split('\n')[0].trim();
  const spec = `---
title: "Research: ${fmValue(title)}"
created: ${isoDate()}
project: "${fmValue(ws.name)}"
intent: ""
type: "research"
status: "ready"
priority: ""
priority_set_by: ""
size: "small"
depends_on: []
blocks: []
tags: [research]
origin: "${fmValue(src || 'dispatched from resume')}"
---

# Research: ${heading}

## Objective

Investigate this question and recommend a direction — do not implement. Produce a recommendation the human can decide on.

## Question

${heading}

## Deliverable

- A short recommendation ("this, not that") with the reasoning
- Options considered and why the recommended one wins
- Anything that would change the recommendation
`;
  fs.writeFileSync(path.join(dir, 'SPEC.md'), spec);
  if (src && /^threads\//.test(src)) {
    const tf = safePath(ws, src);
    if (tf && fs.existsSync(tf)) fs.writeFileSync(tf, setFrontmatterField(safeRead(tf), 'status', 'promoted'));
  }
  return json(res, 200, { ok: true, path: 'specs/' + slug + '/' });
}

// ---------- review audit (provenance for the human gate) ----------
// Incident 2026-07-14 (threads/2026-07-14-judge-drain-stage-advance-without-
// verification.md): a cockpit accept left no trace, so a human accept was
// indistinguishable on disk from an agent folder-move — attribution took a
// human interview. Every accept/kick-back now stamps the spec's frontmatter
// and appends one row to _metrics/review-log.jsonl. Recording only: accept
// semantics are unchanged, and historical unstamped accepts stay valid.

// gate status at review time: "verified" when lib/verification-gate's
// canAdvanceToReview passes for the spec as it sits on disk, "unverified"
// when it fails (e.g. ALIGNMENT.md missing under require_independent_verifier).
// A failing gate never blocks the decision — it makes the gap visible.
function reviewGateStatus(ws, specDir) {
  try {
    const spec = parseFrontmatter(safeRead(path.join(specDir, 'SPEC.md')) || '');
    const alignText = safeRead(path.join(specDir, 'outcome', 'ALIGNMENT.md'));
    const alignment = alignText == null ? null : parseFrontmatter(alignText);
    let config = null;
    try {
      const t = readFirst(path.join(ws.dir, 'TRIAGE.yml'), path.join(ws.dir, 'triage.yml'));
      config = t ? parseYaml(t) : null;
    } catch { config = null; }
    return canAdvanceToReview(spec, alignment, config).ok ? 'verified' : 'unverified';
  } catch {
    return 'unverified';
  }
}

// replace-or-insert several frontmatter fields on a spec (reviewer stamp)
function stampSpecFields(dir, fields) {
  const f = path.join(dir, 'SPEC.md');
  let t = safeRead(f);
  if (t == null) return;
  for (const [k, v] of Object.entries(fields)) t = setFrontmatterField(t, k, v);
  fs.writeFileSync(f, t);
}

// append one row to _metrics/review-log.jsonl — append-only, never rewritten
function appendReviewLog(ws, row) {
  const dir = path.join(ws.dir, '_metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'review-log.jsonl'), JSON.stringify(row) + '\n');
}

function hReview(ws, body, res) {
  // the human gate, from the browser: accept an in-review spec to done, or kick it back with a note
  const rel = String(body.spec || '').replace(/\/$/, '');
  const action = String(body.action || '');
  if (!/^in-review\//.test(rel)) return json(res, 400, { error: 'only in-review specs can be reviewed' });
  const slug = rel.split('/').pop();
  const srcDir = safePath(ws, rel);
  if (!srcDir || !isDir(srcDir)) return json(res, 404, { error: 'spec not in review' });
  if (action === 'accept') {
    const dest = safePath(ws, 'done/' + slug); if (!dest) return json(res, 400, { error: 'bad path' });
    const gate = reviewGateStatus(ws, srcDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(srcDir, dest); setSpecStatus(dest, 'done');
    stampSpecFields(dest, { accepted_by: 'human-cockpit', accepted_at: new Date().toISOString(), gate });
    appendReviewLog(ws, {
      date: new Date().toISOString(), spec: rel + '/', action: 'accepted', via: 'cockpit', gate,
    });
    // benchmark-log side effect — never blocks accept (failure-silent)
    try {
      const specText = safeRead(path.join(dest, 'SPEC.md'));
      const feedbackText = safeRead(path.join(dest, 'outcome', 'FEEDBACK.md'));
      const meta = parseFrontmatter(specText || '').meta || {};
      const intentText = meta.intent ? safeRead(path.join(ws.dir, String(meta.intent))) : null;
      appendBenchmarkRecord(ws.dir, buildBenchmarkRecord({
        specText, specSlug: slug, project: ws.name, feedbackText,
        goalIds: intentGoalIds(intentText),
      }));
    } catch { /* never block accept on metrics */ }
    return json(res, 200, { ok: true, path: 'done/' + slug + '/', gate });
  }
  if (action === 'reject') {
    const note = String(body.note || '').trim();
    const dest = safePath(ws, 'in-progress/' + slug); if (!dest) return json(res, 400, { error: 'bad path' });
    const gate = reviewGateStatus(ws, srcDir);
    if (note) fs.appendFileSync(path.join(srcDir, 'NOTES.md'), `\n## ${isoDate()} — kicked back\n${note}\n`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(srcDir, dest); setSpecStatus(dest, 'in-progress');
    stampSpecFields(dest, { kicked_back_by: 'human-cockpit', kicked_back_at: new Date().toISOString(), gate });
    appendReviewLog(ws, {
      date: new Date().toISOString(), spec: rel + '/', action: 'kicked-back', via: 'cockpit', gate,
    });
    // continuation dispatch (contract in _templates/SCHEMA.md): a file trigger so
    // the next `tl run` — or a scheduled headless session — resumes this spec
    // without the human re-assembling context. Still files only, no execution.
    const dispatchFile = safePath(ws, '_dispatch/' + slug + '.json');
    if (dispatchFile) {
      fs.mkdirSync(path.dirname(dispatchFile), { recursive: true });
      fs.writeFileSync(dispatchFile, JSON.stringify({
        spec: slug, mode: 'continuation', stage: 'in-progress',
        notes_path: slug + '/NOTES.md', status: 'pending', created: isoDate(),
        reason: note ? 'kicked back: ' + note.split('\n')[0].slice(0, 140) : 'kicked back',
      }, null, 2) + '\n');
    }
    return json(res, 200, { ok: true, path: 'in-progress/' + slug + '/', gate });
  }
  return json(res, 400, { error: 'action must be accept or reject' });
}

function hRelease(ws, body, res) {
  // the triage gate, from the browser: release a triage spec to the ready queue.
  // symmetric to hReview's accept — moves triage/<slug>/ → specs/<slug>/ and flips status: ready.
  const rel = String(body.spec || '').replace(/\/$/, '');
  if (!/^triage\//.test(rel)) return json(res, 400, { error: 'only triage specs can be released' });
  const slug = rel.split('/').pop();
  const srcDir = safePath(ws, rel);
  if (!srcDir || !isDir(srcDir)) return json(res, 404, { error: 'spec not in triage' });
  const dest = safePath(ws, 'specs/' + slug); if (!dest) return json(res, 400, { error: 'bad path' });
  if (fs.existsSync(dest)) return json(res, 409, { error: 'spec already in ready queue' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(srcDir, dest); setSpecStatus(dest, 'ready');
  return json(res, 200, { ok: true, path: 'specs/' + slug + '/' });
}

function hReclaim(ws, body, res) {
  // Explicit per-spec reclaim of a stalled in-progress claim. One slug, one
  // recorded reason — never a bulk sweep. Eligibility + writes live in
  // lib/stall.js (reclaimStalled); this handler only wires cockpit inputs.
  const rel = String(body.spec || '').replace(/\/$/, '');
  if (!/^in-progress\/[^/]+$/.test(rel)) {
    return json(res, 400, { error: 'only a single in-progress/<slug> claim can be reclaimed' });
  }
  const reason = String(body.reason || '').trim();
  if (!reason) return json(res, 400, { error: 'a non-empty reason is required' });
  const by = String(body.by || 'cockpit').trim() || 'cockpit';
  const slug = rel.split('/').pop();
  let cfg = {};
  try { cfg = parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || '') || {}; } catch { cfg = {}; }
  const thresholdMs = stallThresholdMs(cfg);
  // Continuations need the same shape detectStalledClaims/reclaimStalled expect
  // ({ live: [...] }); readPendingContinuations already returns that list.
  const specs = [
    ...readStage(ws.dir, 'in-progress', 'in-progress'),
    ...readStage(ws.dir, 'tests', 'tests'),
  ];
  const continuations = { live: readPendingContinuations(ws.dir, specs) };
  const result = reclaimStalled(ws.dir, slug, { by, reason, thresholdMs, continuations });
  if (!result.ok) {
    const why = {
      'reason-required': 'a non-empty reason is required',
      'by-required': 'who is reclaiming is required',
      'not-found': 'spec not found in in-progress',
      'active-claim': 'claim shows recent activity — never force-steal live work',
      'awaiting-verifier': 'verifier hand-off, not a stall',
      'continuation-pending': 'a pending continuation owns the resume',
      'blocked': 'spec records a blocker — unblock instead of reclaiming',
      'destination-exists': 'destination folder already exists',
      'no-evidence': 'no dateable activity for the claim',
      'no-slug': 'missing spec slug',
    }[result.reason] || result.reason;
    const code = result.reason === 'not-found' ? 404
      : (result.reason === 'active-claim' || result.reason === 'awaiting-verifier'
        || result.reason === 'continuation-pending' || result.reason === 'blocked'
        || result.reason === 'no-evidence') ? 409
        : 400;
    return json(res, code, { ok: false, error: why, reason: result.reason });
  }
  // Same append-only reclaim audit as `tl reclaim` — NOTES.md already written
  // by reclaimStalled; add a handoff TRACE row that travels with the folder.
  try {
    appendSpecTraceEvent(path.join(ws.dir, result.to), {
      type: 'handoff',
      from_stage: result.from.split('/')[0],
      to_stage: result.to.split('/')[0],
      summary: `reclaimed by ${by} (${result.mode}): ${reason.slice(0, 200)} — prior claim ${result.priorClaimedBy || 'unstamped'}`,
      actor_type: 'human', actor_id: String(by),
      initiation: 'human', source: 'cockpit',
    });
  } catch { /* trace is observability; reclaim already succeeded */ }
  return json(res, 200, {
    ok: true,
    mode: result.mode,
    from: result.from,
    to: result.to,
    slug: result.slug,
    priorClaimedBy: result.priorClaimedBy,
    idleHours: result.idleHours,
    thresholdHours: result.thresholdHours,
  });
}

function hNote(ws, body, res) {
  // leave feedback on any spec, in any stage — appended to its NOTES.md so it travels with the spec.
  // an optional `anchor` ties the note to a section of the spec (inline, PR-review style).
  const rel = String(body.spec || '').replace(/\/$/, '');
  const text = String(body.text || '').trim();
  const anchor = String(body.anchor || '').replace(/\n/g, ' ').trim();
  if (!text) return json(res, 400, { error: 'empty note' });
  const dir = safePath(ws, rel);
  if (!dir || !isDir(dir) || !fs.existsSync(path.join(dir, 'SPEC.md'))) return json(res, 404, { error: 'spec not found' });
  const entry = `\n## ${isoDate()} — note\n` + (anchor ? `> on: ${anchor}\n` : '') + text + '\n';
  fs.appendFileSync(path.join(dir, 'NOTES.md'), entry);
  return json(res, 200, { ok: true });
}

function hVerifyDispatch(ws, body, res) {
  // Queue-only: write verify-request artifact(s). Never spawn agent CLIs.
  const drain = body.drain === true;
  const targetLane = String(body.target_lane || 'any-other').toLowerCase().trim() || 'any-other';
  const lanes = readVerifierLanes(parseYaml(safeRead(path.join(ws.dir, 'TRIAGE.yml')) || '') || {});
  if (!lanes.length) return json(res, 400, { error: 'no verification.verifier_lanes configured' });

  const writeOne = (rel) => {
    const dir = safePath(ws, rel);
    if (!dir || !isDir(dir) || !fs.existsSync(path.join(dir, 'SPEC.md'))) {
      throw Object.assign(new Error('spec not found: ' + rel), { status: 404 });
    }
    const text = safeRead(path.join(dir, 'SPEC.md')) || '';
    const { meta } = parseFrontmatter(text);
    if (meta.awaiting_verifier !== true) {
      throw Object.assign(new Error('spec is not awaiting verifier'), { status: 400 });
    }
    const builder = String(meta.claimed_by || meta.agent || '').toLowerCase();
    if (targetLane !== 'any-other' && targetLane !== 'any' && targetLane === builder) {
      throw Object.assign(new Error('target_lane must differ from claimed_by (builder)'), { status: 400 });
    }
    return writeVerifyRequest(ws.dir, { spec: rel, targetLane, source: 'cockpit' });
  };

  try {
    if (drain) {
      const testsDir = path.join(ws.dir, 'tests');
      const written = [];
      if (isDir(testsDir)) {
        for (const entry of fs.readdirSync(testsDir).sort()) {
          const p = path.join(testsDir, entry);
          if (!isDir(p) || !fs.existsSync(path.join(p, 'SPEC.md'))) continue;
          const { meta } = parseFrontmatter(safeRead(path.join(p, 'SPEC.md')) || '');
          if (meta.awaiting_verifier !== true) continue;
          const builder = String(meta.claimed_by || meta.agent || '').toLowerCase();
          if (targetLane !== 'any-other' && targetLane !== 'any' && targetLane === builder) continue;
          written.push(writeVerifyRequest(ws.dir, {
            spec: 'tests/' + entry + '/', targetLane, source: 'cockpit-drain',
          }));
        }
      }
      return json(res, 200, { ok: true, written: written.map(w => w.path), count: written.length });
    }
    const rel = String(body.spec || '').replace(/\/$/, '');
    if (!/^tests\//.test(rel) && !/^in-progress\//.test(rel)) {
      return json(res, 400, { error: 'Dispatch verify only applies to tests/ (or in-progress) specs' });
    }
    const got = writeOne(rel);
    return json(res, 200, { ok: true, path: got.path, request: got.request });
  } catch (e) {
    return json(res, e.status || 400, { error: e && e.message ? e.message : String(e) });
  }
}

function hVerifyDecision(ws, body, res) {
  // Explicit human choice on a verifier mutation proposal — never auto-applies patches.
  const rel = String(body.spec || '').replace(/\/$/, '');
  const action = String(body.action || '').toLowerCase();
  if (!/^tests\//.test(rel)) return json(res, 400, { error: 'only tests-gate specs accept verify decisions' });
  if (!['authorize-fix-forward', 'kick-back'].includes(action)) {
    return json(res, 400, { error: 'action must be authorize-fix-forward or kick-back' });
  }
  const slug = rel.split('/').pop();
  try {
    const got = applyVerifyHumanDecision(ws.dir, {
      slug, action, note: String(body.note || '').trim(),
    });
    return json(res, 200, { ok: true, ...got });
  } catch (e) {
    return json(res, 400, { error: e && e.message ? e.message : String(e) });
  }
}

// ---------- frontmatter list edits (map repair) ----------
// lib/frontmatter covers single-line scalar fields; the map-repair handler also
// edits small YAML lists (an intent's `specs:` / `goals:`). Same rules apply:
// scoped to the leading frontmatter block, values sanitized to one safe line,
// and the body is never touched. `key` is always a literal from this file.

function hMapRepair(ws, body, res) {
  // heal a throughline break from the Map: attach an orphan spec to an existing
  // intent, create a new goal-carrying intent (optionally linking a spec — or
  // spec-less, for a starving goal), or point a goal-less intent at a TRIAGE.yml
  // goal. Files only — frontmatter edits plus one scaffolded intent from
  // _templates/intent.md; the server never executes.
  const action = String(body.action || '');
  let goalIds = [];
  try {
    const y = parseYaml(readFirst(path.join(ws.dir, 'TRIAGE.yml'), path.join(ws.dir, 'triage.yml')) || '');
    goalIds = ((y && y.goals) || []).map(g => String(g && g.id || '')).filter(Boolean);
  } catch { /* no goals — create/set-goal will refuse below */ }

  // the spec under repair: a folder in a known stage, holding a SPEC.md
  // (optional for create-intent — starving-goal repair creates an intent with no spec)
  const specRel = String(body.spec || '').replace(/\/$/, '');
  const specFile = /^(triage|specs|in-progress|tests|in-review|done)\/[^/]+$/.test(specRel)
    ? safePath(ws, specRel + '/SPEC.md') : null;
  const slug = specRel.split('/').pop();

  const intentRel = String(body.intent || '');
  const intentOk = /^intents\/[^/]+\.md$/.test(intentRel) && !intentRel.includes('..');

  if (action === 'attach') {
    if (!intentOk) return json(res, 400, { error: 'bad intent path' });
    if (!specFile || !fs.existsSync(specFile)) return json(res, 404, { error: 'spec not found' });
    const intentFile = safePath(ws, intentRel);
    if (!intentFile || !fs.existsSync(intentFile)) return json(res, 404, { error: 'intent not found' });
    fs.writeFileSync(specFile, setFrontmatterField(safeRead(specFile), 'intent', intentRel));
    fs.writeFileSync(intentFile, appendToFrontmatterList(safeRead(intentFile), 'specs', 'specs/' + slug + '/'));
    return json(res, 200, { ok: true, intent: intentRel });
  }

  if (action === 'create-intent') {
    const title = String(body.title || '').trim();
    const goal = String(body.goal || '').trim();
    if (!title) return json(res, 400, { error: 'empty title' });
    // the never-write-a-goal-less-intent guard: creating requires a real goal
    if (!goal) return json(res, 400, { error: 'a goal is required — an intent must ladder to one' });
    if (!goalIds.includes(goal)) return json(res, 400, { error: 'unknown goal — pick one from TRIAGE.yml' });
    // spec is optional: orphans pass one; starving-goal create passes none
    if (specRel && (!specFile || !fs.existsSync(specFile))) return json(res, 404, { error: 'spec not found' });
    const rel = `intents/${isoDate()}-${slugify(title)}.md`;
    const full = safePath(ws, rel);
    if (!full) return json(res, 400, { error: 'bad path' });
    if (fs.existsSync(full)) return json(res, 409, { error: 'an intent with this name already exists' });
    // scaffold from the shared template so repaired intents match hand-made ones
    let text = safeRead(path.join(ROOT, '_templates', 'intent.md'))
      || '---\ntitle: ""\ncreated: YYYY-MM-DD\nproject: ""\nstatus: "draft"\ngoals: []\npriority: ""\ntags: []\nspecs: []\n---\n\n# {title}\n';
    text = setFrontmatterField(text, 'title', title);
    text = setFrontmatterField(text, 'created', isoDate());
    text = setFrontmatterField(text, 'project', ws.name);
    text = setFrontmatterField(text, 'status', 'draft');
    text = setFrontmatterList(text, 'goals', [goal]);
    if (specRel) text = appendToFrontmatterList(text, 'specs', 'specs/' + slug + '/');
    else text = setFrontmatterList(text, 'specs', []);
    text = text.replace(/\{title\}/g, title);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    if (specRel) fs.writeFileSync(specFile, setFrontmatterField(safeRead(specFile), 'intent', rel));
    return json(res, 200, { ok: true, path: rel });
  }

  if (action === 'set-goal') {
    const goal = String(body.goal || '').trim();
    if (!intentOk) return json(res, 400, { error: 'bad intent path' });
    if (!goal || !goalIds.includes(goal)) return json(res, 400, { error: 'a goal from TRIAGE.yml is required' });
    const intentFile = safePath(ws, intentRel);
    if (!intentFile || !fs.existsSync(intentFile)) return json(res, 404, { error: 'intent not found' });
    fs.writeFileSync(intentFile, setFrontmatterList(safeRead(intentFile), 'goals', [goal]));
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: 'action must be attach, create-intent, or set-goal' });
}

function hExperimentQueue(ws, body, res) {
  // Queue a fixture/local experiment by writing ONE config file the queue workers pick up.
  // The UI never executes agents or shells out — it only drops a request into _experiments/queue/.
  const spec = String(body.spec || '').replace(/\/$/, '').trim();
  const runtime = String(body.runtime || 'fixture').toLowerCase();
  if (!['fixture', 'local'].includes(runtime)) return json(res, 400, { error: 'runtime must be fixture or local' });
  // local runtime carries the two bridge fields processQueueRequests requires:
  // a runner lane (registered adapter) + the repo candidates run against.
  // Fail fast here with a friendly 400; the bridge re-validates on drain and
  // is the validator of record (malformed files are rewritten "invalid").
  const RUNNERS = ['codex', 'gemini', 'claude', 'cursor', 'shell'];
  let runner = '', repo = '', command = '';
  if (runtime === 'local') {
    runner = String(body.runner || '').trim().toLowerCase();
    if (!RUNNERS.includes(runner)) return json(res, 400, { error: `local runtime requires a runner: ${RUNNERS.join(' | ')}` });
    repo = String(body.repo || '').replace(/[\r\n]+/g, '').trim().slice(0, 300);
    if (!repo) return json(res, 400, { error: 'local runtime requires a repo path — candidates run against an isolated copy of it' });
    command = String(body.command || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    if (runner === 'shell' && !command) return json(res, 400, { error: 'the shell runner requires a command' });
  }
  // candidate roles: one primary, zero or more shadows — sanitized to safe slugs
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const primary = slug(body.primary) || (runtime === 'fixture' ? 'fixture-a' : (runner ? `${runner}-a` : ''));
  if (!primary) return json(res, 400, { error: 'a primary candidate is required' });
  const shadows = (Array.isArray(body.shadows) ? body.shadows : [])
    .map(slug).filter(Boolean).slice(0, 8);
  const judge = slug(body.judge) || (runtime === 'fixture' ? 'fixture-judge' : 'judge');
  // empty string must stay null — +'' is 0, and a 0-minute timeout on a queue
  // row would clamp a local run to a ~1ms spawn timeout (instant timed_out);
  // a zero timeout is equally meaningless, so timeout requires > 0
  const num = (v, min) => (v === '' || v === null || v === undefined || !Number.isFinite(+v) || +v < min) ? null : +v;
  const budgetUsd = num(body.budget_usd, 0);
  const timeoutMin = num(body.timeout_minutes, Number.MIN_VALUE);
  // one config file per request, named by timestamp so concurrent queues don't collide
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rel = `_experiments/queue/${stamp}-${slug(spec) || runtime}.json`;
  const full = safePath(ws, rel);
  if (!full) return json(res, 400, { error: 'bad path' });
  if (fs.existsSync(full)) return json(res, 409, { error: 'a request with this name already exists' });
  // an optional variant/repeat pointer — set when this request re-runs an existing experiment
  const replayOf = String(body.replay_of || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
  // a variant can instill changes: free-text tweaks + per-role model overrides
  const variantNotes = String(body.variant_notes || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  const modelSlug = s => String(s || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
  const models = {};
  if (body.models && typeof body.models === 'object') {
    for (const [role, mdl] of Object.entries(body.models)) {
      const rk = String(role).replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
      const mv = modelSlug(mdl);
      if (rk && mv) models[rk] = mv;
    }
  }
  const config = {
    requested_at: new Date().toISOString(),
    status: 'queued',              // queue workers advance this; the UI only requests
    source: 'ui-dashboard',
    runtime,                       // fixture = deterministic proof; local = a local adapter run
    ...(runtime === 'local' ? { runner, repo } : {}),
    ...(runtime === 'local' && command ? { command } : {}),
    tl_spec: spec,
    primary, shadows, judge,
    budget_usd: budgetUsd,
    timeout_minutes: timeoutMin,
    ...(replayOf ? { replay_of: replayOf } : {}),
    ...(variantNotes ? { variant_notes: variantNotes } : {}),
    ...(Object.keys(models).length ? { models } : {}),
  };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(config, null, 2) + '\n');
  return json(res, 200, { ok: true, path: rel, queued: config });
}

const ROUTES = {
  '/api/capture': hCapture,
  '/api/experiment-queue': hExperimentQueue,
  '/api/goal': hGoal,
  '/api/map-repair': hMapRepair,
  '/api/priority': hPriority,
  '/api/thread-status': hThreadStatus,
  '/api/thread-move': hThreadMove,
  '/api/research': hResearch,
  '/api/review': hReview,
  '/api/release': hRelease,
  '/api/reclaim': hReclaim,
  '/api/note': hNote,
  '/api/verify-dispatch': hVerifyDispatch,
  '/api/verify-decision': hVerifyDecision,
};

function handlePost(pathname, body, res) {
  const ws = listWorkspaces().find(w => w.name === body.ws);
  if (!ws) return json(res, 404, { error: 'unknown workspace' });
  const handler = ROUTES[pathname];
  if (!handler) return json(res, 404, { error: 'unknown endpoint' });
  return handler(ws, body, res);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tl ui → http://localhost:${PORT}  (root: ${ROOT})`);
  if (args.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${cmd} http://localhost:${PORT}`);
  }
});

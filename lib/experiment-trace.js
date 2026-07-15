'use strict';

// Experiment candidate action traces — append-only TRACE.jsonl, secret
// redaction before write, and derived `_metrics/trace-features.jsonl` rows.
//
// Privacy boundary (aligned with the non-experiment activity-trace contract):
//   required  — observable actions (tools, files, tests, commands, status)
//   optional  — deliberate plan/reasoning summaries a runtime reports
//   never     — private chain-of-thought
//
// Node stdlib only; zero dependencies.

const fs = require('node:fs');
const path = require('node:path');

/** Required event types — local runners emit these where possible. */
const REQUIRED_EVENT_TYPES = Object.freeze([
  'start',
  'plan_summary',
  'tool',
  'file_read',
  'file_write',
  'test',
  'command',
  'patch',
  'status',
  'fault',
  'finish',
]);

/** Optional event types — valuable when a runtime reports them; never required for validity. */
const OPTIONAL_EVENT_TYPES = Object.freeze([
  'reasoning_summary',
  'replan',
  'backtrack',
  'human_intervention',
]);

/** Model-resolution sources for Cursor auto / adapter reports. */
const AGENT_MODEL_SOURCES = Object.freeze([
  'sdk',
  'hook',
  'reported',
  'requested',
  'unknown',
  'fixture',
  'none',
]);

// Shared with ui/server.js intent: scrub tokens/keys before anything hits disk.
const SECRET_RE = /(sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|(?:api[_-]?key|secret|token|password|bearer)["'\s:=]+[A-Za-z0-9._\-]{8,})/gi;

// ENV=value pairs and export FOO=... that look like credentials.
const ENV_ASSIGN_RE = /\b(export\s+)?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API)[A-Z0-9_]*)\s*=\s*([^\s"'`;]+)/g;

const TRACE_COMMON_FIELDS = Object.freeze([
  'ts',
  'type',
  'agent_tool',
  'agent_model',
  'agent_model_auto',
  'agent_model_source',
  'source',
  'duration_ms',
  'status',
  'summary',
]);

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function datePart(isoOrDate) {
  if (isoOrDate instanceof Date) return isoOrDate.toISOString().slice(0, 10);
  return String(isoOrDate || new Date().toISOString()).slice(0, 10);
}

/**
 * Redact known secret patterns and credential-looking env assignments.
 * Replaces matches with `[redacted]` (env names kept as `NAME=[redacted]`).
 */
function redact(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  // Env assignments first so `OPENAI_API_KEY=…` keeps the name and is not
  // chewed by the generic `api_key`/`token` secret pattern mid-identifier.
  let s = value.replace(ENV_ASSIGN_RE, (_, exp, name) => `${exp || ''}${name}=[redacted]`);
  s = s.replace(SECRET_RE, '[redacted]');
  return s;
}

function redactDeep(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

/**
 * Cursor auto / model-visibility helper.
 *
 * - requested model displays as `auto` when auto mode is on
 * - resolved model is kept when an SDK/hook/session report exposes it
 * - source is one of sdk | hook | reported | unknown (plus requested/fixture/none)
 */
function resolveModelVisibility(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const tool = src.agent_tool == null || src.agent_tool === '' ? 'unknown' : String(src.agent_tool);
  const requestedRaw = src.agent_model_requested == null || src.agent_model_requested === ''
    ? null
    : String(src.agent_model_requested);
  const requestedLower = requestedRaw ? requestedRaw.toLowerCase() : '';
  const explicitAuto = src.agent_model_auto === true || requestedLower === 'auto';
  // Cursor with no explicit model request ⇒ auto selection.
  const isAuto = explicitAuto || (tool === 'cursor' && !requestedRaw);

  const agent_model_requested = isAuto && (!requestedRaw || requestedLower === 'auto')
    ? 'auto'
    : requestedRaw;

  let resolved = src.agent_model == null || src.agent_model === ''
    ? null
    : String(src.agent_model);
  if (resolved && resolved.toLowerCase() === 'auto') resolved = null;

  let source = src.agent_model_source == null || src.agent_model_source === ''
    ? null
    : String(src.agent_model_source);
  if (!source || !AGENT_MODEL_SOURCES.includes(source)) {
    if (resolved && agent_model_requested && resolved === agent_model_requested && !isAuto) {
      source = 'requested';
    } else if (resolved) {
      source = 'reported';
    } else if (isAuto) {
      source = 'unknown';
    } else if (agent_model_requested) {
      source = 'requested';
    } else {
      source = 'none';
    }
  }

  return {
    agent_tool: tool,
    agent_model_requested,
    agent_model: resolved || (isAuto ? 'unknown' : (agent_model_requested || 'none')),
    agent_model_auto: Boolean(isAuto),
    agent_model_source: source,
  };
}

/**
 * Normalize a partial event into the TRACE.jsonl contract, then redact.
 * Event-specific payload keys ride alongside the common fields.
 */
function normalizeTraceEvent( partial = {}, identity = {}, opts = {}) {
  const id = identity && typeof identity === 'object' ? identity : {};
  const src = partial && typeof partial === 'object' ? partial : {};
  const known = new Set(TRACE_COMMON_FIELDS);
  const payload = {};
  for (const [k, v] of Object.entries(src)) {
    if (!known.has(k)) payload[k] = v;
  }

  const event = {
    ts: src.ts || isoNow(opts.now),
    type: src.type ? String(src.type) : 'status',
    agent_tool: src.agent_tool != null ? String(src.agent_tool) : (id.agent_tool || 'unknown'),
    agent_model: src.agent_model != null ? String(src.agent_model) : (id.agent_model || 'unknown'),
    agent_model_auto: src.agent_model_auto != null ? Boolean(src.agent_model_auto) : Boolean(id.agent_model_auto),
    agent_model_source: src.agent_model_source != null
      ? String(src.agent_model_source)
      : (id.agent_model_source || 'unknown'),
    source: src.source != null ? String(src.source) : (id.source || 'runner'),
    duration_ms: src.duration_ms != null && Number.isFinite(+src.duration_ms) ? +src.duration_ms : null,
    status: src.status != null ? String(src.status) : (opts.defaultStatus || 'running'),
    summary: src.summary != null ? String(src.summary) : '',
    ...payload,
  };
  return redactDeep(event);
}

/**
 * Append one redacted event to TRACE.jsonl. Creates the file/dirs as needed.
 * Returns the normalized event that was written.
 */
function appendTraceEvent(tracePath, partial, identity = {}, opts = {}) {
  const event = normalizeTraceEvent(partial, identity, opts);
  mkdirp(path.dirname(tracePath));
  fs.appendFileSync(tracePath, JSON.stringify(event) + '\n');
  return event;
}

/**
 * Session helper: one candidate's TRACE.jsonl writer.
 * Starts fresh (truncates) so a re-run never appends onto a prior attempt.
 */
function createTraceSession(candidateDir, identity = {}, opts = {}) {
  const tracePath = path.join(candidateDir, 'TRACE.jsonl');
  mkdirp(candidateDir);
  fs.writeFileSync(tracePath, '');
  let currentIdentity = { source: 'runner', ...identity };
  const events = [];

  return {
    path: tracePath,
    identity() { return { ...currentIdentity }; },
    setIdentity(next) {
      currentIdentity = { ...currentIdentity, ...(next || {}) };
      return this;
    },
    events() { return events.slice(); },
    append(partial, appendOpts = {}) {
      const ev = appendTraceEvent(tracePath, partial, currentIdentity, { ...opts, ...appendOpts });
      events.push(ev);
      return ev;
    },
  };
}

function parseTsMs(ts, fallbackMs) {
  if (ts == null) return fallbackMs;
  const ms = Date.parse(String(ts));
  return Number.isFinite(ms) ? ms : fallbackMs;
}

function isScopeViolation(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.scope_violation === true) return true;
  if (ev.payload && ev.payload.scope_violation === true) return true;
  if (ev.type === 'fault' && (ev.fault === 'scope_violation' || ev.code === 'scope_violation')) return true;
  return false;
}

/**
 * Derive learning features from a list of TRACE events (or a TRACE.jsonl path).
 * Does not re-read private reasoning — only observable event types/counts.
 */
function extractTraceFeatures(eventsOrPath, meta = {}) {
  let events = eventsOrPath;
  if (typeof eventsOrPath === 'string') {
    events = readTraceFile(eventsOrPath);
  }
  if (!Array.isArray(events)) events = [];

  const startEv = events.find(e => e && e.type === 'start') || events[0];
  const originMs = parseTsMs(startEv && startEv.ts, meta.startedAtMs != null ? +meta.startedAtMs : Date.now());

  let tool_calls = 0;
  let test_iterations = 0;
  let first_test_at_ms = null;
  let replan_count = 0;
  let backtrack_count = 0;
  let scope_violations = 0;
  let human_intervention_count = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type || '');
    if (type === 'tool') tool_calls += 1;
    if (type === 'test') {
      test_iterations += 1;
      if (first_test_at_ms == null) {
        const at = parseTsMs(ev.ts, null);
        if (at != null) first_test_at_ms = Math.max(0, at - originMs);
      }
    }
    if (type === 'replan') replan_count += 1;
    if (type === 'backtrack') backtrack_count += 1;
    if (type === 'human_intervention') human_intervention_count += 1;
    if (isScopeViolation(ev)) scope_violations += 1;
  }

  return {
    date: meta.date || datePart(meta.now || new Date()),
    experiment_id: meta.experiment_id || '',
    candidate_id: meta.candidate_id || '',
    event_count: events.length,
    tool_calls,
    test_iterations,
    first_test_at_ms,
    replan_count,
    backtrack_count,
    scope_violations,
    human_intervention_count,
  };
}

function readTraceFile(tracePath) {
  try {
    const text = fs.readFileSync(tracePath, 'utf8');
    return text.split('\n').filter(l => l.trim()).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Append one derived features row to `_metrics/trace-features.jsonl`. */
function appendTraceFeatures(workspaceDir, features) {
  const file = path.join(workspaceDir, '_metrics', 'trace-features.jsonl');
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(features) + '\n');
  return file;
}

/** Map thin runner-internal events onto the documented TRACE types. */
function coerceRunnerEvent(ev) {
  if (!ev || typeof ev !== 'object') return { type: 'status', summary: String(ev) };
  const type = String(ev.type || 'status');
  if (type === 'exec') return { ...ev, type: 'command' };
  if (type === 'isolate') return { ...ev, type: 'status' };
  return { ...ev };
}

module.exports = {
  REQUIRED_EVENT_TYPES,
  OPTIONAL_EVENT_TYPES,
  AGENT_MODEL_SOURCES,
  TRACE_COMMON_FIELDS,
  redact,
  redactDeep,
  resolveModelVisibility,
  normalizeTraceEvent,
  appendTraceEvent,
  createTraceSession,
  extractTraceFeatures,
  appendTraceFeatures,
  readTraceFile,
  coerceRunnerEvent,
};

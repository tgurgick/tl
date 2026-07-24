// lib/benchmark-log.js — the benchmark-log.jsonl writer helpers.
//
// The schema shipped in _templates/SCHEMA.md (### `benchmark-log.jsonl`) with
// no writer behind it. This module is that writer's core: claim-time spec
// hashing, record assembly from spec frontmatter + outcome/FEEDBACK.md, and an
// append-only, idempotent JSONL append. Wiring lives elsewhere (bin/tl.js
// claim + CLI accept, ui/server.js cockpit accept) and calls these helpers.
//
// Hash semantics (threads/2026-07-12-benchmark-log-writer-and-spec-hash-capture.md):
//
// - `spec_hash` is SHA-256 hex, FIRST 12 CHARS, of the SPEC.md **body** —
//   frontmatter excluded — captured at CLAIM time (specs/ → in-progress/).
//   Hashing only the body means lifecycle frontmatter mutations (status,
//   claimed_*, awaiting_verifier, reviewer stamps) never change task identity.
// - It is stamped into spec frontmatter (`spec_hash:`) in the same pass as
//   `claimed_by`/`claimed_at`, and the review-time writer only COPIES the
//   stamp into the JSONL line. It never recomputes at review: SPEC.md can
//   legitimately change in flight (a "## Blocked" note, kickback edits), and a
//   review-time hash would break same-task matching across runs.
// - Experiment records (lib/experiment-adapter.js tlSpecToTask) hash the same
//   body with the same SHA-256, stored full-length; this 12-char value is that
//   hash's prefix, so benchmark rows join experiment rows by prefix match.
// - An unstamped spec (claimed before this writer existed) yields
//   `spec_hash: null` — null, never a guessed or retro-computed hash.
//
// Null discipline, per the schema's who-writes-what: a value unknown at write
// time is `null`, never omitted and never a fake zero. Placeholder scores of 0
// (the FEEDBACK template default) are "unscored", not "scored 0" — they become
// null. Malformed FEEDBACK degrades every agent/human field to null; the
// assembled record is always schema-shaped, so the JSONL is never corrupted.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { parseFrontmatter } = require('./parse');
const { setFrontmatterField } = require('./frontmatter');

const BENCHMARK_LOG_FILE = 'benchmark-log.jsonl';
const SPEC_HASH_LENGTH = 12;

// The schema's field order — one key per row of the SCHEMA.md table. Records
// are emitted with exactly these keys, in exactly this order.
const BENCHMARK_FIELDS = Object.freeze([
  'date',
  'spec_slug',
  'spec_hash',
  'spec_type',
  'project',
  'intent',
  'goal_ids',
  'agent_model',
  'agent_tool',
  'duration_minutes',
  'cost_usd',
  'tokens_used',
  'scores',
  'priority_was_right',
  'auto_reviewed',
]);

const AGENT_TOOLS = Object.freeze(['claude-code', 'cursor', 'codex', 'windsurf', 'other']);
const SPEC_TYPES = Object.freeze(['feature', 'bug', 'tech_debt', 'research']);
const SCORE_KEYS = Object.freeze(['correctness', 'completeness', 'scope_discipline']);

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Full SHA-256 hex of a SPEC.md's body (frontmatter excluded) — the exact
// value experiment records store (tlSpecToTask hashes the parsed body the
// same way). Exposed so callers/tests can prove the join.
function specBodyHash(specText) {
  return sha256Hex(parseFrontmatter(specText).body || '');
}

// The benchmark-log `spec_hash`: first 12 hex chars of specBodyHash.
function claimSpecHash(specText) {
  return specBodyHash(specText).slice(0, SPEC_HASH_LENGTH);
}

function isSpecHash(v) {
  return typeof v === 'string' && new RegExp(`^[0-9a-f]{${SPEC_HASH_LENGTH}}$`).test(v);
}

// Stamp `spec_hash` into a spec's frontmatter — the claim-time capture.
//
// Call this in the same frontmatter pass that stamps claimed_by/claimed_at
// (specs/ → in-progress/). Idempotent by default: an existing valid stamp is
// PRESERVED, because the stamp's whole meaning is "the body as it stood at
// claim" and a later re-stamp would silently rewrite task identity mid-flight
// (a kickback returns to in-progress without passing through specs/, so the
// original claim's hash must survive it). A FRESH claim of a spec that went
// back to ready — where the body may legitimately have changed — passes
// { restamp: true } to recompute.
//
// Returns { text, spec_hash, stamped }: `text` is the (possibly) updated SPEC.md
// source, `spec_hash` the effective stamp, `stamped` whether this call wrote it.
// Text with no frontmatter block cannot carry a stamp — returned unchanged with
// stamped: false (the computed hash is still reported for the caller).
function stampClaimSpecHash(specText, opts = {}) {
  const src = String(specText == null ? '' : specText);
  const { meta } = parseFrontmatter(src);
  const existing = meta && meta.spec_hash;
  if (!opts.restamp && isSpecHash(existing)) {
    return { text: src, spec_hash: existing, stamped: false };
  }
  const hash = claimSpecHash(src);
  const stamped = setFrontmatterField(src, 'spec_hash', hash);
  if (stamped === src && !isSpecHash((parseFrontmatter(stamped).meta || {}).spec_hash)) {
    // no frontmatter block to stamp into — report, don't invent one
    return { text: src, spec_hash: hash, stamped: false };
  }
  return { text: stamped, spec_hash: hash, stamped: true };
}

// ---------------------------------------------------------------------------
// Record assembly
// ---------------------------------------------------------------------------

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// A score is an int 1–5. Anything else — absent, 0 placeholders from the
// FEEDBACK template, floats, strings — is "not scored yet": null, never 0.
function scoreValue(v) {
  return Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
}

function boolOrNull(v) {
  return v === true ? true : v === false ? false : null;
}

function enumOrNull(v, allowed) {
  return typeof v === 'string' && allowed.includes(v) ? v : null;
}

function isoDay(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return new Date().toISOString().slice(0, 10);
}

// Pull the goal ids off an intent file's frontmatter (`goals: [...]`).
// Malformed or absent → [] — the schema's "[] if no intent".
function intentGoalIds(intentText) {
  if (intentText == null) return [];
  const goals = (parseFrontmatter(intentText).meta || {}).goals;
  if (!Array.isArray(goals)) return [];
  return goals.filter(g => typeof g === 'string' && g.trim() !== '');
}

// Assemble one benchmark-log record from what already exists on disk.
// Never throws; malformed inputs degrade field-by-field to null.
//
//   specText     SPEC.md source (frontmatter carries spec_hash / type / intent /
//                auto_reviewed). Required in spirit; absent → nulls.
//   specSlug     the spec's folder name (system-known by the caller).
//   project      workspace name (system-known by the caller).
//   feedbackText outcome/FEEDBACK.md source, or null when missing.
//   goalIds      parent intent's goals — pass intentGoalIds(intentText).
//   date         optional YYYY-MM-DD; defaults to today (append day).
function buildBenchmarkRecord(input = {}) {
  let specMeta = {};
  try { specMeta = parseFrontmatter(String(input.specText == null ? '' : input.specText)).meta || {}; }
  catch { specMeta = {}; }

  let fb = {};
  try { fb = parseFrontmatter(String(input.feedbackText == null ? '' : input.feedbackText)).meta || {}; }
  catch { fb = {}; }
  if (fb == null || typeof fb !== 'object' || Array.isArray(fb)) fb = {};

  const rawScores = fb.scores && typeof fb.scores === 'object' && !Array.isArray(fb.scores) ? fb.scores : {};
  const scores = {};
  for (const k of SCORE_KEYS) scores[k] = scoreValue(rawScores[k]);

  const goalIds = Array.isArray(input.goalIds)
    ? input.goalIds.filter(g => typeof g === 'string' && g.trim() !== '')
    : [];

  return {
    date: isoDay(input.date),
    spec_slug: nonEmptyString(input.specSlug) || null,
    // the claim-time stamp is copied, NEVER recomputed here — an unstamped
    // spec is null (honest unknown), not a review-time hash of edited text
    spec_hash: isSpecHash(specMeta.spec_hash) ? specMeta.spec_hash : null,
    spec_type: enumOrNull(specMeta.type, SPEC_TYPES),
    project: nonEmptyString(input.project) || null,
    intent: typeof specMeta.intent === 'string' ? specMeta.intent : '',
    goal_ids: goalIds,
    agent_model: nonEmptyString(fb.agent_model),
    agent_tool: enumOrNull(fb.agent_tool, AGENT_TOOLS),
    duration_minutes: finiteNumber(fb.duration_minutes),
    cost_usd: finiteNumber(fb.cost_usd),
    tokens_used: finiteNumber(fb.tokens_used),
    scores,
    priority_was_right: boolOrNull(fb.priority_was_right),
    auto_reviewed: specMeta.auto_reviewed === true,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Schema check for an assembled record: exactly the schema's keys, each of the
// right shape (null allowed wherever a value can be honestly unknown).
// Returns { ok, errors } — never throws.
function validateBenchmarkRecord(record) {
  const errors = [];
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['record must be an object'] };
  }
  for (const f of BENCHMARK_FIELDS) {
    if (!(f in record)) errors.push(`missing field: ${f}`);
  }
  for (const k of Object.keys(record)) {
    if (!BENCHMARK_FIELDS.includes(k)) errors.push(`unknown field: ${k}`);
  }
  if (errors.length) return { ok: false, errors };

  if (!(typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date))) {
    errors.push('date must be YYYY-MM-DD');
  }
  if (!(typeof record.spec_slug === 'string' && record.spec_slug.trim() !== '')) {
    errors.push('spec_slug must be a non-empty string');
  }
  if (!(record.spec_hash === null || isSpecHash(record.spec_hash))) {
    errors.push(`spec_hash must be ${SPEC_HASH_LENGTH} lowercase hex chars or null`);
  }
  if (!(record.spec_type === null || SPEC_TYPES.includes(record.spec_type))) {
    errors.push(`spec_type must be one of ${SPEC_TYPES.join('|')} or null`);
  }
  if (!(record.project === null || typeof record.project === 'string')) {
    errors.push('project must be a string or null');
  }
  if (typeof record.intent !== 'string') {
    errors.push('intent must be a string ("" when none)');
  }
  if (!(Array.isArray(record.goal_ids) && record.goal_ids.every(g => typeof g === 'string'))) {
    errors.push('goal_ids must be a list of strings ([] when no intent)');
  }
  if (!(record.agent_model === null || typeof record.agent_model === 'string')) {
    errors.push('agent_model must be a string or null');
  }
  if (!(record.agent_tool === null || AGENT_TOOLS.includes(record.agent_tool))) {
    errors.push(`agent_tool must be one of ${AGENT_TOOLS.join('|')} or null`);
  }
  for (const f of ['duration_minutes', 'cost_usd', 'tokens_used']) {
    if (!(record[f] === null || (typeof record[f] === 'number' && Number.isFinite(record[f])))) {
      errors.push(`${f} must be a finite number or null`);
    }
  }
  const sc = record.scores;
  if (sc == null || typeof sc !== 'object' || Array.isArray(sc)) {
    errors.push('scores must be an object');
  } else {
    for (const k of SCORE_KEYS) {
      if (!(k in sc)) errors.push(`scores.${k} missing`);
      else if (!(sc[k] === null || (Number.isInteger(sc[k]) && sc[k] >= 1 && sc[k] <= 5))) {
        errors.push(`scores.${k} must be an int 1-5 or null (0 placeholders are null, never 0)`);
      }
    }
    for (const k of Object.keys(sc)) {
      if (!SCORE_KEYS.includes(k)) errors.push(`scores has unknown key: ${k}`);
    }
  }
  if (!(record.priority_was_right === null || typeof record.priority_was_right === 'boolean')) {
    errors.push('priority_was_right must be a boolean or null');
  }
  if (typeof record.auto_reviewed !== 'boolean') {
    errors.push('auto_reviewed must be a boolean');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Append (append-only, idempotent)
// ---------------------------------------------------------------------------

function benchmarkLogPath(wsDir) {
  return path.join(wsDir, '_metrics', BENCHMARK_LOG_FILE);
}

// Read every parseable record from the workspace's benchmark log. Unparseable
// lines are skipped (never repaired, never removed — corrections are new
// lines); an absent file is [].
function readBenchmarkRecords(wsDir) {
  let text = null;
  try { text = fs.readFileSync(benchmarkLogPath(wsDir), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip, never rewrite */ }
  }
  return out;
}

// Two records describe the same acceptance when every field except `date`
// matches — `date` is when the line was appended, not part of the measurement.
// This is what makes a repeat accept (double click, re-run of the accept path)
// idempotent while a genuine re-run of the same task (kickback → rebuild →
// re-accept, with new cost/scores) still appends its own line.
function sameMeasurement(a, b) {
  for (const f of BENCHMARK_FIELDS) {
    if (f === 'date') continue;
    if (JSON.stringify(a && a[f]) !== JSON.stringify(b && b[f])) return false;
  }
  return true;
}

// Append one record to <ws>/_metrics/benchmark-log.jsonl.
//
// - Validates first: an invalid record is refused ({ ok: false, errors }) —
//   a malformed line never reaches the file.
// - Idempotent: if an existing line is the same measurement (all fields but
//   `date` equal), nothing is appended ({ ok: true, appended: false }).
// - Append-only: existing lines are never read-modified-written, only a new
//   line is appended.
function appendBenchmarkRecord(wsDir, record) {
  const check = validateBenchmarkRecord(record);
  if (!check.ok) return { ok: false, appended: false, errors: check.errors };
  const file = benchmarkLogPath(wsDir);
  const existing = readBenchmarkRecords(wsDir);
  if (existing.some(r => sameMeasurement(r, record))) {
    return { ok: true, appended: false, reason: 'duplicate', file };
  }
  const ordered = {};
  for (const f of BENCHMARK_FIELDS) ordered[f] = record[f];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(ordered) + '\n');
  return { ok: true, appended: true, file };
}

module.exports = {
  BENCHMARK_LOG_FILE,
  BENCHMARK_FIELDS,
  AGENT_TOOLS,
  SPEC_TYPES,
  SCORE_KEYS,
  SPEC_HASH_LENGTH,
  specBodyHash,
  claimSpecHash,
  isSpecHash,
  stampClaimSpecHash,
  intentGoalIds,
  buildBenchmarkRecord,
  validateBenchmarkRecord,
  benchmarkLogPath,
  readBenchmarkRecords,
  appendBenchmarkRecord,
};

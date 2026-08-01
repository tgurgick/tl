// lib/reflect-desk.js — pending reflect proposals for the Human/Resume desk.
//
// /tl reflect writes _metrics/reflect-{date}.md and appends reflect-log.jsonl.
// This module answers: which proposals are still *unhandled* for the desk?
//
// Clear rule (post-marker): a proposal leaves the desk only when
// `_metrics/reflect-review-log.jsonl` records an explicit human action
// (`reviewed` | `dismissed` | `applied`). Viewing the markdown alone never
// writes that log. Pre-marker proposals (no review row yet) still degrade via
// the 14-day freshness window so the desk cannot accumulate forever.
//
// Pure discovery over the parsed workspace payload (UMD). The append writer is
// Node-only (cockpit / CLI) — attached after the factory so the browser copy
// stays fs-free. Keep ui/index.html's inlined factory in lockstep.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ReflectDesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HANDLED_ACTIONS = Object.freeze(['reviewed', 'dismissed', 'applied']);
const HANDLED = new Set(HANDLED_ACTIONS);

/** Parse a reflect-log date (YYYY-MM-DD) to a UTC timestamp, or null. */
function dateTs(d) {
  const s = String(d || '').trim();
  if (!DATE_RE.test(s)) return null;
  const ts = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Stable proposal id from the artifact/log record.
 * Shape: `reflect-YYYY-MM-DD` — one proposal file per calendar day.
 */
function proposalIdFromRecord({ date, path, proposal_id } = {}) {
  const explicit = String(proposal_id || '').trim();
  if (/^reflect-\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const d = String(date || '').trim();
  if (DATE_RE.test(d)) return 'reflect-' + d;
  const m = String(path || '').match(/reflect-(\d{4}-\d{2}-\d{2})/);
  return m ? 'reflect-' + m[1] : null;
}

function proposalDateFromId(id) {
  const m = String(id || '').match(/^reflect-(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

/** Normalize user input (`reflect-2026-07-12` or `2026-07-12`) to a proposal id. */
function normalizeProposalId(input) {
  const s = String(input || '').trim();
  if (/^reflect-\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (DATE_RE.test(s)) return 'reflect-' + s;
  const m = s.match(/reflect-(\d{4}-\d{2}-\d{2})/);
  return m ? 'reflect-' + m[1] : null;
}

/**
 * Last review-log line per proposal_id (append-only: last wins).
 * @returns {Map<string, object>}
 */
function latestReviewsById(metrics = {}) {
  const log = Array.isArray(metrics['reflect-review-log']) ? metrics['reflect-review-log'] : [];
  const map = new Map();
  for (const line of log) {
    if (!line || typeof line !== 'object') continue;
    const id = proposalIdFromRecord(line);
    if (!id) continue;
    const action = String(line.action || '').toLowerCase();
    if (!HANDLED.has(action)) continue;
    map.set(id, line);
  }
  return map;
}

/**
 * Pending (unhandled) reflect proposals from the workspace's parsed metrics.
 *
 * @param {object} opts
 * @param {object} opts.metrics   parsed _metrics jsonl map (from /api/ws payload)
 * @param {object[]} opts.specs   workspace specs (for accepted_at on done/)
 * @param {number} opts.now       clock override for tests
 * @param {number} opts.windowDays  legacy freshness for unmarked proposals (default 14)
 * @returns {{ proposals: object[], acceptsSinceLatest: number }}
 */
function pendingReflectProposals({ metrics = {}, specs = [], now = Date.now(), windowDays = 14 } = {}) {
  const log = Array.isArray(metrics['reflect-log']) ? metrics['reflect-log'] : [];
  const byDate = new Map();
  for (const line of log) {
    if (!line || typeof line !== 'object') continue;
    const ts = dateTs(line.date);
    if (ts == null) continue;
    byDate.set(String(line.date).trim(), { line, ts });
  }

  const reviews = latestReviewsById(metrics);
  const windowMs = windowDays * DAY;
  const proposals = [];
  for (const [date, { line, ts }] of byDate) {
    if (!(Number(line.proposals) > 0)) continue;
    const id = proposalIdFromRecord({ date });
    if (!id) continue;
    const review = reviews.get(id);
    if (review) continue; // explicit human marker clears — age irrelevant
    // Legacy / unmarked: degrade via the freshness window.
    if (now - ts > windowMs) continue;
    proposals.push({
      id,
      date,
      ts,
      path: '_metrics/reflect-' + date + '.md',
      proposals: Number(line.proposals) || 0,
      parallelTracks: Number(line.parallel_tracks) || 0,
      overridesRead: Number(line.overrides_read) || 0,
      outcomesRead: Number(line.outcomes_read) || 0,
      reviewStatus: 'unread',
    });
  }
  proposals.sort((a, b) => b.ts - a.ts);

  return {
    proposals,
    acceptsSinceLatest: proposals.length
      ? countAcceptsAfter({ metrics, specs, cutoff: proposals[0].ts + DAY })
      : 0,
  };
}

function countAcceptsAfter({ metrics = {}, specs = [], cutoff = 0 } = {}) {
  let fromLog = 0;
  const reviewLog = Array.isArray(metrics['review-log']) ? metrics['review-log'] : [];
  for (const line of reviewLog) {
    if (!line || line.action !== 'accepted') continue;
    const ts = Date.parse(String(line.date || ''));
    if (Number.isFinite(ts) && ts >= cutoff) fromLog++;
  }
  let fromSpecs = 0;
  for (const s of specs || []) {
    if (!s || s.stage !== 'done') continue;
    const ts = Date.parse(String((s.meta && s.meta.accepted_at) || ''));
    if (Number.isFinite(ts) && ts >= cutoff) fromSpecs++;
  }
  return Math.max(fromLog, fromSpecs);
}

return {
  pendingReflectProposals,
  countAcceptsAfter,
  proposalIdFromRecord,
  normalizeProposalId,
  proposalDateFromId,
  latestReviewsById,
  HANDLED_ACTIONS,
  DAY,
};
});

// ---------- Node-only append writer (cockpit + CLI) ----------
if (typeof module === 'object' && module.exports && typeof require === 'function') {
  const fs = require('fs');
  const path = require('path');
  const desk = module.exports;
  const LOG_FILE = 'reflect-review-log.jsonl';

  /**
   * Append one human decision for a reflect proposal. Never rewrites history.
   * Viewing alone must not call this.
   */
  function recordReflectProposalDecision(wsDir, {
    proposalId, action, actor = 'human-cli', via = 'cli', note = '', now = new Date(),
  } = {}) {
    const id = desk.normalizeProposalId(proposalId);
    if (!id) {
      const err = new Error('proposal id required — use reflect-YYYY-MM-DD or YYYY-MM-DD');
      err.code = 'bad-proposal-id';
      throw err;
    }
    const act = String(action || '').toLowerCase();
    if (!desk.HANDLED_ACTIONS.includes(act)) {
      const err = new Error('action must be reviewed, dismissed, or applied');
      err.code = 'bad-action';
      throw err;
    }
    const proposalDate = desk.proposalDateFromId(id);
    const when = now instanceof Date ? now : new Date(now);
    const row = {
      date: when.toISOString(),
      proposal_id: id,
      proposal_date: proposalDate,
      path: '_metrics/reflect-' + proposalDate + '.md',
      action: act,
      actor: String(actor || 'human').trim() || 'human',
      via: via === 'cockpit' ? 'cockpit' : 'cli',
    };
    const n = String(note || '').trim();
    if (n) row.note = n;

    const dir = path.join(wsDir, '_metrics');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_FILE);
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    return { ok: true, row, path: '_metrics/' + LOG_FILE };
  }

  desk.recordReflectProposalDecision = recordReflectProposalDecision;
  desk.REFLECT_REVIEW_LOG = LOG_FILE;
  module.exports = desk;
}

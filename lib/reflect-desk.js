// lib/reflect-desk.js — pending reflect proposals for the Human/Resume desk.
//
// /tl reflect writes _metrics/reflect-{date}.md (the proposal) and appends one
// line to _metrics/reflect-log.jsonl ({date, overrides_read, outcomes_read,
// proposals, parallel_tracks}). This module reads that already-written evidence
// — via the parsed workspace payload, no fs — and answers one question for the
// desk: which proposals are still fresh enough to surface after an accept?
//
// Pure functions only. Discovery rules:
//   - a log line counts only when it carries a parseable date and proposals > 0
//     (reflect ran but proposed nothing → stays silent, per the skill)
//   - append-only log: the LAST line for a date wins
//   - "recent" = within `windowDays` (default 14 — reflect's weekly-ish cadence)
//   - newest first; each entry carries the workspace-relative proposal path
// Surfacing is read-only by design — nothing here (or in the desk block that
// renders it) applies TRIAGE.yml changes; that stays human-owned via /tl reflect.
//
// UMD: CommonJS for tests/CLI; `globalThis.ReflectDesk` for the cockpit
// (ui/index.html inlines the same factory — keep both copies in lockstep).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ReflectDesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a reflect-log date (YYYY-MM-DD) to a UTC timestamp, or null. */
function dateTs(d) {
  const s = String(d || '').trim();
  if (!DATE_RE.test(s)) return null;
  const ts = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Pending reflect proposals from the workspace's parsed metrics.
 *
 * @param {object} opts
 * @param {object} opts.metrics   parsed _metrics jsonl map (from /api/ws payload)
 * @param {object[]} opts.specs   workspace specs (for accepted_at on done/)
 * @param {number} opts.now       clock override for tests
 * @param {number} opts.windowDays  freshness window (default 14)
 * @returns {{ proposals: object[], acceptsSinceLatest: number }}
 *   proposals: newest first — { date, ts, path, proposals, parallelTracks,
 *   overridesRead, outcomesRead }. Empty array → the desk renders nothing.
 *   acceptsSinceLatest: accepts to done/ strictly after the newest proposal's
 *   day — evidence the loop has new outcome data the proposal hasn't seen.
 */
function pendingReflectProposals({ metrics = {}, specs = [], now = Date.now(), windowDays = 14 } = {}) {
  const log = Array.isArray(metrics['reflect-log']) ? metrics['reflect-log'] : [];
  const byDate = new Map(); // date -> entry (last line for a date wins, even a zero-proposal rerun)
  for (const line of log) {
    if (!line || typeof line !== 'object') continue;
    const ts = dateTs(line.date);
    if (ts == null) continue;
    byDate.set(String(line.date).trim(), { line, ts });
  }

  const windowMs = windowDays * DAY;
  const proposals = [];
  for (const [date, { line, ts }] of byDate) {
    if (!(Number(line.proposals) > 0)) continue; // ran, proposed nothing → silent
    if (now - ts > windowMs) continue; // stale — the moment has passed
    proposals.push({
      date,
      ts,
      path: '_metrics/reflect-' + date + '.md',
      proposals: Number(line.proposals) || 0,
      parallelTracks: Number(line.parallel_tracks) || 0,
      overridesRead: Number(line.overrides_read) || 0,
      outcomesRead: Number(line.outcomes_read) || 0,
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

/**
 * Count accepts to done/ at-or-after `cutoff`. Two views of the same events —
 * _metrics/review-log.jsonl rows (action: "accepted") and done specs' stamped
 * accepted_at — so take the max, never the sum.
 */
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

return { pendingReflectProposals, countAcceptsAfter, DAY };
});

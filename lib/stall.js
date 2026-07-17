// lib/stall.js — stalled in-progress claim detection + guarded reclaim.
//
// The failure mode (threads/2026-07-14-stalled-in-progress-needs-reclaim-or-
// idle-nudge.md): a claim succeeds, the session dies mid-flight (host restart,
// cursor crash), and the spec sits in in-progress/ with complete-or-partial
// work and no FEEDBACK or stage advance — silently parking queue capacity.
// Write-discipline fixed *clobber*; this fixes *abandonment*.
//
// Detection rule (evidence over guessing terminal sessions): a claim is
// STALLED when the newest mtime across the spec folder's files (SPEC.md,
// NOTES.md, VERIFY.md, outcome/*, context/*) — floored by `claimed_at` — is
// older than a configurable idle threshold (default 24h; hours, not minutes,
// so a slow-but-alive agent is never flagged). Three healthy states are never
// stalled, whatever their age:
//   - `awaiting_verifier: true` — a completed verifier hand-off; that queue
//     belongs to `tl verify`, not reclaim.
//   - a pending continuation dispatch for the spec — kickback resume owns it.
//   - `status: blocked` — a recorded human-facing blocker, surfaced by
//     resume/up already; reclaiming it would erase the reason.
//
// Reclaim semantics (explicit, logged, never a sweep):
//   - `release` — no builder artifacts (no outcome/FEEDBACK.md): the folder
//     returns to specs/ with `status: ready`; `claimed_by`/`claimed_at` are
//     cleared ONLY after the prior claim is recorded in a NOTES.md reclaim
//     entry. Attribution is never stripped silently — the reclaim-attribution
//     lesson (threads/2026-07-14-reclaimed-spec-feedback-misattributes-
//     builder.md: a cursor pass advanced a stalled claude build and the
//     FEEDBACK credited cursor).
//   - `advance` — builder artifacts already prove the work (outcome/
//     FEEDBACK.md present): the folder advances to tests/ for independent
//     verification instead of throwing the build away. `claimed_by` is
//     PRESERVED — it names the agent that produced the work product, not the
//     agent that advanced the folders — and a VERIFY.md hand-off is written
//     if the builder didn't get that far.
//   - never force-steal: a claim with fresh activity refuses to reclaim, no
//     override flag exists, and a missing reason is a hard error (stamps
//     change only with a recorded reason).
//
// Node stdlib only. Pure assessment is separated from fs so tests can drive
// the rule directly.

'use strict';

const fs = require('fs');
const path = require('path');
const { safeRead, isDir, mtime } = require('./workspace');
const { setFrontmatterField } = require('./frontmatter');
const { specSlug } = require('./batch');
const { parseFrontmatter } = require('./parse');

const HOUR = 3600000;
const DEFAULT_STALL_HOURS = 24;

// Threshold from the workspace's parsed TRIAGE.yml: `stall: { idle_hours: N }`.
// Floored at 1 hour — the contract is "hours, not minutes", so a config typo
// (0, 0.1, negative, junk) can never turn detection into a live-work stealer.
function stallThresholdMs(triageConfig) {
  const s = triageConfig && typeof triageConfig === 'object' ? triageConfig.stall : null;
  const n = s ? Number(s.idle_hours) : NaN;
  const hours = Number.isFinite(n) && n >= 1 ? n : DEFAULT_STALL_HOURS;
  return hours * HOUR;
}

// Newest mtime across the files that evidence live work in a spec folder:
// SPEC.md and NOTES.md at the top plus everything one level under outcome/,
// context/, and any other subfolder. A shallow recursive walk (depth-capped)
// — spec folders are small by construction.
function latestActivityMs(specDir, depth = 2) {
  let latest = 0;
  const visit = (dir, d) => {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const p = path.join(dir, e);
      if (isDir(p)) { if (d > 0) visit(p, d - 1); continue; }
      const m = mtime(p);
      if (m > latest) latest = m;
    }
  };
  visit(specDir, depth);
  return latest;
}

// Parse a `claimed_at` date ("YYYY-MM-DD") to ms; 0 when absent/unparseable.
function claimedAtMs(meta) {
  const raw = meta && meta.claimed_at;
  if (!raw) return 0;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? t : 0;
}

// Pure stall assessment for one spec shape (as read by the CLI/UI inventory:
// { stage, path, meta }). `activityMs` is the folder's latest activity;
// `pendingContinuationSlugs` is a Set of slugs with a pending _dispatch
// continuation. Returns { stalled, reason, idleMs, lastSeenMs }.
function assessClaim(spec, { now = Date.now(), thresholdMs = DEFAULT_STALL_HOURS * HOUR, activityMs = 0, pendingContinuationSlugs = null } = {}) {
  const meta = (spec && spec.meta) || {};
  const res = (stalled, reason, lastSeenMs) => ({
    stalled, reason,
    lastSeenMs: lastSeenMs || 0,
    idleMs: lastSeenMs ? Math.max(0, now - lastSeenMs) : 0,
  });
  if (!spec || spec.stage !== 'in-progress') return res(false, 'not-in-progress', activityMs);
  const lastSeen = Math.max(activityMs || 0, claimedAtMs(meta));
  if (meta.awaiting_verifier === true || String(meta.awaiting_verifier).toLowerCase() === 'true') {
    return res(false, 'awaiting-verifier', lastSeen);
  }
  if (String(meta.status || '').toLowerCase() === 'blocked') {
    return res(false, 'blocked', lastSeen);
  }
  if (pendingContinuationSlugs && pendingContinuationSlugs.has(specSlug(spec.path))) {
    return res(false, 'continuation-pending', lastSeen);
  }
  if (!lastSeen) return res(false, 'no-evidence', 0); // nothing to date the claim by — never guess stalled
  if (now - lastSeen > thresholdMs) return res(true, 'idle-past-threshold', lastSeen);
  return res(false, 'active', lastSeen);
}

// fs-aware sweep over an inventory of specs: assess every in-progress claim
// and return the stalled ones, oldest first. Detection only — no writes.
function detectStalledClaims(wsDir, specs, { now = Date.now(), thresholdMs, continuations = null } = {}) {
  const pending = new Set(
    ((continuations && continuations.live) || []).map(c => specSlug(c.spec ? c.spec.path : ''))
  );
  const out = [];
  for (const s of specs || []) {
    if (s.stage !== 'in-progress' || !s.dir) continue;
    const activityMs = latestActivityMs(s.dir);
    const a = assessClaim(s, { now, thresholdMs, activityMs, pendingContinuationSlugs: pending });
    if (a.stalled) out.push({ spec: s, slug: specSlug(s.path), ...a, idleHours: Math.round(a.idleMs / HOUR) });
  }
  return out.sort((x, y) => y.idleMs - x.idleMs);
}

// Remove whole frontmatter lines for `keys`, scoped to the leading `--- … ---`
// block (same discipline as setFrontmatterField — the body is never touched).
// Local on purpose: lib/frontmatter.js has no delete primitive and is owned by
// a concurrent pass right now.
function stripFrontmatterFields(text, keys) {
  const src = String(text);
  const m = src.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
  if (!m) return src;
  const drop = new RegExp('^(' + keys.join('|') + '):');
  const block = m[2].split('\n').filter(l => !drop.test(l)).join('\n');
  return m[1] + block + m[3] + src.slice(m[0].length);
}

function isoNow(now) { return new Date(now).toISOString(); }

// The auditable reclaim record, appended to the spec's NOTES.md before any
// frontmatter change or folder move. This is what makes attribution-clearing
// non-silent: the prior claim survives here even when the release path wipes
// the claim fields for re-queueing.
function reclaimNote({ now, mode, by, reason, priorClaimedBy, priorClaimedAt, idleHours, thresholdHours, dest }) {
  return [
    '',
    `## Reclaimed ${isoNow(now)}`,
    '',
    `- prior claim: ${priorClaimedBy || '(none recorded)'}${priorClaimedAt ? ` (claimed_at ${priorClaimedAt})` : ''} — idle ~${idleHours}h, threshold ${thresholdHours}h`,
    `- action: ${mode === 'advance'
      ? `advanced to ${dest} — builder artifacts (outcome/FEEDBACK.md) already present; claimed_by preserved as builder attribution`
      : `released to ${dest} — status: ready, claim fields cleared (prior claim recorded above)`}`,
    `- by: ${by}`,
    `- reason: ${reason}`,
    `- attribution rule: any FEEDBACK/benchmark record for work built before this reclaim must credit ${priorClaimedBy || 'the original (unknown) builder — use null, never the reclaimer'} (threads/2026-07-14-reclaimed-spec-feedback-misattributes-builder.md)`,
    '',
  ].join('\n');
}

// Minimal VERIFY.md for the advance path when the stalled builder never wrote
// one — the verifier hand-off contract (_templates/SCHEMA.md) needs it for
// `tl verify` to list the spec. Builder = the ORIGINAL claim, by design.
function verifyRequestText({ slug, builder, now, by, reason }) {
  const day = isoNow(now).slice(0, 10);
  return [
    '---',
    'awaiting_verifier: true',
    `builder: ${builder || 'unknown'}`,
    `requested_at: ${day}`,
    '---',
    '',
    `# Verification request — ${slug}`,
    '',
    `Builder: **${builder || 'unknown'}** (original stalled claim — must be verified by a different agent).`,
    '',
    `Advanced to tests/ by a reclaim (${by}, ${day}) because builder artifacts (outcome/FEEDBACK.md) were already present when the claim stalled: ${reason}`,
    '',
    'Check the work against SPEC.md acceptance criteria; the reclaimer did not re-run or alter the build.',
    '',
  ].join('\n');
}

// Reclaim one stalled in-progress claim. Explicit (one slug), guarded, logged.
// All writes land before the folder move; the move is last.
// Returns { ok, mode?, from?, to?, reason?, ... } — refusals are data, not throws.
function reclaimStalled(wsDir, slug, { by, reason, now = Date.now(), thresholdMs = DEFAULT_STALL_HOURS * HOUR, continuations = null } = {}) {
  slug = specSlug(String(slug || ''));
  if (!slug) return { ok: false, reason: 'no-slug' };
  if (!reason || !String(reason).trim()) return { ok: false, reason: 'reason-required' };
  if (!by || !String(by).trim()) return { ok: false, reason: 'by-required' };

  const fromDir = path.join(wsDir, 'in-progress', slug);
  const specFile = path.join(fromDir, 'SPEC.md');
  const text = safeRead(specFile);
  if (text === null) return { ok: false, reason: 'not-found', dir: fromDir };

  // Re-assess at write time — never act on a stale snapshot of staleness.
  const meta = parseFrontmatter(text).meta;
  const spec = { stage: 'in-progress', path: 'in-progress/' + slug + '/', meta };
  const pending = new Set(((continuations && continuations.live) || []).map(c => specSlug(c.spec ? c.spec.path : '')));
  const a = assessClaim(spec, { now, thresholdMs, activityMs: latestActivityMs(fromDir), pendingContinuationSlugs: pending });
  if (!a.stalled) {
    // 'active' covers the fresh-claimed_at case — never force-steal live work.
    return { ok: false, reason: a.reason === 'active' ? 'active-claim' : a.reason, idleMs: a.idleMs };
  }

  const feedback = safeRead(path.join(fromDir, 'outcome', 'FEEDBACK.md'))
    || safeRead(path.join(fromDir, 'outcome', 'feedback.md'));
  const mode = feedback && feedback.trim() ? 'advance' : 'release';
  const destStage = mode === 'advance' ? 'tests' : 'specs';
  const toDir = path.join(wsDir, destStage, slug);
  if (fs.existsSync(toDir)) return { ok: false, reason: 'destination-exists', dir: toDir };

  const idleHours = Math.round(a.idleMs / HOUR);
  const thresholdHours = Math.round(thresholdMs / HOUR);
  const note = reclaimNote({
    now, mode, by, reason,
    priorClaimedBy: meta.claimed_by || null,
    priorClaimedAt: meta.claimed_at || null,
    idleHours, thresholdHours,
    dest: destStage + '/' + slug + '/',
  });

  // ---- writes, in order, all before the move ----
  const notesFile = path.join(fromDir, 'NOTES.md');
  const existingNotes = safeRead(notesFile);
  fs.writeFileSync(notesFile, (existingNotes ? existingNotes.replace(/\n*$/, '\n') : '# NOTES — ' + slug + '\n') + note);

  let updated = text;
  if (mode === 'release') {
    updated = setFrontmatterField(updated, 'status', 'ready'); // also strips hold_reason per the release contract
    updated = setFrontmatterField(updated, 'reclaimed_from', (meta.claimed_by || 'unknown') + (meta.claimed_at ? ' @ ' + meta.claimed_at : ''));
    updated = setFrontmatterField(updated, 'reclaimed_at', isoNow(now).slice(0, 10));
    updated = stripFrontmatterFields(updated, ['claimed_by', 'claimed_at']);
  } else {
    updated = setFrontmatterField(updated, 'status', 'tests');
    updated = setFrontmatterField(updated, 'awaiting_verifier', 'true');
    if (!meta.requested_at) updated = setFrontmatterField(updated, 'requested_at', isoNow(now).slice(0, 10));
    // claimed_by / claimed_at untouched — builder attribution.
  }
  fs.writeFileSync(specFile, updated);

  if (mode === 'advance' && safeRead(path.join(fromDir, 'VERIFY.md')) === null) {
    fs.writeFileSync(path.join(fromDir, 'VERIFY.md'),
      verifyRequestText({ slug, builder: meta.claimed_by || meta.agent || null, now, by, reason }));
  }

  // ---- the move, last ----
  fs.mkdirSync(path.dirname(toDir), { recursive: true }); // stage folder may not exist yet
  fs.renameSync(fromDir, toDir);

  return {
    ok: true, mode, slug,
    from: 'in-progress/' + slug + '/',
    to: destStage + '/' + slug + '/',
    priorClaimedBy: meta.claimed_by || null,
    idleHours, thresholdHours,
  };
}

module.exports = {
  DEFAULT_STALL_HOURS,
  stallThresholdMs,
  latestActivityMs,
  assessClaim,
  detectStalledClaims,
  reclaimStalled,
  stripFrontmatterFields,
};

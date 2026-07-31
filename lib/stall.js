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

// ---------- prepared-handoff recovery (committed HANDOFF.json, dead builder) ----------
//
// The other half of the abandonment story. Reclaim (above) handles claims that
// stalled BEFORE a handoff existed — release or advance on artifact evidence.
// Recovery handles the narrower, later failure: the builder ran the full
// finalize order (checks → outcome artifacts → terminal HANDOFF.json) and died
// between committing the manifest and completing the guarded move. The
// manifest is the completion proof (lib/handoff.js), the builder lease is the
// liveness proof (lib/worker.js), so recovery never guesses from artifact
// smells (replacing the inference sketch in docs/canonical-e2e-path.md):
//
//   eligible   valid v1 manifest for in-progress → tests, spec observed in
//              in-progress/ only, builder lease EXPIRED.
//   refused    live lease (never steal a live builder — typed, with holder),
//              partial writes (HANDOFF.json.tmp / incomplete artifacts),
//              invalid manifest (malformed, changed bytes, identity/stage
//              mismatch), no manifest at all (FEEDBACK.md alone is NEVER
//              completion — that's reclaim's advance path, not recovery's).
//   grace      legacy no-lease work (built before builder leases existed) is
//              recoverable only via the explicit, documented path: the caller
//              passes allowNoLease AND the folder is idle past the stall
//              threshold. A valid committed manifest is still required.
//
// Recovery DELEGATES to lib/worker.js finalizeBuilderHandoff under the
// manifest's own identity (actor = manifest.builder, runId = manifest.run_id):
// the committed manifest is reused byte-identically — never re-prepared — the
// move goes through the stage CAS, and the expired lease is taken over and
// released by the same contract a builder retry would use. Attribution is the
// point: the original builder stays the builder (claimed_by, manifest,
// FEEDBACK all untouched); the RECOVERER is recorded separately, in a NOTES.md
// entry and a `recovery` TRACE.jsonl event (actor/reason/run_id correlation).
// Explicit, one spec at a time, never a sweep — reclaim discipline.

// The frontmatter fields finalize stamps immediately before reusing/creating
// the manifest, in stampSpecFrontmatter's exact order. Recovery may only
// delegate when re-applying them is byte-stable — the canonical finalize order
// stamps BEFORE the manifest binds SPEC.md bytes, so a committed manifest that
// binds unstamped bytes came from outside that order, and delegating would
// invalidate it (the one thing recovery must never do).
function finalizeStampsAreByteStable(specText, meta, now) {
  const requestedAt = String((meta && meta.requested_at) || '').trim() || isoNow(now).slice(0, 10);
  let stamped = String(specText);
  stamped = setFrontmatterField(stamped, 'status', 'tests');
  stamped = setFrontmatterField(stamped, 'awaiting_verifier', true);
  stamped = setFrontmatterField(stamped, 'requested_at', requestedAt);
  return stamped === String(specText);
}

// Typed disposition for one spec's recovery eligibility. Read-only. States:
//   'recoverable'  valid manifest, expired lease — recovery can finish it.
//   'no-lease'     valid manifest, no lease on record — legacy grace only.
//   'active'       live builder lease — hands off, with holder details.
//   'partial'      interrupted write / incomplete artifacts — not a handoff.
//   'no-manifest'  no terminal manifest (including legacy FEEDBACK+diff).
//   'invalid'      manifest present but refused (changed bytes, mismatch, …).
//   'finalized'    already completed in tests/ with a valid manifest.
//   'conflict'     duplicate board (in-progress/ AND another stage) — repair.
//   'not-found'    nothing recovery recognizes at this slug.
function classifyRecovery(wsDir, slug, { now = Date.now() } = {}) {
  slug = specSlug(String(slug || ''));
  const { observedStages } = require('./stage');
  const { validateHandoff, classifyHandoff } = require('./handoff');
  const { builderLeaseState } = require('./worker');

  if (!slug) return { state: 'not-found', slug: null, reason: 'no-slug' };
  const observed = observedStages(wsDir, slug);
  const base = { slug, observed_stages: observed };

  if (!observed.length) return { state: 'not-found', ...base };
  if (observed.includes('in-progress') && observed.length > 1) {
    return { state: 'conflict', reason: 'destination-exists', ...base };
  }
  if (!observed.includes('in-progress')) {
    if (observed.length === 1 && observed[0] === 'tests') {
      const v = validateHandoff({
        specDir: path.join(wsDir, 'tests', slug),
        expected_from_stage: 'in-progress', expected_to_stage: 'tests',
      });
      if (v.ok) return { state: 'finalized', builder: v.builder, run_id: v.run_id, ...base };
    }
    return {
      state: 'not-found',
      detail: 'not in in-progress/ and not a finalized handoff in tests/',
      ...base,
    };
  }

  const specDir = path.join(wsDir, 'in-progress', slug);
  const cls = classifyHandoff(specDir);
  if (cls.kind === 'partial') return { state: 'partial', reason: cls.reason, detail: cls.detail, ...base };
  if (cls.kind === 'legacy') {
    return {
      state: 'no-manifest', reason: 'legacy-artifacts',
      detail: 'FEEDBACK.md/BUILDER.diff without a terminal HANDOFF.json is never treated as completion — tl reclaim (advance) owns pre-manifest work',
      ...base,
    };
  }
  if (cls.kind === 'absent') {
    return {
      state: 'no-manifest', reason: 'no-handoff',
      detail: 'no builder handoff artifacts — plain stalls belong to tl reclaim',
      ...base,
    };
  }
  if (cls.kind !== 'v1') {
    return { state: 'invalid', reason: cls.reason, details: cls.details || null, ...base };
  }

  const manifest = cls.manifest;
  if (manifest.from_stage !== 'in-progress' || manifest.to_stage !== 'tests') {
    return {
      state: 'invalid', reason: 'stage-mismatch',
      from_stage: manifest.from_stage, to_stage: manifest.to_stage,
      detail: 'recovery only finishes the in-progress → tests builder edge',
      ...base,
    };
  }

  const specText = safeRead(path.join(specDir, 'SPEC.md'));
  const meta = parseFrontmatter(specText || '').meta || {};
  if (!finalizeStampsAreByteStable(specText, meta, now)) {
    return {
      state: 'invalid', reason: 'unstamped-spec',
      detail: 'the manifest binds SPEC.md bytes that predate the finalize stamps — delegating would invalidate the committed manifest; inspect by hand',
      ...base,
    };
  }

  const common = {
    builder: String(manifest.builder),
    run_id: String(manifest.run_id),
    prepared_at: String(manifest.prepared_at || ''),
    manifest,
    ...base,
  };
  const lease = builderLeaseState(wsDir, slug, now);
  if (lease.state === 'live') {
    const l = lease.lease;
    return {
      state: 'active', reason: 'live-lease',
      malformed_lease: !!lease.malformed,
      holder: l ? {
        actor: l.actor == null ? null : String(l.actor),
        run_id: l.run_id == null ? null : String(l.run_id),
        stage: l.stage == null ? null : String(l.stage),
        expires_at: l.expires_at == null ? null : String(l.expires_at),
      } : null,
      ...common,
    };
  }

  const lastSeenMs = Math.max(latestActivityMs(specDir), claimedAtMs(meta));
  const idleMs = lastSeenMs ? Math.max(0, now - lastSeenMs) : 0;
  if (lease.state === 'none') {
    return { state: 'no-lease', idleMs, lastSeenMs, ...common };
  }
  return { state: 'recoverable', lease: lease.lease, idleMs, lastSeenMs, ...common };
}

// The auditable recovery record — same posture as reclaimNote, written AFTER
// the move (NOTES.md is not manifest-bound; the manifest and every bound byte
// stay untouched). Skipped when a manifest explicitly declares NOTES.md.
function recoveryNote({ now, by, reason, builder, runId, mode }) {
  return [
    '',
    `## Recovered ${isoNow(now)}`,
    '',
    `- committed handoff finished by recovery (${mode}): ${mode === 'no-lease-grace'
      ? 'valid terminal HANDOFF.json, no builder lease on record (legacy grace — explicit flag, idle past threshold)'
      : 'valid terminal HANDOFF.json, builder lease expired'}`,
    `- builder: ${builder} (run ${runId}) — attribution unchanged; recovery moved folders, it built nothing`,
    `- recovered by: ${by}`,
    `- reason: ${reason}`,
    '',
  ].join('\n');
}

// Recover ONE committed handoff. Explicit (one slug), guarded, logged, never a
// sweep. Refusals are data, not throws. Idempotent: an already-finalized spec
// returns ok with `already_finalized: true`; concurrent racers lose with typed
// refusals from the lease CAS / stage CAS (`lease-lost`, `stale-stage`,
// `destination-exists`) and nothing is forced.
function recoverPreparedHandoff(wsDir, slug, {
  by, reason, now = Date.now(),
  thresholdMs = DEFAULT_STALL_HOURS * HOUR,
  allowNoLease = false,
  actorType = 'human', initiation = 'human', source = 'cli',
} = {}) {
  slug = specSlug(String(slug || ''));
  if (!slug) return { ok: false, reason: 'no-slug' };
  if (!reason || !String(reason).trim()) return { ok: false, reason: 'reason-required' };
  if (!by || !String(by).trim()) return { ok: false, reason: 'by-required' };

  // Classify at act time — never act on a stale snapshot.
  const c = classifyRecovery(wsDir, slug, { now });
  if (c.state === 'finalized') {
    return {
      ok: true, already_finalized: true, slug,
      to: 'tests/' + slug + '/', builder: c.builder, run_id: c.run_id,
      recovered_by: String(by),
    };
  }
  if (c.state !== 'recoverable' && c.state !== 'no-lease') {
    const reasonMap = {
      'not-found': 'not-found',
      conflict: 'destination-exists',
      partial: 'partial-handoff',
      'no-manifest': 'no-manifest',
      invalid: 'invalid-manifest',
      active: 'live-lease',
    };
    return {
      ok: false, reason: reasonMap[c.state] || c.state, state: c.state,
      cause: c.reason || null, detail: c.detail || null,
      ...(c.state === 'active' ? {
        holder: c.holder || null, malformed_lease: !!c.malformed_lease,
        detail: 'a live builder lease holds this spec — recovery never steals live work; wait for expiry or let the builder finalize',
      } : {}),
      ...(c.observed_stages ? { observed_stages: c.observed_stages } : {}),
    };
  }

  let mode = 'lease-expired';
  if (c.state === 'no-lease') {
    if (allowNoLease !== true) {
      return {
        ok: false, reason: 'no-lease', state: c.state,
        detail: 'no builder lease on record (legacy pre-lease work). The grace path is explicit and conservative: pass allowNoLease AND the folder must be idle past the stall threshold. A valid committed HANDOFF.json is still required — FEEDBACK.md alone is never completion.',
      };
    }
    if (!c.idleMs || c.idleMs <= thresholdMs) {
      return {
        ok: false, reason: 'recent-activity', state: c.state,
        idleMs: c.idleMs || 0, thresholdMs,
        detail: 'legacy grace requires idleness past the stall threshold — fresh activity means a builder may be alive without a lease',
      };
    }
    mode = 'no-lease-grace';
  }

  const { sha256Hex } = require('./handoff');
  const manifestFile = path.join(wsDir, 'in-progress', slug, 'outcome', 'HANDOFF.json');
  let beforeSha = null;
  try { beforeSha = sha256Hex(fs.readFileSync(manifestFile)); } catch { /* validated above; races surface below */ }

  // Delegate to the ONE finalize path under the manifest's own identity: the
  // valid committed manifest is reused byte-identically, the stamps are
  // byte-stable re-writes, the move is the stage CAS, and the expired lease is
  // taken over exactly as a builder retry would. Extra declared artifacts ride
  // along for the existence preflight (dedup'd downstream).
  const REQUIRED = ['SPEC.md', 'outcome/FEEDBACK.md', 'outcome/BUILDER.diff'];
  const { finalizeBuilderHandoff, appendSpecTraceEvent } = require('./worker');
  const res = finalizeBuilderHandoff({
    wsDir, slug,
    actor: c.builder, runId: c.run_id,
    baseCommit: String(c.manifest.base_commit),
    tests: c.manifest.tests,
    artifacts: c.manifest.artifacts.map(a => a.path).filter(p => !REQUIRED.includes(p)),
    initiation, source: 'recovery',
    reuseOnly: true, // never re-prepare under recovery — refuse before stamp/overwrite/move
    now: new Date(now),
  });
  if (!res.ok) {
    return {
      ok: false, reason: res.reason, state: 'refused', finalize: res,
      detail: res.detail || null, cause: res.cause || null,
      ...(res.reason === 'manifest-invalidated' ? {
        moved: false,
        detail: res.detail || 'artifact bytes drifted between classification and finalize — reuse_only refused before stamp, overwrite, or move',
      } : {}),
    };
  }
  if (res.already_finalized) {
    // A concurrent recoverer/retry completed the move between classify and
    // finalize — idempotent success, nothing of ours to log as a move.
    return {
      ok: true, already_finalized: true, slug,
      to: 'tests/' + slug + '/', builder: c.builder,
      run_id: String(res.run_id || c.run_id), recovered_by: String(by),
      lease_released: !!res.lease_released,
    };
  }

  const toDir = path.join(wsDir, 'tests', slug);
  let afterSha = null;
  try { afterSha = sha256Hex(fs.readFileSync(path.join(toDir, 'outcome', 'HANDOFF.json'))); } catch { /* reported below */ }
  if (res.reused_manifest !== true) {
    // Unreachable under reuseOnly: finalize either reuses or refuses before move.
    // Kept as a defensive invariant breach if a future caller drops the flag.
    return {
      ok: false, reason: 'invariant-breach', state: 'refused', moved: true,
      to: 'tests/' + slug + '/',
      detail: 'finalize succeeded without reused_manifest under recovery — inspect tests/' + slug + '/ provenance by hand',
      finalize: res,
    };
  }

  // Recovery provenance — after the move, never touching manifest-bound bytes.
  // NOTES.md entry (unless the manifest binds NOTES.md) + a `recovery` trace
  // event carrying recoverer, reason, and the manifest's run_id correlation.
  const declared = new Set(c.manifest.artifacts.map(a => a.path));
  if (!declared.has('NOTES.md')) {
    const notesFile = path.join(toDir, 'NOTES.md');
    const existing = safeRead(notesFile);
    fs.writeFileSync(notesFile,
      (existing ? existing.replace(/\n*$/, '\n') : '# NOTES — ' + slug + '\n')
      + recoveryNote({ now, by, reason, builder: c.builder, runId: c.run_id, mode }));
  }
  appendSpecTraceEvent(toDir, {
    type: 'recovery', from_stage: 'in-progress', to_stage: 'tests',
    summary: `prepared handoff recovered (${mode}) by ${by}: ${String(reason).slice(0, 200)} — builder ${c.builder} stays the builder; recovery only completed the committed move`,
    paths: ['tests/' + slug + '/'],
    actor_type: actorType, actor_id: String(by),
    initiation, source,
    run_id: c.run_id,
    recovered_by: String(by), recovery_mode: mode,
  }, { now: new Date(now) });

  return {
    ok: true, slug, mode,
    from: 'in-progress/' + slug + '/', to: 'tests/' + slug + '/',
    builder: c.builder, run_id: String(res.run_id || c.run_id),
    recovered_by: String(by), reason: String(reason),
    already_finalized: false,
    reused_manifest: true,
    byte_identical: beforeSha !== null && beforeSha === afterSha,
    manifest_sha256: afterSha,
    requested_at: res.requested_at || null,
    lease_released: !!res.lease_released,
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
  classifyRecovery,
  recoverPreparedHandoff,
};

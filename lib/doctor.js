'use strict';
// lib/doctor.js — shared read-only lifecycle integrity + verifier capacity
// classifier for tl up, resume, automation status, and the cockpit.
//
// Composes existing primitives (handoff/stall/stage/verification-gate/worker
// lane validation). Never spawns agents, never recovers, never mutates, never
// acquires leases, and never claims OS sandbox guarantees — PATH/`which` and
// env presence are observation only.

const fs = require('node:fs');
const path = require('node:path');

const { parseFrontmatter } = require('./parse');
const { STAGES, observedStages } = require('./stage');
const { classifyHandoff } = require('./handoff');
const { classifyRecovery } = require('./stall');
const { canAdvanceToReview } = require('./verification-gate');
const {
  readWorkspaceSpecs,
  readVerifierLanes,
  validateVerifierLane,
  builderLeaseState,
  builderOf,
  isAwaitingVerifier,
} = require('./worker');
const { verifierLeaseState, countHeldLeases } = require('./verifier-worker');
const { LANE_ENV_ALLOWLIST } = require('./env-policy');

const STAGE_DIRS = [...STAGES];

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listSlugs(wsDir) {
  const seen = new Set();
  for (const stage of STAGE_DIRS) {
    const dir = path.join(wsDir, stage);
    if (!isDir(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      if (isDir(path.join(dir, name))) seen.add(name);
    }
  }
  return [...seen].sort();
}

function authPresent(agent, env) {
  const keys = LANE_ENV_ALLOWLIST[String(agent || '').toLowerCase()] || [];
  if (!keys.length) return { present: true, keys: [] }; // unknown agent: no env gate
  const hit = keys.filter(k => env[k] != null && String(env[k]).trim() !== '');
  return { present: hit.length > 0, keys, hit };
}

function finding(kind, fields) {
  return { kind, ...fields };
}

// Scan the workspace for lifecycle integrity findings. Pure observation.
function classifyLifecycle(wsDir, { now = Date.now(), specs = null, cfg = null } = {}) {
  const findings = [];
  const allSpecs = specs || (() => {
    try { return readWorkspaceSpecs(wsDir); } catch { return []; }
  })();
  const optsCfg = cfg;

  for (const slug of listSlugs(wsDir)) {
    const observed = observedStages(wsDir, slug);
    if (observed.length > 1) {
      findings.push(finding('duplicate-stage', {
        slug,
        observed_stages: observed,
        detail: `spec observed in ${observed.join(' AND ')}`,
        fix: 'repair the duplicate board (keep one stage folder) before claiming or recovering',
      }));
    }

    // Handoff / lease / recovery classification on in-progress and tests.
    for (const stage of ['in-progress', 'tests']) {
      if (!observed.includes(stage)) continue;
      const specDir = path.join(wsDir, stage, slug);
      const cls = classifyHandoff(specDir);
      if (cls.kind === 'partial') {
        findings.push(finding('uncommitted-handoff', {
          slug, stage, detail: cls.detail || cls.reason || 'partial handoff write',
          fix: 'finish or discard the torn write; recovery never treats partial files as completion',
        }));
      } else if (cls.kind === 'invalid') {
        findings.push(finding('invalid-handoff', {
          slug, stage, detail: cls.detail || cls.reason || 'manifest refused',
          fix: 'inspect outcome/HANDOFF.json and bound artifacts; changed bytes refuse recovery',
        }));
      } else if (cls.kind === 'legacy') {
        findings.push(finding('legacy-state', {
          slug, stage,
          detail: 'FEEDBACK.md/BUILDER.diff without a terminal HANDOFF.json',
          fix: 'tl reclaim (advance) owns pre-manifest work — never treat FEEDBACK alone as completion',
        }));
      }

      if (stage === 'in-progress') {
        const lease = builderLeaseState(wsDir, slug, now);
        if (lease.state === 'expired') {
          findings.push(finding('expired-builder-lease', {
            slug, stage,
            detail: `builder lease expired${lease.lease && lease.lease.actor ? ` (holder ${lease.lease.actor})` : ''}`,
            fix: classifyRecovery(wsDir, slug, { now }).state === 'recoverable'
              ? `tl recover <ws> ${slug} --by <you> --reason "<why>"`
              : 'inspect lease + handoff; reclaim or recover explicitly — never a sweep',
          }));
        }
      }
    }

    // Verifier lease on tests/
    if (observed.includes('tests')) {
      const vLease = verifierLeaseState({ wsDir, slug, nowMs: now });
      if (vLease.state === 'stale') {
        findings.push(finding('expired-verifier-lease', {
          slug, stage: 'tests',
          detail: `verifier lease stale${vLease.holder ? ` (holder ${vLease.holder})` : ''}`,
          fix: 're-run tl verify — stale verifier leases are reclaimable by the next eligible lane',
        }));
      }
    }

    // Invalid in-review gate: missing FEEDBACK or failing canAdvanceToReview.
    if (observed.includes('in-review')) {
      const specDir = path.join(wsDir, 'in-review', slug);
      const feedback = path.join(specDir, 'outcome', 'FEEDBACK.md');
      if (!fs.existsSync(feedback)) {
        findings.push(finding('invalid-in-review', {
          slug, stage: 'in-review',
          detail: 'in-review/ without outcome/FEEDBACK.md',
          fix: 'kick back to in-progress or restore FEEDBACK.md before accepting',
        }));
      } else {
        const specMeta = parseFrontmatter(safeRead(path.join(specDir, 'SPEC.md')) || '');
        const alignRaw = safeRead(path.join(specDir, 'outcome', 'ALIGNMENT.md'));
        const alignment = alignRaw ? parseFrontmatter(alignRaw) : null;
        const gate = canAdvanceToReview(
          { meta: (specMeta && specMeta.meta) || {} },
          alignment,
          optsCfg,
        );
        if (gate && gate.ok === false) {
          findings.push(finding('invalid-in-review', {
            slug, stage: 'in-review',
            detail: gate.reason || 'verification gate refused',
            fix: 'resolve ALIGNMENT/verification gate before accept',
          }));
        }
      }
    }
  }

  // Legacy awaiting_verifier without a valid handoff in tests/
  for (const s of allSpecs) {
    if (s.stage !== 'tests') continue;
    if (!isAwaitingVerifier(s)) continue;
    const slug = String(s.path || '').split('/').pop();
    const cls = classifyHandoff(path.join(wsDir, 'tests', slug));
    if (cls.kind === 'legacy' || cls.kind === 'absent') {
      const already = findings.some(f => f.slug === slug && f.kind === 'legacy-state');
      if (!already) {
        findings.push(finding('legacy-state', {
          slug, stage: 'tests',
          detail: 'awaiting_verifier without a terminal HANDOFF.json (legacy gate)',
          fix: 'prefer manifest handoffs; verifier queue still accepts legacy awaiting but integrity is weaker',
        }));
      }
    }
  }

  const counts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1;
  return {
    findings,
    summary: { counts, ok: findings.length === 0, total: findings.length },
  };
}

function verifyLockHolders(wsDir) {
  const holders = new Set();
  const dir = path.join(wsDir, '_metrics', 'verify-locks');
  if (!isDir(dir)) return holders;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.lock')) continue;
    try {
      const row = JSON.parse(safeRead(path.join(dir, file)) || '{}');
      if (row.verifier) holders.add(String(row.verifier).toLowerCase());
    } catch { /* ignore */ }
  }
  return holders;
}

// Classify each configured verifier lane into the AC vocabulary.
function classifyVerifierCapacity(wsDir, {
  cfg,
  which = () => '',
  env = process.env,
  specs = null,
  now = Date.now(),
} = {}) {
  const lanes = readVerifierLanes(cfg || {});
  const allSpecs = specs || (() => {
    try { return readWorkspaceSpecs(wsDir); } catch { return []; }
  })();
  const awaiting = allSpecs.filter(s =>
    (s.stage === 'tests' || s.stage === 'in-progress') && isAwaitingVerifier(s));
  const lockHolders = verifyLockHolders(wsDir);
  let heldLeases = 0;
  try { heldLeases = countHeldLeases(wsDir, { nowMs: now }) || 0; } catch { heldLeases = 0; }

  if (!lanes.length) {
    return {
      verifier_lanes: [{
        id: null, agent: null,
        state: 'absent', ok: false,
        reason: 'no verification.verifier_lanes configured',
        fix: 'add verification.verifier_lanes in TRIAGE.yml (see _templates/SCHEMA.md)',
      }],
      summary: { available: [], blocked: ['absent'], ok: false },
    };
  }

  const rows = lanes.map(lane => {
    const id = lane.id || lane.agent;
    const agent = String(lane.agent || '').toLowerCase();

    // unsafe
    try { validateVerifierLane(lane); }
    catch (e) {
      return {
        id, agent, state: 'unsafe', ok: false,
        reason: String(e && e.message ? e.message : e),
        fix: 'see _templates/SCHEMA.md (verification.verifier_lanes) and docs/headless-lanes.md',
      };
    }

    // unreachable (PATH)
    const bin = (lane.command && lane.command[0])
      || (agent === 'gemini' ? 'agy' : null);
    if (bin && typeof which === 'function' && !which(bin)) {
      return {
        id, agent, state: 'unreachable', ok: false,
        reason: `verifier binary unavailable: ${bin}`,
        fix: `install ${bin} on PATH (or set lanes.${id}.command[0] to the real binary)`,
      };
    }

    // auth-failed (env presence only — no network probe)
    const auth = authPresent(agent, env || {});
    if (!auth.present) {
      return {
        id, agent, state: 'auth-failed', ok: false,
        reason: `no auth env for ${agent} (looked for ${auth.keys.join(', ') || 'lane allowlist'})`,
        fix: `export one of: ${auth.keys.join(', ')}`,
      };
    }

    // builder-only: every awaiting spec was built by this same agent
    if (awaiting.length) {
      const blocked = awaiting.filter(s => String(builderOf(s) || '').toLowerCase() === agent);
      if (blocked.length === awaiting.length) {
        return {
          id, agent, state: 'builder-only', ok: false,
          reason: `all ${awaiting.length} awaiting-verifier spec(s) were built by ${agent} — independent verifier required`,
          fix: 'configure a different verifier lane, or wait for a non-builder agent',
          builder_exclusion: { blocked_slugs: blocked.map(s => String(s.path || '').split('/').pop()) },
        };
      }
    }

    // busy: verify lock held by this lane, or live verifier leases
    const busyLock = lockHolders.has(String(id).toLowerCase()) || lockHolders.has(agent);
    if (busyLock || heldLeases > 0 && lockHolders.size === 0 && awaiting.length) {
      // Prefer explicit lock; otherwise report busy only when this lane holds a lock.
    }
    if (busyLock) {
      return {
        id, agent, state: 'busy', ok: false,
        reason: 'verify lock held for this lane',
        fix: 'wait for the in-flight verify tick to finish, or inspect _metrics/verify-locks/',
        lease: { held: heldLeases },
      };
    }

    return {
      id, agent, state: 'available', ok: true,
      reason: 'eligible independent verifier lane',
      fix: null,
      lease: { held: heldLeases },
    };
  });

  const available = rows.filter(r => r.ok).map(r => r.id || r.agent);
  const blocked = rows.filter(r => !r.ok).map(r => r.state);
  return {
    verifier_lanes: rows,
    summary: { available, blocked, ok: available.length > 0 },
  };
}

function diagnoseWorkspace(wsDir, opts = {}) {
  const cfg = opts.cfg || {};
  const now = opts.now != null ? opts.now : Date.now();
  let specs = opts.specs;
  if (!specs) {
    try { specs = readWorkspaceSpecs(wsDir); } catch { specs = []; }
  }

  const lifecycle = classifyLifecycle(wsDir, { now, specs, cfg });
  const capacity = classifyVerifierCapacity(wsDir, {
    cfg, which: opts.which, env: opts.env || process.env, specs, now,
  });

  const awaiting_verifier = specs
    .filter(s => (s.stage === 'tests' || s.stage === 'in-progress') && isAwaitingVerifier(s))
    .map(s => ({
      path: s.path,
      builder: builderOf(s) || null,
      title: s.title || null,
    }));

  const stuck_at_tests = specs.filter(s =>
    s.stage === 'tests'
    && (isAwaitingVerifier(s) || String((s.meta && s.meta.status) || '').toLowerCase() === 'blocked')).length;

  return {
    lifecycle,
    capacity,
    stuck_at_tests,
    awaiting_verifier,
    ok: lifecycle.summary.ok && capacity.summary.ok,
  };
}

function formatLifecycleFindings(findings) {
  if (!findings || !findings.length) return ['(no lifecycle integrity findings)'];
  return findings.map(f =>
    `- ${f.kind}: ${f.slug || '?'}${f.stage ? ' @ ' + f.stage : ''} — ${f.detail || ''}`
      + (f.fix ? ` · fix: ${f.fix}` : ''));
}

function formatCapacityRows(rows) {
  if (!rows || !rows.length) return ['(no verifier lanes)'];
  return rows.map(r => {
    const name = String(r.id || r.agent || '(absent)').padEnd(12);
    const state = String(r.state || '?').padEnd(14);
    return `${name} ${state} ${r.ok ? r.reason : (r.reason || '')}${r.fix && !r.ok ? ` · fix: ${r.fix}` : ''}`;
  });
}

// Open-loop lines for resume / resume-recommended consumers.
function healthOpenLoops(diagnosis) {
  const loops = [];
  if (!diagnosis) return loops;
  for (const f of (diagnosis.lifecycle && diagnosis.lifecycle.findings) || []) {
    loops.push({
      kind: 'lifecycle',
      priority: f.kind === 'duplicate-stage' || f.kind === 'invalid-in-review' ? 1 : 2,
      text: `${f.kind}: ${f.slug || '?'}${f.detail ? ' — ' + f.detail : ''}`,
      fix: f.fix || null,
    });
  }
  for (const r of (diagnosis.capacity && diagnosis.capacity.verifier_lanes) || []) {
    if (r.ok) continue;
    if (r.state === 'absent' || r.state === 'unsafe' || r.state === 'auth-failed') {
      loops.push({
        kind: 'capacity',
        priority: 1,
        text: `verifier ${r.state}: ${r.id || r.agent || 'lanes'} — ${r.reason}`,
        fix: r.fix || null,
      });
    }
  }
  return loops;
}

module.exports = {
  diagnoseWorkspace,
  classifyLifecycle,
  classifyVerifierCapacity,
  formatLifecycleFindings,
  formatCapacityRows,
  healthOpenLoops,
  authPresent,
};

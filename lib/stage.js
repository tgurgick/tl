// lib/stage.js — guarded, files-only lifecycle moves.
//
// Folder location is status. Callers therefore declare the stage they observed,
// the intended edge, their identity, and their lifecycle role. moveSpec re-reads
// the board immediately before the rename and returns typed refusals instead of
// forcing a stale or foreign move. This is cooperative enforcement, not an OS
// permission boundary: a process with shell access can still bypass this API.

'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./parse');
const { safeRead } = require('./workspace');

const STAGES = Object.freeze(['triage', 'specs', 'in-progress', 'tests', 'in-review', 'done']);

// Roles are part of the edge, rather than a global allow-list. A caller cannot
// label a backwards move "builder" or a done move "verifier" and get through.
const EDGES = Object.freeze({
  'triage>specs': Object.freeze(['release']),
  'specs>in-progress': Object.freeze(['builder']),
  'in-progress>tests': Object.freeze(['builder', 'recovery', 'reclaim']),
  'tests>in-review': Object.freeze(['verifier']),
  'in-review>done': Object.freeze(['review']),
  'in-review>in-progress': Object.freeze(['review']),
  'tests>in-progress': Object.freeze(['review']),
  'in-progress>specs': Object.freeze(['reclaim']),
});

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function refusal(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function observedStages(wsDir, slug) {
  return STAGES.filter(stage => {
    try { return fs.statSync(path.join(wsDir, stage, slug)).isDirectory(); }
    catch { return false; }
  });
}

function moveSpec(opts = {}) {
  const wsDir = opts.wsDir && path.resolve(String(opts.wsDir));
  const slug = String(opts.slug || '');
  const from = String(opts.from || '');
  const to = String(opts.to || '');
  const actor = String(opts.actor || '').trim();
  const role = String(opts.role || '').trim();

  if (!wsDir || !slug || !SLUG_RE.test(slug) || !STAGES.includes(from) || !STAGES.includes(to)) {
    return refusal('illegal-transition', { slug, from, to, observed_stage: null });
  }

  const allowedRoles = EDGES[`${from}>${to}`];
  if (!allowedRoles || !allowedRoles.includes(role)) {
    return refusal(
      to === 'done' ? 'done-requires-review-actor' : 'illegal-transition',
      { slug, from, to, actor: actor || null, role: role || null, observed_stage: null },
    );
  }
  if (!actor) {
    return refusal(
      to === 'done' ? 'done-requires-review-actor' : 'actor-required',
      { slug, from, to, role, observed_stage: null },
    );
  }

  // This scan is the stage CAS. Duplicate slugs are not guessed through: a
  // caller must repair the board invariant before any lifecycle edge proceeds.
  const observed = observedStages(wsDir, slug);
  if (observed.includes(from) && observed.includes(to)) {
    return refusal('destination-exists', {
      slug, from, to, actor, role, observed_stage: from, observed_stages: observed,
    });
  }
  if (observed.length !== 1 || observed[0] !== from) {
    return refusal('stale-stage', {
      slug, from, to, actor, role,
      observed_stage: observed.length === 1 ? observed[0] : null,
      observed_stages: observed,
    });
  }

  const src = path.join(wsDir, from, slug);
  const dest = path.join(wsDir, to, slug);
  try {
    if (fs.existsSync(dest)) {
      return refusal('destination-exists', {
        slug, from, to, actor, role, observed_stage: from,
      });
    }

    const specText = safeRead(path.join(src, 'SPEC.md'));
    const meta = parseFrontmatter(specText || '').meta;
    const claimedBy = String(meta.claimed_by || '').trim();
    // Builder edges belong to the signed claimant. Reclaim/recovery, verifier,
    // and human review are explicit roles whose purpose is to act after/beyond
    // that ownership; their own policy checks live at their caller boundary.
    if (role === 'builder' && claimedBy && claimedBy !== actor) {
      return refusal('foreign-claim', {
        slug, from, to, actor, role, claimed_by: claimedBy, observed_stage: from,
      });
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return {
      ok: true, slug, from, to, actor, role,
      observed_stage: from, resulting_stage: to,
      from_path: `${from}/${slug}/`, to_path: `${to}/${slug}/`,
    };
  } catch (err) {
    // Reclassify rename races as board-state refusals. Other filesystem errors
    // are still data so an agent can stop and report rather than force through.
    const now = observedStages(wsDir, slug);
    if (fs.existsSync(dest) || err.code === 'EEXIST' || err.code === 'ENOTEMPTY') {
      return refusal('destination-exists', {
        slug, from, to, actor, role,
        observed_stage: now.length === 1 ? now[0] : null,
      });
    }
    if (now.length !== 1 || now[0] !== from || err.code === 'ENOENT') {
      return refusal('stale-stage', {
        slug, from, to, actor, role,
        observed_stage: now.length === 1 ? now[0] : null,
        observed_stages: now,
      });
    }
    return refusal('io-error', {
      slug, from, to, actor, role, observed_stage: from,
      code: String(err.code || 'unknown'),
    });
  }
}

module.exports = { STAGES, EDGES, observedStages, moveSpec };

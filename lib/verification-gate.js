// lib/verification-gate.js — the TESTS-gate enforcement: may this spec advance
// to in-review, given its ALIGNMENT record and the workspace's verification
// policy? Exists because the cross-model check was procedural-only and quietly
// degraded to builder==verifier self-checks when an agent ran solo (see
// done/allocation-actionable-prompt). Pure functions over parsed objects —
// no fs, no http — shared by the CLI and unit-testable. Zero dependencies.

'use strict';

// The workspace policy, from parsed TRIAGE.yml. Absent section or absent flag
// means not enforced — pre-gate workspaces keep their old behavior until they
// opt in (the gate applies where the config says so, not retroactively).
function verificationPolicy(triageConfig) {
  const v = (triageConfig && triageConfig.verification) || null;
  const allow = v && Array.isArray(v.allow_self_check_for) ? v.allow_self_check_for : [];
  return {
    required: !!(v && v.require_independent_verifier),
    allowSelfCheckFor: allow.map(t => String(t).toLowerCase()),
  };
}

// canAdvanceToReview(spec, alignment, triageConfig) -> { ok, reason }
// spec: a parsed spec ({ meta }); alignment: parsed ALIGNMENT.md frontmatter
// ({ meta } or the meta object itself), or null when the file is missing;
// triageConfig: the parsed TRIAGE.yml object (or null).
function canAdvanceToReview(spec, alignment, triageConfig) {
  const policy = verificationPolicy(triageConfig);
  if (!policy.required) {
    return { ok: true, reason: 'independent verification not required by workspace policy' };
  }
  if (!alignment) {
    return { ok: false, reason: 'ALIGNMENT.md missing — independent verification is required before in-review (request one: tl verify)' };
  }
  const a = alignment.meta || alignment;
  const sMeta = (spec && spec.meta) || {};
  const builder = String(a.builder || sMeta.claimed_by || '').toLowerCase();
  const verifier = String(a.verifier || '').toLowerCase();
  const vtype = String(a.verification_type || '').toLowerCase();
  const specType = String(sMeta.type || '').toLowerCase();
  const verdictOk = ['pass', 'residual-concerns'].includes(String(a.verdict || '').toLowerCase());
  if (String(a.verdict || '').toLowerCase() === 'human-decision-required') {
    return { ok: false, reason: 'verifier proposed a mutation — human must approve an agent fix-forward or kick the spec back' };
  }

  const isSelfCheck = vtype === 'self-check' || (!!builder && builder === verifier);
  if (isSelfCheck) {
    if (!policy.allowSelfCheckFor.includes(specType)) {
      return {
        ok: false,
        reason: `builder == verifier (${builder || 'unknown'}) and self-check is not allowed for type "${specType || 'unknown'}" — an independent verifier must sign ALIGNMENT (tl verify)`,
      };
    }
    if (!verdictOk) return { ok: false, reason: 'self-check recorded but verdict is not pass/residual-concerns' };
    return { ok: true, reason: `self-check permitted for type "${specType}" by allow_self_check_for` };
  }

  if (!verifier) return { ok: false, reason: 'no verifier recorded on ALIGNMENT — independent verification required' };
  if (!verdictOk) return { ok: false, reason: 'verdict must be pass or residual-concerns to advance' };
  return { ok: true, reason: 'independently verified by ' + verifier };
}

module.exports = { verificationPolicy, canAdvanceToReview };

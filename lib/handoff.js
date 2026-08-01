// lib/handoff.js — versioned builder handoff manifests (`outcome/HANDOFF.json`).
//
// A terminal HANDOFF.json, written LAST after FEEDBACK / BUILDER.diff (and any
// other declared artifacts) already exist on disk, content-binds those bytes
// to SHA-256 digests plus builder identity, stage edge, base commit, test
// evidence, preparation time, and a run/correlation id. Validation re-hashes
// current bytes and returns typed refusals — integrity and consistency, not
// authenticated writer identity and not an OS sandbox. A process with shell
// access can still bypass this API; hashes only prove the declared set matches
// what is on disk at check time (see SCHEMA.md).
//
// Legacy handoffs (FEEDBACK ± BUILDER.diff without a manifest) remain readable
// via classifyHandoff({ kind: 'legacy' }). New writers treat the manifest as
// the single completion proof and do not coordinate separate folder /
// frontmatter / VERIFY.md / request-file truth here — downstream finalize /
// recovery specs own those surfaces.
//
// Node stdlib only. Typed refusals mirror lib/stage.js.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { parseFrontmatter } = require('./parse');
const { safePath, safeRead } = require('./workspace');

const HANDOFF_VERSION = 1;
const HANDOFF_REL = 'outcome/HANDOFF.json';
const HANDOFF_TMP_REL = 'outcome/HANDOFF.json.tmp';

const REQUIRED_ARTIFACTS = Object.freeze([
  'SPEC.md',
  'outcome/FEEDBACK.md',
  'outcome/BUILDER.diff',
]);

const STAGES = Object.freeze([
  'triage', 'specs', 'in-progress', 'tests', 'in-review', 'done',
]);

function refusal(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(absPath) {
  return sha256Hex(fs.readFileSync(absPath));
}

// Relative paths declared in a manifest must stay inside the spec folder.
// Reject absolutes, empty, null bytes, backslashes, and any `..` segment.
function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || !rel.length) return false;
  if (path.isAbsolute(rel)) return false;
  if (rel.includes('\0') || rel.includes('\\')) return false;
  const parts = rel.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return false;
  return true;
}

function resolveUnderSpec(specDir, rel) {
  if (!isSafeRelPath(rel)) return null;
  return safePath(specDir, rel);
}

function handoffPath(specDir) {
  return path.join(specDir, ...HANDOFF_REL.split('/'));
}

function handoffTmpPath(specDir, attempt = '') {
  const suffix = attempt ? `.${attempt}` : '';
  return path.join(specDir, ...`${HANDOFF_TMP_REL}${suffix}`.split('/'));
}

function uniqueAttemptId() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function readClaimedBy(specDir) {
  const text = safeRead(path.join(specDir, 'SPEC.md'));
  if (text == null) return null;
  const meta = parseFrontmatter(text).meta || {};
  const v = String(meta.claimed_by || '').trim();
  return v || null;
}

// tests: non-empty array of { command: string, ok: boolean, exit_code?: number, summary?: string }
function validateTestsShape(tests) {
  if (!Array.isArray(tests) || tests.length === 0) {
    return refusal('malformed-tests', { detail: 'tests must be a non-empty array' });
  }
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return refusal('malformed-tests', { detail: `tests[${i}] must be an object`, index: i });
    }
    if (typeof t.command !== 'string' || !t.command.trim()) {
      return refusal('malformed-tests', { detail: `tests[${i}].command must be a non-empty string`, index: i });
    }
    if (typeof t.ok !== 'boolean') {
      return refusal('malformed-tests', { detail: `tests[${i}].ok must be boolean`, index: i });
    }
    if (t.exit_code != null && !Number.isInteger(t.exit_code)) {
      return refusal('malformed-tests', { detail: `tests[${i}].exit_code must be an integer when set`, index: i });
    }
    if (t.summary != null && typeof t.summary !== 'string') {
      return refusal('malformed-tests', { detail: `tests[${i}].summary must be a string when set`, index: i });
    }
  }
  return { ok: true };
}

function normalizeTests(tests) {
  return tests.map(t => {
    const row = { command: String(t.command).trim(), ok: !!t.ok };
    if (t.exit_code != null) row.exit_code = t.exit_code;
    if (t.summary != null) row.summary = String(t.summary);
    return row;
  });
}

function collectArtifactPaths(extra) {
  const seen = new Set();
  const out = [];
  for (const rel of [...REQUIRED_ARTIFACTS, ...(extra || [])]) {
    const p = String(rel || '').trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function hashArtifacts(specDir, relPaths) {
  const artifacts = [];
  for (const rel of relPaths) {
    const abs = resolveUnderSpec(specDir, rel);
    if (!abs) return refusal('unsafe-path', { path: rel });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return refusal('missing-artifact', { path: rel });
    }
    artifacts.push({ path: rel, sha256: hashFile(abs) });
  }
  return { ok: true, artifacts };
}

function parseHandoff(text) {
  if (text == null || text === '') {
    return refusal('missing-manifest', { detail: 'HANDOFF.json absent or empty' });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return refusal('malformed-manifest', { detail: String(err.message || 'invalid JSON') });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return refusal('malformed-manifest', { detail: 'root must be an object' });
  }
  return { ok: true, manifest: raw };
}

function readHandoff(specDir) {
  const abs = handoffPath(specDir);
  const text = safeRead(abs);
  if (text == null) return { ok: false, reason: 'missing-manifest', path: HANDOFF_REL };
  return parseHandoff(text);
}

function structuralCheck(manifest) {
  if (manifest.version !== HANDOFF_VERSION) {
    return refusal('unsupported-version', {
      version: manifest.version == null ? null : manifest.version,
      supported: HANDOFF_VERSION,
    });
  }
  const builder = String(manifest.builder || '').trim();
  if (!builder) return refusal('identity-mismatch', { detail: 'builder required', builder: null });

  const fromStage = String(manifest.from_stage || '').trim();
  const toStage = String(manifest.to_stage || '').trim();
  if (!STAGES.includes(fromStage) || !STAGES.includes(toStage)) {
    return refusal('stage-mismatch', {
      detail: 'from_stage and to_stage must be known stages',
      from_stage: fromStage || null,
      to_stage: toStage || null,
    });
  }

  const baseCommit = String(manifest.base_commit || '').trim();
  if (!baseCommit) {
    return refusal('malformed-manifest', { detail: 'base_commit required (source/base-diff identity)' });
  }

  const preparedAt = String(manifest.prepared_at || '').trim();
  if (!preparedAt) {
    return refusal('malformed-manifest', { detail: 'prepared_at required' });
  }

  const runId = String(manifest.run_id || '').trim();
  if (!runId) {
    return refusal('malformed-manifest', { detail: 'run_id required' });
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    return refusal('malformed-manifest', { detail: 'artifacts must be a non-empty array' });
  }
  for (let i = 0; i < manifest.artifacts.length; i++) {
    const a = manifest.artifacts[i];
    if (!a || typeof a !== 'object' || typeof a.path !== 'string' || typeof a.sha256 !== 'string') {
      return refusal('malformed-manifest', { detail: `artifacts[${i}] needs path and sha256 strings`, index: i });
    }
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) {
      return refusal('malformed-manifest', { detail: `artifacts[${i}].sha256 must be 64 hex chars`, index: i });
    }
  }

  const requiredMissing = REQUIRED_ARTIFACTS.filter(
    req => !manifest.artifacts.some(a => a.path === req),
  );
  if (requiredMissing.length) {
    return refusal('missing-artifact', {
      detail: 'manifest omits required artifacts',
      paths: requiredMissing,
    });
  }

  const testsCheck = validateTestsShape(manifest.tests);
  if (!testsCheck.ok) return testsCheck;

  return {
    ok: true,
    builder,
    from_stage: fromStage,
    to_stage: toStage,
    base_commit: baseCommit,
    prepared_at: preparedAt,
    run_id: runId,
  };
}

// createHandoff — hash declared artifacts, refuse if any are missing/unsafe,
// then write outcome/HANDOFF.json atomically (tmp + rename). Never writes
// VERIFY.md, awaiting_verifier, or stage/folder state.
function createHandoff(opts = {}) {
  const specDir = opts.specDir && path.resolve(String(opts.specDir));
  if (!specDir || !fs.existsSync(specDir)) {
    return refusal('missing-artifact', { detail: 'specDir missing', path: 'SPEC.md' });
  }

  const builder = String(opts.builder || '').trim();
  const fromStage = String(opts.from_stage != null ? opts.from_stage : opts.fromStage || '').trim();
  const toStage = String(opts.to_stage != null ? opts.to_stage : opts.toStage || '').trim();
  const baseCommit = String(opts.base_commit != null ? opts.base_commit : opts.baseCommit || '').trim();
  const runId = String(opts.run_id != null ? opts.run_id : opts.runId || '').trim();
  const preparedAt = String(
    opts.prepared_at != null ? opts.prepared_at
      : opts.preparedAt != null ? opts.preparedAt
        : new Date().toISOString(),
  ).trim();
  const claimedAt = opts.claimed_at != null ? opts.claimed_at
    : opts.claimedAt != null ? opts.claimedAt
      : null;

  if (!builder) return refusal('identity-mismatch', { detail: 'builder required', builder: null });
  if (!STAGES.includes(fromStage) || !STAGES.includes(toStage)) {
    return refusal('stage-mismatch', {
      detail: 'from_stage and to_stage must be known stages',
      from_stage: fromStage || null,
      to_stage: toStage || null,
    });
  }
  if (!baseCommit) {
    return refusal('malformed-manifest', { detail: 'base_commit required (source/base-diff identity)' });
  }
  if (!runId) return refusal('malformed-manifest', { detail: 'run_id required' });
  if (!preparedAt) return refusal('malformed-manifest', { detail: 'prepared_at required' });

  const claimedBy = readClaimedBy(specDir);
  if (claimedBy && claimedBy !== builder) {
    return refusal('identity-mismatch', {
      builder,
      claimed_by: claimedBy,
      detail: 'builder must match SPEC.md claimed_by',
    });
  }
  if (!fs.existsSync(path.join(specDir, 'SPEC.md'))) {
    return refusal('missing-artifact', { path: 'SPEC.md' });
  }

  const testsCheck = validateTestsShape(opts.tests);
  if (!testsCheck.ok) return testsCheck;

  const relPaths = collectArtifactPaths(opts.artifacts);
  const hashed = hashArtifacts(specDir, relPaths);
  if (!hashed.ok) return hashed;

  // Dest must not already exist as a half-written tmp that somehow blocked —
  // refuse overwrite of a committed handoff unless { overwrite: true }.
  const dest = handoffPath(specDir);
  if (fs.existsSync(dest) && !opts.overwrite) {
    return refusal('manifest-exists', { path: HANDOFF_REL });
  }

  const manifest = {
    version: HANDOFF_VERSION,
    builder,
    claimed_at: claimedAt == null ? null : String(claimedAt),
    from_stage: fromStage,
    to_stage: toStage,
    base_commit: baseCommit,
    prepared_at: preparedAt,
    run_id: runId,
    artifacts: hashed.artifacts,
    tests: normalizeTests(opts.tests),
  };

  // Each creator owns a distinct temp file. The final no-overwrite commit uses
  // hard-link creation: link(tmp, dest) is atomic and fails with EEXIST when
  // another creator already committed. Unlike rename(tmp, dest), it can never
  // replace the winner's bytes on POSIX.
  const tmp = handoffTmpPath(specDir, uniqueAttemptId());
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Re-check every referenced artifact still exists immediately before write
    // so a race that deletes FEEDBACK between hash and commit cannot land a
    // complete-looking manifest.
    const recheck = hashArtifacts(specDir, relPaths);
    if (!recheck.ok) {
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      return recheck;
    }
    // Digests must still match — refuse if bytes changed under us.
    for (let i = 0; i < hashed.artifacts.length; i++) {
      if (hashed.artifacts[i].sha256 !== recheck.artifacts[i].sha256) {
        try { fs.unlinkSync(tmp); } catch { /* none */ }
        return refusal('artifact-changed', {
          path: hashed.artifacts[i].path,
          expected: hashed.artifacts[i].sha256,
          actual: recheck.artifacts[i].sha256,
        });
      }
    }
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    if (opts.overwrite) {
      fs.renameSync(tmp, dest);
    } else {
      fs.linkSync(tmp, dest);
      fs.unlinkSync(tmp);
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    if (!opts.overwrite && err && err.code === 'EEXIST') {
      return refusal('manifest-exists', { path: HANDOFF_REL });
    }
    return refusal('io-error', {
      path: HANDOFF_REL,
      code: String(err.code || 'unknown'),
      detail: String(err.message || err),
    });
  }

  return {
    ok: true,
    path: HANDOFF_REL,
    manifest,
    sha256: sha256Hex(JSON.stringify(manifest, null, 2) + '\n'),
  };
}

// validateHandoff — re-read disk and return typed results. Optional expected_*
// fields check stage/identity consistency against the caller’s observed board.
function validateHandoff(opts = {}) {
  const specDir = opts.specDir && path.resolve(String(opts.specDir));
  if (!specDir) return refusal('missing-artifact', { detail: 'specDir required', path: 'SPEC.md' });

  const read = readHandoff(specDir);
  if (!read.ok) return read;
  const manifest = read.manifest;

  const struct = structuralCheck(manifest);
  if (!struct.ok) return struct;

  for (const a of manifest.artifacts) {
    const abs = resolveUnderSpec(specDir, a.path);
    if (!abs) return refusal('unsafe-path', { path: a.path });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return refusal('missing-artifact', { path: a.path });
    }
    const actual = hashFile(abs);
    if (actual !== a.sha256) {
      return refusal('artifact-changed', {
        path: a.path,
        expected: a.sha256,
        actual,
      });
    }
  }

  const claimedBy = readClaimedBy(specDir);
  if (claimedBy && claimedBy !== struct.builder) {
    return refusal('identity-mismatch', {
      builder: struct.builder,
      claimed_by: claimedBy,
    });
  }

  const expectedBuilder = opts.expected_builder != null ? opts.expected_builder
    : opts.expectedBuilder != null ? opts.expectedBuilder
      : null;
  if (expectedBuilder != null && String(expectedBuilder).trim() !== struct.builder) {
    return refusal('identity-mismatch', {
      builder: struct.builder,
      expected_builder: String(expectedBuilder).trim(),
    });
  }

  const expectedFrom = opts.expected_from_stage != null ? opts.expected_from_stage
    : opts.expectedFromStage != null ? opts.expectedFromStage
      : null;
  const expectedTo = opts.expected_to_stage != null ? opts.expected_to_stage
    : opts.expectedToStage != null ? opts.expectedToStage
      : null;
  if (expectedFrom != null && String(expectedFrom) !== struct.from_stage) {
    return refusal('stage-mismatch', {
      from_stage: struct.from_stage,
      to_stage: struct.to_stage,
      expected_from_stage: String(expectedFrom),
      expected_to_stage: expectedTo == null ? null : String(expectedTo),
    });
  }
  if (expectedTo != null && String(expectedTo) !== struct.to_stage) {
    return refusal('stage-mismatch', {
      from_stage: struct.from_stage,
      to_stage: struct.to_stage,
      expected_from_stage: expectedFrom == null ? null : String(expectedFrom),
      expected_to_stage: String(expectedTo),
    });
  }

  return {
    ok: true,
    path: HANDOFF_REL,
    manifest,
    builder: struct.builder,
    from_stage: struct.from_stage,
    to_stage: struct.to_stage,
    base_commit: struct.base_commit,
    prepared_at: struct.prepared_at,
    run_id: struct.run_id,
    legacy: false,
  };
}

// classifyHandoff — readable disposition for queue/recovery without forcing a
// hard fail on pre-manifest work. Partial artifact sets are never "complete".
function classifyHandoff(specDir) {
  const root = path.resolve(String(specDir || ''));
  const hasFeedback = fs.existsSync(path.join(root, 'outcome', 'FEEDBACK.md'));
  const hasDiff = fs.existsSync(path.join(root, 'outcome', 'BUILDER.diff'));
  const hasManifest = fs.existsSync(handoffPath(root));
  let hasTmp = fs.existsSync(handoffTmpPath(root));
  if (!hasTmp) {
    try {
      hasTmp = fs.readdirSync(path.join(root, 'outcome'))
        .some(name => name.startsWith('HANDOFF.json.tmp.'));
    } catch { hasTmp = false; }
  }

  if (hasManifest) {
    const v = validateHandoff({ specDir: root });
    if (v.ok) {
      return { kind: 'v1', ok: true, path: HANDOFF_REL, manifest: v.manifest, legacy: false };
    }
    return {
      kind: 'invalid',
      ok: false,
      path: HANDOFF_REL,
      reason: v.reason,
      details: v,
      legacy: false,
    };
  }

  if (hasTmp && !hasManifest) {
    return {
      kind: 'partial',
      ok: false,
      reason: 'partial-write',
      detail: 'HANDOFF.json.tmp present without HANDOFF.json — write interrupted before rename',
      legacy: false,
    };
  }

  if (hasFeedback && hasDiff) {
    return {
      kind: 'legacy',
      ok: true,
      legacy: true,
      detail: 'FEEDBACK.md and BUILDER.diff present without HANDOFF.json — pre-manifest handoff',
    };
  }

  if (hasFeedback || hasDiff) {
    return {
      kind: 'partial',
      ok: false,
      reason: 'partial-artifacts',
      detail: 'incomplete builder artifacts without a terminal manifest',
      has_feedback: hasFeedback,
      has_builder_diff: hasDiff,
      legacy: false,
    };
  }

  return { kind: 'absent', ok: false, legacy: false };
}

module.exports = {
  HANDOFF_VERSION,
  HANDOFF_REL,
  HANDOFF_FILE: HANDOFF_REL,
  REQUIRED_ARTIFACTS,
  STAGES,
  sha256Hex,
  hashFile,
  isSafeRelPath,
  parseHandoff,
  readHandoff,
  createHandoff,
  validateHandoff,
  classifyHandoff,
};

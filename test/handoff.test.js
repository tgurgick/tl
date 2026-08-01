'use strict';
// Handoff manifest contract — create / hash / validate / classify.
// Covers: hashing, tampering, path traversal, partial writes, versions, legacy.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HANDOFF_VERSION,
  HANDOFF_REL,
  REQUIRED_ARTIFACTS,
  sha256Hex,
  hashFile,
  isSafeRelPath,
  createHandoff,
  validateHandoff,
  classifyHandoff,
  parseHandoff,
  readHandoff,
} = require('../lib/handoff');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function withSpec(fn, meta = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-handoff-'));
  const claimedBy = meta.claimed_by != null ? meta.claimed_by : 'cursor';
  try {
    fs.mkdirSync(path.join(root, 'outcome'), { recursive: true });
    const fm = [
      '---',
      'title: "handoff-fixture"',
      'status: "in-progress"',
      claimedBy ? `claimed_by: "${claimedBy}"` : null,
      claimedBy ? 'claimed_at: "2026-07-24"' : null,
      '---',
      '',
      '# fixture',
      '',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(root, 'SPEC.md'), fm);
    fs.writeFileSync(path.join(root, 'outcome', 'FEEDBACK.md'), '# feedback\n');
    fs.writeFileSync(path.join(root, 'outcome', 'BUILDER.diff'), 'diff --git a/x b/x\n');
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function goodOpts(specDir, extra = {}) {
  return {
    specDir,
    builder: 'cursor',
    from_stage: 'in-progress',
    to_stage: 'tests',
    base_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    prepared_at: '2026-07-24T15:30:00.000Z',
    run_id: 'cursor-run-2026-07-24T1529',
    claimed_at: '2026-07-24',
    tests: [{ command: 'node --test test/handoff.test.js', ok: true, exit_code: 0 }],
    ...extra,
  };
}

test('REQUIRED_ARTIFACTS lists SPEC, FEEDBACK, BUILDER.diff', () => {
  assert.deepEqual([...REQUIRED_ARTIFACTS], [
    'SPEC.md',
    'outcome/FEEDBACK.md',
    'outcome/BUILDER.diff',
  ]);
});

test('isSafeRelPath rejects traversal and absolutes', () => {
  assert.equal(isSafeRelPath('outcome/FEEDBACK.md'), true);
  assert.equal(isSafeRelPath('../etc/passwd'), false);
  assert.equal(isSafeRelPath('outcome/../../etc/passwd'), false);
  assert.equal(isSafeRelPath('/etc/passwd'), false);
  assert.equal(isSafeRelPath(''), false);
  assert.equal(isSafeRelPath('a\\b'), false);
  assert.equal(isSafeRelPath('outcome/./FEEDBACK.md'), false);
});

test('sha256Hex / hashFile match crypto digests', () => withSpec(specDir => {
  const body = fs.readFileSync(path.join(specDir, 'outcome', 'FEEDBACK.md'));
  assert.equal(sha256Hex(body), sha256(body));
  assert.equal(hashFile(path.join(specDir, 'outcome', 'FEEDBACK.md')), sha256(body));
}));

test('createHandoff writes V1 binding atomically after artifacts exist', () => withSpec(specDir => {
  const got = createHandoff(goodOpts(specDir));
  assert.equal(got.ok, true);
  assert.equal(got.path, HANDOFF_REL);
  assert.equal(got.manifest.version, HANDOFF_VERSION);
  assert.equal(got.manifest.builder, 'cursor');
  assert.equal(got.manifest.from_stage, 'in-progress');
  assert.equal(got.manifest.to_stage, 'tests');
  assert.equal(got.manifest.base_commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(got.manifest.prepared_at, '2026-07-24T15:30:00.000Z');
  assert.equal(got.manifest.run_id, 'cursor-run-2026-07-24T1529');
  assert.ok(Array.isArray(got.manifest.artifacts));
  assert.equal(got.manifest.artifacts.length, 3);
  assert.deepEqual(
    got.manifest.artifacts.map(a => a.path),
    ['SPEC.md', 'outcome/FEEDBACK.md', 'outcome/BUILDER.diff'],
  );
  for (const a of got.manifest.artifacts) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.equal(a.sha256, hashFile(path.join(specDir, ...a.path.split('/'))));
  }
  assert.equal(got.manifest.tests[0].ok, true);
  assert.ok(fs.existsSync(path.join(specDir, 'outcome', 'HANDOFF.json')));
  assert.equal(fs.existsSync(path.join(specDir, 'outcome', 'HANDOFF.json.tmp')), false);
  // New writers do not stamp VERIFY / awaiting_verifier / stage frontmatter.
  assert.equal(fs.existsSync(path.join(specDir, 'VERIFY.md')), false);
  const specText = fs.readFileSync(path.join(specDir, 'SPEC.md'), 'utf8');
  assert.equal(/awaiting_verifier:/.test(specText), false);
}));

test('createHandoff refuses missing artifacts and leaves no HANDOFF.json', () => withSpec(specDir => {
  fs.unlinkSync(path.join(specDir, 'outcome', 'FEEDBACK.md'));
  const got = createHandoff(goodOpts(specDir));
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'missing-artifact');
  assert.equal(got.path, 'outcome/FEEDBACK.md');
  assert.equal(fs.existsSync(path.join(specDir, 'outcome', 'HANDOFF.json')), false);
  assert.equal(fs.existsSync(path.join(specDir, 'outcome', 'HANDOFF.json.tmp')), false);
}));

test('createHandoff refuses unsafe artifact paths', () => withSpec(specDir => {
  const got = createHandoff(goodOpts(specDir, { artifacts: ['../../etc/passwd'] }));
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'unsafe-path');
  assert.equal(fs.existsSync(path.join(specDir, 'outcome', 'HANDOFF.json')), false);
}));

test('createHandoff refuses malformed tests', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir, { tests: [] })).reason, 'malformed-tests');
  assert.equal(createHandoff(goodOpts(specDir, { tests: 'nope' })).reason, 'malformed-tests');
  assert.equal(
    createHandoff(goodOpts(specDir, { tests: [{ command: 'x' }] })).reason,
    'malformed-tests',
  );
  assert.equal(
    createHandoff(goodOpts(specDir, { tests: [{ command: '', ok: true }] })).reason,
    'malformed-tests',
  );
  assert.equal(fs.existsSync(path.join(specDir, 'outcome', 'HANDOFF.json')), false);
}));

test('createHandoff refuses builder / claimed_by identity mismatch', () => withSpec(specDir => {
  const got = createHandoff(goodOpts(specDir, { builder: 'claude' }));
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'identity-mismatch');
  assert.equal(got.claimed_by, 'cursor');
}));

test('createHandoff refuses bad stages', () => withSpec(specDir => {
  const got = createHandoff(goodOpts(specDir, { from_stage: 'ready', to_stage: 'tests' }));
  assert.equal(got.reason, 'stage-mismatch');
}));

test('validateHandoff accepts a fresh create', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  const v = validateHandoff({
    specDir,
    expected_builder: 'cursor',
    expected_from_stage: 'in-progress',
    expected_to_stage: 'tests',
  });
  assert.equal(v.ok, true);
  assert.equal(v.legacy, false);
  assert.equal(v.builder, 'cursor');
  assert.equal(v.run_id, 'cursor-run-2026-07-24T1529');
}));

test('validateHandoff detects tampering (artifact-changed)', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  fs.writeFileSync(path.join(specDir, 'outcome', 'FEEDBACK.md'), '# tampered\n');
  const v = validateHandoff({ specDir });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'artifact-changed');
  assert.equal(v.path, 'outcome/FEEDBACK.md');
  assert.match(v.expected, /^[0-9a-f]{64}$/);
  assert.match(v.actual, /^[0-9a-f]{64}$/);
  assert.notEqual(v.expected, v.actual);
}));

test('validateHandoff detects deleted bound files', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  fs.unlinkSync(path.join(specDir, 'outcome', 'BUILDER.diff'));
  const v = validateHandoff({ specDir });
  assert.equal(v.reason, 'missing-artifact');
  assert.equal(v.path, 'outcome/BUILDER.diff');
}));

test('validateHandoff refuses unsupported versions', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  const p = path.join(specDir, 'outcome', 'HANDOFF.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.version = 99;
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  const v = validateHandoff({ specDir });
  assert.equal(v.reason, 'unsupported-version');
  assert.equal(v.version, 99);
  assert.equal(v.supported, 1);
}));

test('validateHandoff refuses unsafe paths recorded in the manifest', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  const p = path.join(specDir, 'outcome', 'HANDOFF.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.artifacts.push({
    path: '../escape.txt',
    sha256: '0'.repeat(64),
  });
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  const v = validateHandoff({ specDir });
  assert.equal(v.reason, 'unsafe-path');
  assert.equal(v.path, '../escape.txt');
}));

test('validateHandoff refuses malformed tests in a stored manifest', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  const p = path.join(specDir, 'outcome', 'HANDOFF.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.tests = [{ command: 'x', ok: 'yes' }];
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  assert.equal(validateHandoff({ specDir }).reason, 'malformed-tests');
}));

test('validateHandoff refuses stage and identity mismatches against expectations', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  assert.equal(
    validateHandoff({ specDir, expected_from_stage: 'tests' }).reason,
    'stage-mismatch',
  );
  assert.equal(
    validateHandoff({ specDir, expected_builder: 'claude' }).reason,
    'identity-mismatch',
  );
}));

test('validateHandoff refuses when SPEC claimed_by drifts after handoff', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  let text = fs.readFileSync(path.join(specDir, 'SPEC.md'), 'utf8');
  text = text.replace('claimed_by: "cursor"', 'claimed_by: "codex"');
  fs.writeFileSync(path.join(specDir, 'SPEC.md'), text);
  // SPEC bytes also changed → artifact-changed on SPEC.md wins first
  const v = validateHandoff({ specDir });
  assert.equal(v.reason, 'artifact-changed');
  assert.equal(v.path, 'SPEC.md');
}));

test('partial write: tmp without final is not a valid handoff', () => withSpec(specDir => {
  fs.writeFileSync(path.join(specDir, 'outcome', 'HANDOFF.json.tmp'), '{"version":1}\n');
  assert.equal(readHandoff(specDir).reason, 'missing-manifest');
  const c = classifyHandoff(specDir);
  assert.equal(c.kind, 'partial');
  assert.equal(c.reason, 'partial-write');
  assert.equal(validateHandoff({ specDir }).ok, false);
}));

test('legacy handoffs remain readable but explicitly legacy', () => withSpec(specDir => {
  // FEEDBACK + BUILDER.diff already present; no HANDOFF.json
  const c = classifyHandoff(specDir);
  assert.equal(c.kind, 'legacy');
  assert.equal(c.legacy, true);
  assert.equal(c.ok, true);
  assert.match(c.detail, /without HANDOFF\.json/);
}));

test('partial artifacts without both files are not legacy-complete', () => withSpec(specDir => {
  fs.unlinkSync(path.join(specDir, 'outcome', 'BUILDER.diff'));
  const c = classifyHandoff(specDir);
  assert.equal(c.kind, 'partial');
  assert.equal(c.reason, 'partial-artifacts');
  assert.equal(c.legacy, false);
}));

test('classifyHandoff reports v1 after create', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  const c = classifyHandoff(specDir);
  assert.equal(c.kind, 'v1');
  assert.equal(c.legacy, false);
  assert.equal(c.ok, true);
}));

test('classifyHandoff reports invalid when manifest is corrupted', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  fs.writeFileSync(path.join(specDir, 'outcome', 'HANDOFF.json'), '{not-json');
  const c = classifyHandoff(specDir);
  assert.equal(c.kind, 'invalid');
  assert.equal(c.reason, 'malformed-manifest');
}));

test('parseHandoff rejects non-objects', () => {
  assert.equal(parseHandoff('[]').reason, 'malformed-manifest');
  assert.equal(parseHandoff('null').reason, 'malformed-manifest');
  assert.equal(parseHandoff('').reason, 'missing-manifest');
});

test('absent classification when no builder artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-handoff-empty-'));
  try {
    fs.writeFileSync(path.join(root, 'SPEC.md'), '---\ntitle: "x"\n---\n');
    const c = classifyHandoff(root);
    assert.equal(c.kind, 'absent');
    assert.equal(c.legacy, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('create refuses overwrite of an existing committed handoff', () => withSpec(specDir => {
  assert.equal(createHandoff(goodOpts(specDir)).ok, true);
  const again = createHandoff(goodOpts(specDir));
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'manifest-exists');
  assert.equal(createHandoff(goodOpts(specDir, { overwrite: true })).ok, true);
}));

test('concurrent creator loses atomically and cannot replace winner bytes', () => withSpec(specDir => {
  const dest = path.join(specDir, 'outcome', 'HANDOFF.json');
  const winner = '{"winner":"other-creator"}\n';
  const originalLink = fs.linkSync;
  let attemptedTmp = null;
  fs.linkSync = (tmp, target) => {
    attemptedTmp = tmp;
    assert.equal(target, dest);
    // Deterministically inject the other creator's commit in the exact window
    // between this creator's precheck and its atomic no-replace link.
    fs.writeFileSync(dest, winner, { flag: 'wx' });
    const err = new Error('destination exists');
    err.code = 'EEXIST';
    throw err;
  };
  try {
    const got = createHandoff(goodOpts(specDir));
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'manifest-exists');
    assert.equal(fs.readFileSync(dest, 'utf8'), winner, 'loser must preserve winner bytes');
    assert.ok(attemptedTmp && /HANDOFF\.json\.tmp\./.test(attemptedTmp));
    assert.equal(fs.existsSync(attemptedTmp), false, 'loser cleans only its own unique temp');
  } finally {
    fs.linkSync = originalLink;
  }
}));

test('unique interrupted temp is classified partial', () => withSpec(specDir => {
  fs.writeFileSync(
    path.join(specDir, 'outcome', 'HANDOFF.json.tmp.123-attempt'),
    '{"version":1}\n',
  );
  const got = classifyHandoff(specDir);
  assert.equal(got.kind, 'partial');
  assert.equal(got.reason, 'partial-write');
}));

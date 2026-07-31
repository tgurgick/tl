'use strict';
// test/doctor.test.js — lifecycle integrity + verifier capacity classifier
// (lib/doctor.js). Read-only: never spawns, recovers, or mutates.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  diagnoseWorkspace, classifyLifecycle, classifyVerifierCapacity,
  formatLifecycleFindings, formatCapacityRows, healthOpenLoops, authPresent,
} = require('../lib/doctor');
const { createHandoff } = require('../lib/handoff');
const { setFrontmatterField } = require('../lib/frontmatter');

const HOUR = 3600000;
const NOW = Date.parse('2026-07-31T12:00:00Z');

function mkWs(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-doctor-'));
  for (const s of ['triage', 'specs', 'in-progress', 'tests', 'in-review', 'done']) {
    fs.mkdirSync(path.join(root, s), { recursive: true });
  }
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function writeSpec(ws, stage, slug, { fm = {}, body = '# hi\n', files = {} } = {}) {
  const dir = path.join(ws, stage, slug);
  fs.mkdirSync(path.join(dir, 'outcome'), { recursive: true });
  const lines = ['---', `title: "${slug}"`, 'status: "' + stage + '"'];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(typeof v === 'boolean' ? `${k}: ${v}` : `${k}: "${v}"`);
  }
  lines.push('---', '', body);
  fs.writeFileSync(path.join(dir, 'SPEC.md'), lines.join('\n') + '\n');
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return dir;
}

function safeLane(agent, extra = {}) {
  return {
    agent, isolated: true, sandbox: 'required',
    allow_network: agent === 'gemini' ? false : undefined,
    command: [agent === 'gemini' ? 'agy' : agent],
    ...extra,
  };
}

function lanesCfg(...agentsOrEntries) {
  const verifier_lanes = {};
  for (const entry of agentsOrEntries) {
    if (typeof entry === 'string') verifier_lanes[entry] = safeLane(entry);
    else {
      const { id, ...rest } = entry;
      verifier_lanes[id] = safeLane(id, rest);
    }
  }
  return { verification: { verifier_lanes } };
}

test('authPresent: lane allowlist presence only (no network)', () => {
  assert.equal(authPresent('claude', {}).present, false);
  assert.equal(authPresent('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'x' }).present, true);
  assert.equal(authPresent('gemini', { GEMINI_API_KEY: 'g' }).present, true);
  assert.equal(authPresent('codex', { OPENAI_API_KEY: 'o' }).present, true);
  assert.equal(authPresent('cursor', { CURSOR_API_KEY: 'c' }).present, true);
});

test('capacity: absent when no verifier_lanes configured', () => mkWs(ws => {
  const cap = classifyVerifierCapacity(ws, { cfg: {}, which: () => '/bin/true', env: {} });
  assert.equal(cap.verifier_lanes[0].state, 'absent');
  assert.equal(cap.summary.ok, false);
}));

test('capacity: Claude/Codex/Cursor/Gemini available when safe + reachable + auth', () => mkWs(ws => {
  const cfg = lanesCfg('claude', 'codex', 'cursor', 'gemini');
  const which = () => '/usr/bin/fake';
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: '1', OPENAI_API_KEY: '2', CURSOR_API_KEY: '3', GEMINI_API_KEY: '4',
  };
  const cap = classifyVerifierCapacity(ws, { cfg, which, env });
  assert.equal(cap.summary.ok, true);
  assert.deepEqual(cap.summary.available.sort(), ['claude', 'codex', 'cursor', 'gemini']);
  for (const r of cap.verifier_lanes) assert.equal(r.state, 'available');
}));

test('capacity: unsafe Gemini (allow_network) and unreachable binary', () => mkWs(ws => {
  const cfg = lanesCfg({ id: 'gemini', allow_network: true }, 'claude');
  const which = bin => (bin === 'claude' ? '/bin/claude' : '');
  const env = { CLAUDE_CODE_OAUTH_TOKEN: '1', GEMINI_API_KEY: 'g' };
  const cap = classifyVerifierCapacity(ws, { cfg, which, env });
  const gem = cap.verifier_lanes.find(r => r.agent === 'gemini');
  const cl = cap.verifier_lanes.find(r => r.agent === 'claude');
  assert.equal(gem.state, 'unsafe');
  assert.match(gem.reason, /allow_network|unsafe/i);
  assert.ok(gem.fix);
  assert.equal(cl.state, 'available');
}));

test('capacity: auth-failed when env missing', () => mkWs(ws => {
  const cfg = lanesCfg('cursor');
  const cap = classifyVerifierCapacity(ws, {
    cfg, which: () => '/bin/cursor', env: {},
  });
  assert.equal(cap.verifier_lanes[0].state, 'auth-failed');
  assert.match(cap.verifier_lanes[0].fix, /CURSOR_API_KEY/);
}));

test('capacity: builder-only when every awaiting spec was built by the lane', () => mkWs(ws => {
  writeSpec(ws, 'tests', 'mine', {
    fm: { claimed_by: 'claude', awaiting_verifier: true, status: 'tests' },
    files: { 'outcome/FEEDBACK.md': 'x\n', 'outcome/BUILDER.diff': 'd\n' },
  });
  // stamp a minimal valid-ish awaiting without forcing full manifest — builderOf reads claimed_by
  const cfg = lanesCfg('claude', 'codex');
  const env = { CLAUDE_CODE_OAUTH_TOKEN: '1', OPENAI_API_KEY: '2' };
  const which = () => '/bin/x';
  const cap = classifyVerifierCapacity(ws, { cfg, which, env });
  const cl = cap.verifier_lanes.find(r => r.agent === 'claude');
  const cx = cap.verifier_lanes.find(r => r.agent === 'codex');
  assert.equal(cl.state, 'builder-only');
  assert.equal(cx.state, 'available');
}));

test('capacity: busy when verify lock held', () => mkWs(ws => {
  fs.mkdirSync(path.join(ws, '_metrics', 'verify-locks'), { recursive: true });
  fs.writeFileSync(path.join(ws, '_metrics', 'verify-locks', 'mine.lock'),
    JSON.stringify({ verifier: 'codex', slug: 'mine' }) + '\n');
  const cfg = lanesCfg('codex');
  const cap = classifyVerifierCapacity(ws, {
    cfg, which: () => '/bin/codex', env: { OPENAI_API_KEY: 'x' },
  });
  assert.equal(cap.verifier_lanes[0].state, 'busy');
}));

test('lifecycle: duplicate-stage, legacy, expired builder lease, invalid in-review', () => mkWs(ws => {
  // duplicate
  writeSpec(ws, 'in-progress', 'twins', { fm: { claimed_by: 'claude' } });
  fs.mkdirSync(path.join(ws, 'tests', 'twins'), { recursive: true });

  // legacy awaiting
  writeSpec(ws, 'tests', 'legacy', {
    fm: { claimed_by: 'claude', awaiting_verifier: true, status: 'tests' },
    files: { 'outcome/FEEDBACK.md': 'done\n', 'outcome/BUILDER.diff': 'd\n' },
  });

  // expired builder lease on in-progress with committed-looking lease file
  writeSpec(ws, 'in-progress', 'stale-lease', { fm: { claimed_by: 'claude' } });
  fs.mkdirSync(path.join(ws, '_metrics', 'builder-leases'), { recursive: true });
  fs.writeFileSync(path.join(ws, '_metrics', 'builder-leases', 'stale-lease.json'), JSON.stringify({
    slug: 'stale-lease', actor: 'claude', run_id: 'r1', stage: 'in-progress',
    issued_at: '2026-07-01T00:00:00Z', heartbeat_at: '2026-07-01T00:00:00Z',
    expires_at: new Date(NOW - HOUR).toISOString(), ttl_minutes: 60,
  }, null, 2));

  // invalid in-review (no FEEDBACK)
  writeSpec(ws, 'in-review', 'nofeed', { fm: { status: 'in-review' } });

  const life = classifyLifecycle(ws, { now: NOW, cfg: null });
  const kinds = life.findings.map(f => f.kind).sort();
  assert.ok(kinds.includes('duplicate-stage'));
  assert.ok(kinds.includes('legacy-state'));
  assert.ok(kinds.includes('expired-builder-lease'));
  assert.ok(kinds.includes('invalid-in-review'));
  assert.equal(life.summary.ok, false);
}));

test('diagnoseWorkspace + formatters + healthOpenLoops', () => mkWs(ws => {
  writeSpec(ws, 'in-review', 'nofeed', { fm: { status: 'in-review' } });
  const d = diagnoseWorkspace(ws, {
    cfg: lanesCfg('gemini'),
    which: () => '',
    env: {},
    now: NOW,
  });
  assert.equal(d.lifecycle.summary.ok, false);
  assert.equal(d.capacity.verifier_lanes[0].state, 'unreachable');
  const lifeLines = formatLifecycleFindings(d.lifecycle.findings);
  assert.match(lifeLines.join('\n'), /invalid-in-review/);
  const capLines = formatCapacityRows(d.capacity.verifier_lanes);
  assert.match(capLines.join('\n'), /unreachable|auth-failed|unsafe/);
  const loops = healthOpenLoops(d);
  assert.ok(loops.some(l => l.kind === 'lifecycle' || l.kind === 'capacity'));
}));

test('doctor never mutates the workspace', () => mkWs(ws => {
  writeSpec(ws, 'specs', 'ready-one', { fm: { status: 'ready' } });
  const before = fs.readdirSync(ws, { recursive: true }).sort().join('\n');
  diagnoseWorkspace(ws, { cfg: {}, which: () => '', env: {} });
  const after = fs.readdirSync(ws, { recursive: true }).sort().join('\n');
  assert.equal(after, before);
}));

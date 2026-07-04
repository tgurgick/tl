'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tl.js');
const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });

// Scaffold a throwaway workspace under projects/ (gitignored) with the given
// specs, run the callback with the workspace name, then remove it. Each spec is
// { slug, stage, files } → a <stage-folder>/<slug>/SPEC.md with a Files to touch
// section. stage 'ready' → specs/.
function withWorkspace(specs, fn) {
  const name = 'tl-clitest-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(ROOT, 'projects', name);
  const folderFor = s => (s.stage && s.stage !== 'ready') ? s.stage : 'specs';
  try {
    for (const s of specs) {
      const specDir = path.join(dir, folderFor(s), s.slug);
      fs.mkdirSync(specDir, { recursive: true });
      const status = s.stage && s.stage !== 'ready' ? s.stage : 'ready';
      const files = (s.files || []).map(f => `- \`${f}\``).join('\n');
      const fm = `---\ntitle: "${s.slug}"\ntype: feature\nstatus: ${status}\n---\n\n## Objective\nx\n\n## Scope\n\n### Files to touch\n${files}\n`;
      fs.writeFileSync(path.join(specDir, 'SPEC.md'), fm);
    }
    return fn(name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('unknown command exits non-zero', () => {
  const r = run('frobnicate');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command/);
});

test('help exits 0 and prints usage', () => {
  const r = run('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test('no arguments exits 0 (usage)', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /the throughline CLI/);
});

test('run: holds back a ready spec that conflicts with active in-progress work', () => {
  withWorkspace([
    { slug: 'active-one', stage: 'in-progress', files: ['src/shared.js'] },
    { slug: 'ready-one', stage: 'ready', files: ['src/shared.js'] },
  ], name => {
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Held back for the next run/);
    assert.match(r.stdout, /conflicts with in-progress\/active-one on src\/shared\.js/);
    // the conflicting ready spec is not in the selected batch
    assert.doesNotMatch(r.stdout.split('Held back')[0], /ready-one.*src\/shared\.js/);
  });
});

test('run: named spec conflicting with active work is refused (non-zero)', () => {
  withWorkspace([
    { slug: 'active-two', stage: 'tests', files: ['src/x.js'] },
    { slug: 'ready-two', stage: 'ready', files: ['src/x.js'] },
  ], name => {
    const r = run('run', name, 'ready-two');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /conflicts with tests\/active-two on src\/x\.js/);
  });
});

// Write extra workspace files (NOTES.md, _dispatch/*.json) that the scaffold
// doesn't cover; paths are relative to the workspace dir.
function writeWorkspaceFile(name, rel, content) {
  const f = path.join(ROOT, 'projects', name, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

test('run: pending continuation dispatch resumes in-progress work, holds all ready claims', () => {
  withWorkspace([
    { slug: 'kicked-one', stage: 'in-progress', files: ['src/a.js'] },
    { slug: 'ready-conflict', stage: 'ready', files: ['src/a.js'] },
    { slug: 'ready-free', stage: 'ready', files: ['src/b.js'] },
  ], name => {
    writeWorkspaceFile(name, 'in-progress/kicked-one/NOTES.md',
      '## 2026-07-03 — kicked back\nFix the header casing before resubmitting.\n');
    writeWorkspaceFile(name, '_dispatch/kicked-one.json', JSON.stringify({
      spec: 'kicked-one', mode: 'continuation', stage: 'in-progress',
      notes_path: 'kicked-one/NOTES.md', status: 'pending', created: '2026-07-03',
      reason: 'kicked back: fix the header casing',
    }));
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Continuation dispatches — resume these before fresh claims \(1\)/);
    assert.match(r.stdout, /kicked-one\s+\(in-progress\/kicked-one\/\) \[_dispatch\/kicked-one\.json\]/);
    // the NOTES.md kickback excerpt is in the run banner
    assert.match(r.stdout, /Fix the header casing/);
    // no fresh claim — conflicting AND disjoint ready specs both wait
    assert.doesNotMatch(r.stdout, /Selected batch/);
    assert.match(r.stdout, /ready-conflict.*continuation pending/);
    assert.match(r.stdout, /ready-free.*continuation pending/);
  });
});

test('run: stale or non-pending dispatches do not block the ready queue', () => {
  withWorkspace([
    { slug: 'ready-four', stage: 'ready', files: ['src/c.js'] },
  ], name => {
    // stale: pending but its spec is not in in-progress/ or tests/
    writeWorkspaceFile(name, '_dispatch/gone-spec.json', JSON.stringify({
      spec: 'gone-spec', mode: 'continuation', stage: 'in-progress', status: 'pending',
    }));
    // settled: claimed dispatches are no longer triggers
    writeWorkspaceFile(name, '_dispatch/old-claim.json', JSON.stringify({
      spec: 'old-claim', mode: 'continuation', stage: 'in-progress', status: 'claimed',
    }));
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Stale continuation dispatches/);
    assert.match(r.stdout, /gone-spec.*mark it done/);
    assert.doesNotMatch(r.stdout, /old-claim/);
    // the ready queue still runs
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /ready-four/);
  });
});

test('run: a disjoint ready spec still runs alongside active work', () => {
  withWorkspace([
    { slug: 'active-three', stage: 'in-progress', files: ['src/locked.js'] },
    { slug: 'ready-three', stage: 'ready', files: ['src/free.js'] },
  ], name => {
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /ready-three/);
  });
});

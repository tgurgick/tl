'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tl.js');
const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });
const runWithEnv = (env, ...a) => spawnSync(process.execPath, [BIN, ...a], {
  encoding: 'utf8',
  env: { ...process.env, ...env },
});

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
      const priority = s.priority ? `priority: "${s.priority}"\n` : '';
      const fm = `---\ntitle: "${s.slug}"\ntype: feature\nstatus: ${status}\n${priority}---\n\n## Objective\nx\n\n## Scope\n\n### Files to touch\n${files}\n`;
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

// ---------- fan-out: batch width, holdbacks, cap config, dispatch ordering ----------

test('run: disjoint ready specs fan out together, whole batch claimed before work', () => {
  withWorkspace([
    { slug: 'fan-a', stage: 'ready', files: ['src/a.js'] },
    { slug: 'fan-b', stage: 'ready', files: ['src/b.js'] },
  ], name => {
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Selected batch \(2\)/);
    // the claim block lists every folder move, before the per-spec brief
    assert.match(r.stdout, /Claim the whole batch first/);
    assert.match(r.stdout, /specs\/fan-a\/ → in-progress\/fan-a\//);
    assert.match(r.stdout, /specs\/fan-b\/ → in-progress\/fan-b\//);
    assert.ok(r.stdout.indexOf('Claim the whole batch first') < r.stdout.indexOf('Per-spec brief'));
  });
});

test('run: same-file ready specs — the loser is held with a reason naming the winner', () => {
  withWorkspace([
    { slug: 'dup-a', stage: 'ready', files: ['src/dup.js'] },
    { slug: 'dup-b', stage: 'ready', files: ['src/dup.js'] },
  ], name => {
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /Held back for the next run/);
    assert.match(r.stdout, /dup-b.*file conflict on src\/dup\.js with dup-a/);
  });
});

test('run: TRIAGE.yml run.cap bounds the batch width', () => {
  withWorkspace([
    { slug: 'cap-a', stage: 'ready', files: ['src/a.js'] },
    { slug: 'cap-b', stage: 'ready', files: ['src/b.js'] },
    { slug: 'cap-c', stage: 'ready', files: ['src/c.js'] },
  ], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', 'run:\n  cap: 2\n');
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Selected batch \(2\)/);
    assert.match(r.stdout, /batch capped at 2/);
  });
});

test('run: multiple pending continuations resume as an ordered, conflict-checked batch', () => {
  withWorkspace([
    { slug: 'resume-low', stage: 'in-progress', files: ['src/low.js'], priority: 'p2' },
    { slug: 'resume-hot', stage: 'in-progress', files: ['src/hot.js'], priority: 'p0' },
    { slug: 'resume-clash', stage: 'tests', files: ['src/hot.js'], priority: 'p2' },
  ], name => {
    for (const slug of ['resume-low', 'resume-hot', 'resume-clash']) {
      writeWorkspaceFile(name, '_dispatch/' + slug + '.json', JSON.stringify({
        spec: slug, mode: 'continuation', status: 'pending', created: '2026-07-03',
      }));
    }
    const r = run('run', name);
    assert.equal(r.status, 0);
    // two resume; the scope-overlapping third is held, its dispatch stays pending
    assert.match(r.stdout, /Continuation dispatches — resume these before fresh claims \(2\)/);
    assert.match(r.stdout, /resume-clash.*file conflict on src\/hot\.js with resume-hot.*dispatch stays pending/);
    // dispatch ordering: the p0 continuation outranks the p2 one
    assert.ok(r.stdout.indexOf('### resume-hot') < r.stdout.indexOf('### resume-low'));
    // continuations still outrank fresh claims entirely
    assert.doesNotMatch(r.stdout, /Selected batch/);
  });
});

function withSyncRulesFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-sync-rules-'));
  try {
    const skillDir = path.join(dir, 'skills', 'sample');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: sample',
      'description: Sample skill does one thing. Extra routing details are ignored.',
      '---',
      '',
      '# /tl sample',
      '',
    ].join('\n'));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readRealRuleFiles() {
  return {
    agents: fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'),
    cursor: fs.readFileSync(path.join(ROOT, '.cursor', 'rules', 'tl.mdc'), 'utf8'),
    gemini: fs.readFileSync(path.join(ROOT, 'GEMINI.md'), 'utf8'),
  };
}

test('sync-rules --check succeeds when generated fixture outputs match without mutating repo rule files', () => {
  withSyncRulesFixture(root => {
    const before = readRealRuleFiles();
    const write = runWithEnv({ TL_SYNC_RULES_ROOT: root }, 'sync-rules');
    assert.equal(write.status, 0, write.stderr);
    assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(root, '.cursor', 'rules', 'tl.mdc')));
    assert.ok(fs.existsSync(path.join(root, 'GEMINI.md')));

    const check = runWithEnv({ TL_SYNC_RULES_ROOT: root }, 'sync-rules', '--check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /generated rule files are up to date/);
    assert.deepEqual(readRealRuleFiles(), before);
  });
});

test('sync-rules --check exits non-zero and lists changed or missing generated files', () => {
  withSyncRulesFixture(root => {
    const write = runWithEnv({ TL_SYNC_RULES_ROOT: root }, 'sync-rules');
    assert.equal(write.status, 0, write.stderr);
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nmanual drift\n');
    fs.rmSync(path.join(root, 'GEMINI.md'));

    const check = runWithEnv({ TL_SYNC_RULES_ROOT: root }, 'sync-rules', '--check');
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /generated rule files are out of date/);
    assert.match(check.stderr, /AGENTS\.md/);
    assert.match(check.stderr, /GEMINI\.md/);
    assert.doesNotMatch(check.stderr, /\.cursor\/rules\/tl\.mdc/);
  });
});

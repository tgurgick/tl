'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'tl.js');

// Optional pretest sweep: remove stray tl-clitest-* left under the real
// checkout's projects/ (e.g. from a hard-killed run before tmpdir isolation).
(function sweepStrayCliTestWorkspaces() {
  const projects = path.join(REPO_ROOT, 'projects');
  if (!fs.existsSync(projects)) return;
  const hourMs = 60 * 60 * 1000;
  const now = Date.now();
  for (const name of fs.readdirSync(projects)) {
    if (!name.startsWith('tl-clitest-')) continue;
    const p = path.join(projects, name);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs >= hourMs) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
})();

// Active scratch TL_ROOT for the current withWorkspace() callback — run() and
// writeWorkspaceFile() route through it so the real checkout's projects/ stays
// untouched.
let activeTestRoot = null;

const run = (...a) => spawnSync(process.execPath, [BIN, ...a], {
  encoding: 'utf8',
  env: activeTestRoot
    ? { ...process.env, TL_ROOT: activeTestRoot }
    : process.env,
});
const runWithEnv = (env, ...a) => spawnSync(process.execPath, [BIN, ...a], {
  encoding: 'utf8',
  env: { ...process.env, ...(activeTestRoot ? { TL_ROOT: activeTestRoot } : {}), ...env },
});

// Scaffold a throwaway workspace under a tmpdir TL_ROOT (never the real
// checkout's projects/). Specs: { slug, stage, files } → <stage>/<slug>/SPEC.md.
// stage 'ready' → specs/.
function withWorkspace(specs, fn) {
  const name = 'tl-clitest-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-clitest-root-'));
  const dir = path.join(scratch, 'projects', name);
  const folderFor = s => (s.stage && s.stage !== 'ready') ? s.stage : 'specs';
  activeTestRoot = scratch;
  try {
    // Default identity: PROJECT.md repo points at this checkout (the
    // tl-developing-tl case), so the claim-time containment guard is exempt
    // and the scaffold's repo-less code specs stay eligible.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: "${name}"\nrepo: "${REPO_ROOT}"\n---\n`);
    for (const s of specs) {
      const specDir = path.join(dir, folderFor(s), s.slug);
      fs.mkdirSync(specDir, { recursive: true });
      const status = s.status || (s.stage && s.stage !== 'ready' ? s.stage : 'ready');
      const files = (s.files || []).map(f => `- \`${f}\``).join('\n');
      const priority = s.priority ? `priority: "${s.priority}"\n` : '';
      const repo = s.repo ? `repo: "${s.repo}"\n` : '';
      const extra = s.frontmatter ? s.frontmatter + '\n' : '';
      const fm = `---\ntitle: "${s.slug}"\ntype: feature\nstatus: ${status}\n${priority}${repo}${extra}---\n\n## Objective\nx\n\n## Scope\n\n### Files to touch\n${files}\n`;
      fs.writeFileSync(path.join(specDir, 'SPEC.md'), fm);
    }
    return fn(name);
  } finally {
    activeTestRoot = null;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function workspacePath(name, ...parts) {
  const root = activeTestRoot || REPO_ROOT;
  return path.join(root, 'projects', name, ...parts);
}

test('unknown command exits non-zero', () => {
  const r = run('frobnicate');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command/);
});

test('help exits 0 and prints usage', () => {
  const r = run('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /the throughline CLI/);
  assert.match(r.stdout, /Four verbs/);
  assert.match(r.stdout, /tl up\s+\[workspace\]/);
});

test('no arguments exits 0 (usage)', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /the throughline CLI/);
});

test('withWorkspace scaffolds under TL_ROOT tmpdir, never real projects/', () => {
  withWorkspace([{ slug: 'iso-one', files: ['a.js'] }], name => {
    assert.ok(activeTestRoot);
    assert.ok(activeTestRoot.startsWith(os.tmpdir()));
    assert.ok(fs.existsSync(workspacePath(name, 'specs', 'iso-one', 'SPEC.md')));
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'projects', name)));
    const r = run('resume', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /iso-one|READY|ready/i);
  });
});

test('TL_ROOT and --root resolve the projects root', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-clitest-rootflag-'));
  try {
    const name = 'ws-rootflag';
    const dir = path.join(scratch, 'projects', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: "${name}"\nrepo: "${REPO_ROOT}"\n---\n`);
    const viaEnv = runWithEnv({ TL_ROOT: scratch }, 'resume', name);
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.match(viaEnv.stdout, new RegExp('SNAPSHOT: ' + name));
    const viaFlag = spawnSync(process.execPath, [BIN, '--root', scratch, 'resume', name], {
      encoding: 'utf8',
      env: { ...process.env, TL_ROOT: '' },
    });
    assert.equal(viaFlag.status, 0, viaFlag.stderr);
    assert.match(viaFlag.stdout, new RegExp('SNAPSHOT: ' + name));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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
  const f = workspacePath(name, rel);
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

test('run --agent: other-lane continuation is filtered out; lane falls through to ready', () => {
  withWorkspace([
    { slug: 'kicked-claude', stage: 'in-progress', files: ['src/a.js'],
      frontmatter: 'claimed_by: claude' },
    { slug: 'ready-codex', stage: 'ready', files: ['src/b.js'],
      frontmatter: 'agent: codex' },
  ], name => {
    writeWorkspaceFile(name, 'in-progress/kicked-claude/NOTES.md',
      '## 2026-07-12 — kicked back\nClaude owns this resume.\n');
    writeWorkspaceFile(name, '_dispatch/kicked-claude.json', JSON.stringify({
      spec: 'kicked-claude', mode: 'continuation', stage: 'in-progress',
      notes_path: 'kicked-claude/NOTES.md', status: 'pending', created: '2026-07-12',
      reason: 'kicked back',
    }));
    const r = run('run', name, '--agent', 'codex');
    assert.equal(r.status, 0);
    // other-lane continuation noted, not resumed
    assert.match(r.stdout, /owned by claude/);
    assert.doesNotMatch(r.stdout, /Continuation dispatches — resume these before fresh claims/);
    // falls through to this lane's ready queue
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /ready-codex/);
  });
});

test('run --agent: own-lane continuation still resumed before ready claims', () => {
  withWorkspace([
    { slug: 'kicked-codex', stage: 'in-progress', files: ['src/a.js'],
      frontmatter: 'claimed_by: codex' },
    { slug: 'ready-codex-two', stage: 'ready', files: ['src/b.js'],
      frontmatter: 'agent: codex' },
  ], name => {
    writeWorkspaceFile(name, 'in-progress/kicked-codex/NOTES.md',
      '## 2026-07-12 — kicked back\nFix the footer before resubmitting.\n');
    writeWorkspaceFile(name, '_dispatch/kicked-codex.json', JSON.stringify({
      spec: 'kicked-codex', mode: 'continuation', stage: 'in-progress',
      notes_path: 'kicked-codex/NOTES.md', status: 'pending', created: '2026-07-12',
      reason: 'kicked back: fix the footer',
    }));
    const r = run('run', name, '--agent', 'codex');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Continuation dispatches — resume these before fresh claims \(1\)/);
    assert.match(r.stdout, /kicked-codex/);
    assert.match(r.stdout, /Fix the footer/);
    assert.doesNotMatch(r.stdout, /Selected batch/);
    assert.match(r.stdout, /ready-codex-two.*continuation pending/);
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

// ---------- claim-time asset preflight (repo readiness) ----------

test('run: a ready spec whose repo is a void is held with a concrete reason, never claimed', () => {
  withWorkspace([
    { slug: 'void-repo', stage: 'ready', files: ['src/a.js'], repo: '/nonexistent-tl-cli-void' },
    { slug: 'sound-repo', stage: 'ready', files: ['src/b.js'] },
  ], name => {
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /sound-repo/);
    assert.match(r.stdout, /Held back for the next run/);
    assert.match(r.stdout, /void-repo.*repo not found: \/nonexistent-tl-cli-void/);
    // the void-repo spec never appears in the claim block
    assert.doesNotMatch(r.stdout, /specs\/void-repo\/ → in-progress/);
  });
});

test('run: named spec with a void repo is refused (non-zero, reason on stderr)', () => {
  withWorkspace([
    { slug: 'named-void', stage: 'ready', files: ['src/a.js'], repo: '/nonexistent-tl-cli-void' },
  ], name => {
    const r = run('run', name, 'named-void');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /repo not found: \/nonexistent-tl-cli-void/);
  });
});

test('run: containment — a repo-less code spec in a non-tl workspace is held, not claimed', () => {
  withWorkspace([
    { slug: 'homeless', stage: 'ready', files: ['src/a.js'] },
  ], name => {
    // re-point the workspace at a project repo elsewhere → not the tl-developing-tl case
    writeWorkspaceFile(name, 'PROJECT.md', '---\nname: "x"\nrepo: "/repos/some-project"\n---\n');
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /homeless.*no project repo — refusing to work in the tl checkout/);
    assert.doesNotMatch(r.stdout, /Selected batch \(1\)/);
  });
});

test('run: a repo-held pending continuation stays pending with the reason in the brief', () => {
  withWorkspace([
    { slug: 'kicked-void', stage: 'in-progress', files: ['src/a.js'], repo: '/nonexistent-tl-cli-void' },
  ], name => {
    writeWorkspaceFile(name, '_dispatch/kicked-void.json', JSON.stringify({
      spec: 'kicked-void', mode: 'continuation', stage: 'in-progress',
      status: 'pending', created: '2026-07-11',
    }));
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Continuation dispatches — resume these before fresh claims \(0\)/);
    assert.match(r.stdout, /kicked-void.*repo not found: \/nonexistent-tl-cli-void.*dispatch stays pending/);
  });
});

// ---------- interactive claim → experiment auto-initiation (parity with worker) ----------

const DIAL_ON_TRIAGE = [
  'experiments:',
  '  enabled: true',
  '  auto_initiate: true',
  '  candidates: [claude, codex]',
  '  judge: gemini',
  '  budget_usd: 2.5',
  '  timeout_minutes: 30',
  '',
].join('\n');

function readAutoInitLog(name) {
  const f = workspacePath(name, '_metrics', 'auto-initiation-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function experimentDirsFor(name) {
  const d = workspacePath(name, '_experiments');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(e => e.startsWith('exp-'));
}

test('run auto-init: dial off is fully inert — brief prints, zero experiment artifacts', () => {
  withWorkspace([{ slug: 'ready-a', files: ['a.js'] }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', 'goals: []\n');
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /Per-spec brief/);
    assert.equal(fs.existsSync(workspacePath(name, '_experiments')), false);
    assert.equal(fs.existsSync(workspacePath(name, '_metrics', 'auto-initiation-log.jsonl')), false);
  });
});

test('run auto-init: dial on queues a policy experiment after a fresh interactive claim', () => {
  withWorkspace([{ slug: 'ready-a', files: ['a.js'] }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', DIAL_ON_TRIAGE);
    const r = run('run', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /Claim the whole batch first/);
    assert.match(r.stdout, /Per-spec brief/);
    assert.match(r.stdout, /auto-initiated experiment exp-/);

    const exps = experimentDirsFor(name);
    assert.equal(exps.length, 1);
    const alog = readAutoInitLog(name);
    assert.equal(alog.length, 1);
    assert.equal(alog[0].decision, 'initiated');
    assert.equal(alog[0].initiated_by, 'policy');
    assert.equal(alog[0].experiment_id, exps[0]);
    assert.equal(alog[0].spec, 'specs/ready-a/');

    const { parseFrontmatter } = require('../lib/parse');
    const meta = parseFrontmatter(
      fs.readFileSync(workspacePath(name, '_experiments', exps[0], 'EXPERIMENT.md'), 'utf8')).meta;
    assert.equal(meta.initiated_by, 'policy');
  });
});

test('run auto-init: continuations never initiate — resume path leaves zero artifacts', () => {
  withWorkspace([
    { slug: 'kicked-one', stage: 'in-progress', files: ['src/a.js'] },
    { slug: 'ready-free', stage: 'ready', files: ['src/b.js'] },
  ], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', DIAL_ON_TRIAGE);
    writeWorkspaceFile(name, 'in-progress/kicked-one/NOTES.md',
      '## 2026-07-14 — kicked back\nFix the footer.\n');
    writeWorkspaceFile(name, '_dispatch/kicked-one.json', JSON.stringify({
      spec: 'kicked-one', mode: 'continuation', stage: 'in-progress',
      notes_path: 'kicked-one/NOTES.md', status: 'pending', created: '2026-07-14',
      reason: 'kicked back',
    }));
    const r = run('run', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Continuation dispatches — resume these before fresh claims \(1\)/);
    assert.doesNotMatch(r.stdout, /Selected batch/);
    assert.doesNotMatch(r.stdout, /auto-initiated experiment/);
    assert.equal(experimentDirsFor(name).length, 0);
    assert.equal(fs.existsSync(workspacePath(name, '_metrics', 'auto-initiation-log.jsonl')), false);
  });
});

test('run auto-init: dry-run prints the brief but never initiates', () => {
  withWorkspace([{ slug: 'ready-a', files: ['a.js'] }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', DIAL_ON_TRIAGE);
    const r = run('run', name, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /Per-spec brief/);
    assert.doesNotMatch(r.stdout, /auto-initiated experiment/);
    assert.equal(experimentDirsFor(name).length, 0);
    assert.equal(fs.existsSync(workspacePath(name, '_metrics', 'auto-initiation-log.jsonl')), false);
  });
});

test('run auto-init: failure-silent — broken experiment path leaves the brief intact', () => {
  withWorkspace([{ slug: 'ready-a', files: ['a.js'] }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', DIAL_ON_TRIAGE);
    // queueExperiment throws ENOTDIR when _experiments is a file
    writeWorkspaceFile(name, '_experiments', 'not a directory');
    const r = run('run', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Selected batch \(1\)/);
    assert.match(r.stdout, /Per-spec brief/);
    assert.match(r.stdout, /auto-initiation failed for specs\/ready-a\/ \(canonical claim unaffected\)/);
    const err = readAutoInitLog(name).pop();
    assert.equal(err.decision, 'error');
    assert.match(err.reason, /auto-initiation failed/);
  });
});

test('resume: a blocked spec surfaces its blocked_reason in the open loops', () => {
  withWorkspace([
    { slug: 'stuck', stage: 'tests', status: 'blocked', files: ['src/a.js'],
      frontmatter: 'blocked_reason: "target repo empty — waiting on bootstrap"' },
  ], name => {
    const r = run('resume', name);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /blocked spec: stuck \(tests\/stuck\/\) — target repo empty — waiting on bootstrap/);
  });
});

// ---------- tl up (alias: open) ----------

test('up --dry-run: absent automation is inert — UI plan + next action, no schedule, no spawn', () => {
  withWorkspace([{ slug: 'ready-a', files: ['a.js'] }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', 'goals: []\n');
    const r = run('up', name, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not configured|no behavior change/i);
    assert.match(r.stdout, /Next human action|ready/i);
    assert.doesNotMatch(r.stdout, /wrote .*LaunchAgents/);
    assert.doesNotMatch(r.stdout, /loaded via launchctl/);
    // dry-run must never claim/move specs
    assert.ok(fs.existsSync(workspacePath(name, 'specs', 'ready-a')));
  });
});

test('open alias: dry-run still works (short-lived synonym of up)', () => {
  withWorkspace([{ slug: 'ready-alias', files: ['a.js'] }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', 'goals: []\n');
    const r = run('open', name, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /===== UP:/);
    assert.match(r.stdout, /Next human action|ready/i);
  });
});

test('up: enabled with missing lane command fails loudly with a fix hint', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'lanes: {}',
      'automation:',
      '  enabled: true',
      '  lanes: [claude]',
      '',
    ].join('\n'));
    const r = run('up', name, '--dry-run');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /lanes\.claude\.command is missing|automation profile is misconfigured/);
    assert.match(r.stderr, /fix:/);
  });
});

test('up --dry-run: enabled profile prints schedule plan without launching agent CLIs or launchctl', () => {
  withWorkspace([{ slug: 'ready-b', files: ['b.js'] }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'lanes:',
      '  claude:',
      '    command: "echo CLAUDE_SHOULD_NOT_RUN"',
      'automation:',
      '  enabled: true',
      '  interval_minutes: 15',
      '  lanes: [claude]',
      '  verify: false',
      '  experiment: off',
      '',
    ].join('\n'));
    const r = run('up', name, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run — would write:/);
    assert.match(r.stdout, /dry run — would run:\s+launchctl/);
    assert.match(r.stdout, /nothing written, nothing loaded, no agent spawned/);
    assert.match(r.stdout, /tl-worker\.js/);
    // agent CLI from the lane command must not appear as something that ran
    assert.doesNotMatch(r.stdout, /CLAUDE_SHOULD_NOT_RUN/);
    assert.doesNotMatch(r.stdout, /loaded via launchctl/);
    assert.match(r.stdout, /## Lane availability/);
    assert.match(r.stdout, /claude\s+(idle|unreachable)/);
  });
});

test('up --dry-run: PAUSE reports paused', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'lanes:',
      '  claude:',
      '    command: "claude -p {prompt_file}"',
      'automation:',
      '  enabled: true',
      '  lanes: [claude]',
      '',
    ].join('\n'));
    writeWorkspaceFile(name, 'PAUSE', '');
    const r = run('up', name, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PAUSED|status: paused/i);
  });
});

test('up --print-schedule: emits cron + launchd without installing', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'lanes:',
      '  claude:',
      '    command: "claude -p {prompt_file}"',
      'automation:',
      '  enabled: true',
      '  lanes: [claude]',
      '  verify: true',
      'verification:',
      '  verifier_lanes:',
      '    gemini:',
      '      agent: gemini',
      '      mode: verify',
      '      isolated: true',
      '      sandbox: required',
      '      allow_network: false',
      '      command: [agy]',
      '',
    ].join('\n'));
    const r = run('up', name, '--print-schedule');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Option A — cron/);
    assert.match(r.stdout, /Option B — launchd/);
    assert.match(r.stdout, /com\.tl\.open\./);
    assert.match(r.stdout, /tl-worker\.js .* --agent claude/);
    assert.match(r.stdout, /tl-worker\.js .* --mode verify/);
    assert.doesNotMatch(r.stdout, /wrote |loaded via launchctl/);
  });
});

test('up --dry-run: experiment off states inert; no drain in schedule', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'lanes:',
      '  claude:',
      '    command: "claude -p {prompt_file}"',
      'automation:',
      '  enabled: true',
      '  lanes: [claude]',
      '  experiment: off',
      '',
    ].join('\n'));
    const r = run('up', name, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /experiment: off \(inert/);
    assert.doesNotMatch(r.stdout, /experiment drain/);
    assert.doesNotMatch(r.stdout, /experiment (apply|select)/);
  });
});

test('up --dry-run: experiment drain prints exact drain commands; never auto-apply', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'lanes:',
      '  claude:',
      '    command: "claude -p {prompt_file}"',
      '  codex:',
      '    command: "codex exec -"',
      'automation:',
      '  enabled: true',
      '  lanes: [claude, codex]',
      '  experiment: drain',
      '',
    ].join('\n'));
    const r = run('up', name, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /experiment: drain/);
    assert.match(r.stdout, /will run:.*experiment drain --agent claude/);
    assert.match(r.stdout, /will run:.*experiment drain --agent codex/);
    assert.match(r.stdout, /never selects or applies winners/);
    assert.match(r.stdout, /experiment drain/);
    assert.doesNotMatch(r.stdout, /experiment (apply|select|reject)/);
  });
});

test('up: invalid experiment value fails loudly with supported-values hint', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'lanes:',
      '  claude:',
      '    command: "claude -p {prompt_file}"',
      'automation:',
      '  enabled: true',
      '  lanes: [claude]',
      '  experiment: shadow',
      '',
    ].join('\n'));
    const r = run('up', name, '--dry-run');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a supported value|automation profile is misconfigured/);
    assert.match(r.stderr, /off, drain|fix:/);
  });
});

test('tl help groups commands under steer / run / review / learn', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /steer — shape what to build/);
  assert.match(r.stdout, /run — start it/);
  assert.match(r.stdout, /review — sign off/);
  assert.match(r.stdout, /learn — where am I/);
  assert.match(r.stdout, /tl up\s+\[workspace\]/);
  assert.match(r.stdout, /\(alias: open\)/);
  assert.doesNotMatch(r.stdout, /^Usage:$/m);
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
    agents: fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8'),
    cursor: fs.readFileSync(path.join(REPO_ROOT, '.cursor', 'rules', 'tl.mdc'), 'utf8'),
    gemini: fs.readFileSync(path.join(REPO_ROOT, 'GEMINI.md'), 'utf8'),
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

test('generated rules state the universal done/ ceiling — builder and verifier both stop at in-review', () => {
  withSyncRulesFixture(root => {
    const write = runWithEnv({ TL_SYNC_RULES_ROOT: root }, 'sync-rules');
    assert.equal(write.status, 0, write.stderr);
    for (const rel of ['AGENTS.md', path.join('.cursor', 'rules', 'tl.mdc'), 'GEMINI.md']) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.match(text, /never moves any spec to done\/ — its own or another's/, `${rel} must make the ceiling universal`);
      assert.match(text, /builder and verifier both stop at in-review\//, `${rel} must name both roles`);
      assert.doesNotMatch(text, /never signs off its own work/, `${rel} must not carry the old own-work loophole wording`);
    }
  });
});

// ---------- tl sync check (offline sync.jira.map validation) ----------

test('sync check: valid map prints OK summary with provenance and exits 0', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'sync:',
      '  jira:',
      '    url: "https://acme.atlassian.net"',
      '    project: "PROJ"',
      '    map:',
      '      bug: spec',
      '      spike:',
      '        to: spec',
      '        type: research',
      '        tags: [spike]',
      '      sub-task: ignore',
      '',
    ].join('\n'));
    const r = run('sync', 'check', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SYNC CHECK: /);
    assert.match(r.stdout, /jira: url https:\/\/acme\.atlassian\.net · project PROJ/);
    assert.match(r.stdout, /map: OK — 6 effective entries/);
    // defaults still in effect, workspace override keeps the default TL type
    assert.match(r.stdout, /epic → intent\s+\[default\]/);
    assert.match(r.stdout, /bug → spec \(type: bug\)\s+\[override\]/);
    // extensions carry their hints and provenance
    assert.match(r.stdout, /spike → spec \(type: research, tags: \[spike\]\)\s+\[workspace\]/);
    assert.match(r.stdout, /sub-task → ignore\s+\[workspace\]/);
    assert.match(r.stdout, /defaults in effect: 3 untouched · 1 overridden · 2 workspace-added/);
    assert.match(r.stdout, /no JIRA call was made/);
  });
});

test('sync check: absent workspace map is valid — exactly the shipped defaults', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'sync:',
      '  jira:',
      '    url: ""',
      '    project: ""',
      '',
    ].join('\n'));
    const r = run('sync', 'check', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /map: OK — 4 effective entries/);
    assert.match(r.stdout, /defaults in effect: 4 untouched · 0 overridden · 0 workspace-added/);
    assert.match(r.stdout, /shipped defaults are the whole contract/);
    // unset url/project is informational, never an error for the offline check
    assert.match(r.stdout, /url \(unset\) · project \(unset\)/);
  });
});

test('sync check: invalid map lists every offending key with its fix hint, exits non-zero', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'sync:',
      '  jira:',
      '    map:',
      '      spike:',
      '        to: spec',
      '        type: done',
      '      sub-task: sideways',
      '      incident:',
      '        to: ignore',
      '        tags: [oops]',
      '',
    ].join('\n'));
    const r = run('sync', 'check', name);
    assert.notEqual(r.status, 0);
    // every offending key appears, in the bridge's paste-ready hint style
    assert.match(r.stdout, /map: INVALID — 3 entries rejected/);
    assert.match(r.stdout, /sync\.jira\.map\.spike: type "done" is not a TL spec type — use one of: feature, bug, tech_debt, research/);
    assert.match(r.stdout, /sync\.jira\.map\.sub-task: "sideways" is not a valid target — use one of: intent, spec, ignore/);
    assert.match(r.stdout, /sync\.jira\.map\.incident: "type"\/"tags" hints only apply to "to: spec"/);
    assert.match(r.stdout, /Fix the entries above/);
    assert.match(r.stderr, /sync\.jira\.map is invalid \(3 errors\)/);
  });
});

test('sync check: missing sync section is a calm not-configured, exit 0', () => {
  withWorkspace([], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', 'goals: []\n');
    const r = run('sync', 'check', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sync is not configured — no sync\.jira section/);
    assert.match(r.stdout, /skills\/sync\/SKILL\.md/);
  });
});

test('sync check: no TRIAGE.yml at all is also calm not-configured, exit 0', () => {
  withWorkspace([], name => {
    const r = run('sync', 'check', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sync is not configured/);
  });
});

test('sync check: unknown workspace fails with the standard error, non-zero', () => {
  withWorkspace([], () => {
    const r = run('sync', 'check', 'no-such-workspace');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown workspace "no-such-workspace"/);
  });
});

test('sync: missing or unknown subcommand prints usage, non-zero', () => {
  withWorkspace([], () => {
    for (const args of [['sync'], ['sync', 'frobnicate']]) {
      const r = run(...args);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Usage: tl sync check \[workspace\]/);
    }
  });
});

test('usage: sync check is listed under steer, four-verb grouping intact', () => {
  const r = run('help');
  assert.equal(r.status, 0, r.stderr);
  const steer = r.stdout.indexOf('steer — shape what to build');
  const runIdx = r.stdout.indexOf('run — start it');
  const syncIdx = r.stdout.indexOf('tl sync check [workspace]');
  assert.ok(steer >= 0 && runIdx > steer && syncIdx > steer && syncIdx < runIdx,
    'tl sync check must sit inside the steer group');
});

test('tl verify --dispatch writes verify-request artifact (never spawns)', () => {
  withWorkspace([{
    slug: 'await-me',
    stage: 'tests',
    status: 'blocked',
    frontmatter: 'claimed_by: cursor\nawaiting_verifier: true',
    files: ['x.js'],
  }], name => {
    writeWorkspaceFile(name, 'TRIAGE.yml', [
      'verification:',
      '  verifier_lanes:',
      '    gemini:',
      '      agent: gemini',
      '      isolated: true',
      '      sandbox: required',
      '      allow_network: false',
      '      command: [agy]',
      '',
    ].join('\n'));
    const r = run('verify', name, 'await-me', '--dispatch', '--target-lane', 'gemini');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Wrote verify request/);
    assert.match(r.stdout, /never spawn/);
    const reqDir = workspacePath(name, '_metrics', 'verify-requests');
    const files = fs.readdirSync(reqDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const body = JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), 'utf8'));
    assert.equal(body.spec, 'await-me');
    assert.equal(body.target_lane, 'gemini');
    assert.equal(body.status, 'pending');
  });
});

test('tl verify status surfaces queued and human-decision-required', () => {
  withWorkspace([{
    slug: 'hdr',
    stage: 'tests',
    status: 'blocked',
    frontmatter: 'claimed_by: cursor\nawaiting_verifier: false\nverifier_status: human-decision-required\nblocked_reason: "verifier proposed a mutation — human decision required"',
    files: ['x.js'],
  }], name => {
    const notes = workspacePath(name, 'tests', 'hdr', 'NOTES.md');
    fs.writeFileSync(notes, '## Verifier mutation proposal — human decision required\n\n- `x.js`: fix it\n');
    const r = run('verify', name);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /human-decision-required|Human decision required/i);
    assert.match(r.stdout, /authorize-fix-forward/);
    assert.match(r.stdout, /kick-back/);
  });
});

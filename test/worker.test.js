'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const {
  laneConfig, continuationEligible, pickWork, repoPreflight,
  buildCommand, promptOneLine, checkLock, lockPathFor,
  readWorkspaceSpecs, readPendingContinuations, tick, validLaneName,
} = require('../lib/worker');

// build a spec object shaped like readWorkspaceSpecs produces
function mk(slug, { stage = 'ready', priority = 'p2', type = 'feature', agent, claimedBy, files, mtime = 0 } = {}) {
  const folder = stage === 'ready' ? 'specs' : stage;
  const body = files !== undefined
    ? '## Scope\n\n### Files to touch\n' + files.map(f => `- \`${f}\``).join('\n') + '\n'
    : '## Objective\nx\n';
  const meta = { priority, type };
  if (agent) meta.agent = agent;
  if (claimedBy) meta.claimed_by = claimedBy;
  return { stage, path: `${folder}/${slug}/`, meta, body, mtime };
}

function cont(spec) { return { file: '_dispatch/' + spec.path.split('/')[1] + '.json', dispatch: { mode: 'continuation', status: 'pending' }, spec }; }

// ---------- lane config ----------

test('laneConfig: reads command + lock timeout, defaults timeout to 120m', () => {
  const cfg = { lanes: { claude: { command: 'claude -p {prompt_file}' }, codex: { command: 'codex exec -', lock_timeout_minutes: 30 } } };
  assert.deepEqual(laneConfig(cfg, 'claude'), { command: 'claude -p {prompt_file}', lockTimeoutMinutes: 120 });
  assert.equal(laneConfig(cfg, 'codex').lockTimeoutMinutes, 30);
});

test('laneConfig: unconfigured / malformed lanes are null', () => {
  assert.equal(laneConfig({}, 'claude'), null);
  assert.equal(laneConfig({ lanes: {} }, 'claude'), null);
  assert.equal(laneConfig({ lanes: { claude: {} } }, 'claude'), null);
  assert.equal(laneConfig({ lanes: { claude: { command: '  ' } } }, 'claude'), null);
});

test('validLaneName: accepts path-safe lane keys only', () => {
  assert.equal(validLaneName('claude'), true);
  assert.equal(validLaneName('codex-1'), true);
  assert.equal(validLaneName('cursor.team_a'), true);
  assert.equal(validLaneName('../codex'), false);
  assert.equal(validLaneName('codex/lane'), false);
  assert.equal(validLaneName('Codex'), false);
  assert.equal(validLaneName(''), false);
});

// ---------- continuation ownership ----------

test('continuationEligible: claimed_by binds — agent:any never overrides a claim', () => {
  const claimed = mk('a', { stage: 'in-progress', agent: 'any', claimedBy: 'claude' });
  assert.equal(continuationEligible(claimed, 'claude'), true);
  assert.equal(continuationEligible(claimed, 'codex'), false);
});

test('continuationEligible: unclaimed falls back to the routing lane (agent: <lane> or any)', () => {
  assert.equal(continuationEligible(mk('a', { stage: 'in-progress', agent: 'any' }), 'codex'), true);
  assert.equal(continuationEligible(mk('a', { stage: 'in-progress' }), 'codex'), true);          // absent = any
  assert.equal(continuationEligible(mk('a', { stage: 'in-progress', agent: 'claude' }), 'codex'), false);
  assert.equal(continuationEligible(mk('a', { stage: 'in-progress', agent: 'claude' }), 'claude'), true);
});

// ---------- selection order ----------

test('pickWork: continuation beats ready — one tick, one pick', () => {
  const kicked = mk('kicked', { stage: 'in-progress', claimedBy: 'claude', files: ['a.js'] });
  const specs = [kicked, mk('fresh', { files: ['b.js'] })];
  const pick = pickWork({ specs, continuations: [cont(kicked)], lane: 'claude' });
  assert.equal(pick.kind, 'continuation');
  assert.equal(pick.picked, '_dispatch/kicked.json');
});

test('pickWork: lane mismatch — a codex tick ignores a claude-claimed continuation and does NOT claim fresh work', () => {
  const kicked = mk('kicked', { stage: 'in-progress', claimedBy: 'claude', files: ['a.js'] });
  const specs = [kicked, mk('fresh', { files: ['b.js'] })];
  // tl run holds the ready queue behind any pending continuation, so the codex
  // tick must not spawn at all — the brief would be claude's resume.
  const pick = pickWork({ specs, continuations: [cont(kicked)], lane: 'codex' });
  assert.equal(pick.picked, null);
  assert.equal(pick.reason, 'no_continuation');
});

test('pickWork: no continuations → one conflict-free ready spec in this lane', () => {
  const specs = [
    mk('other-lane', { agent: 'codex', files: ['a.js'], priority: 'p0' }),
    mk('mine', { agent: 'claude', files: ['b.js'], priority: 'p1' }),
    mk('anyone', { files: ['c.js'], priority: 'p2' }),
  ];
  const pick = pickWork({ specs, continuations: [], lane: 'claude' });
  assert.equal(pick.kind, 'ready');
  assert.equal(pick.picked, 'specs/mine/');   // p1 beats p2; p0 is another lane's
});

test('pickWork: active-work conflicts hold ready specs (batch discipline)', () => {
  const specs = [
    mk('active', { stage: 'in-progress', files: ['shared.js'] }),
    mk('collides', { files: ['shared.js'] }),
  ];
  const pick = pickWork({ specs, continuations: [], lane: 'claude' });
  assert.equal(pick.picked, null);
  assert.equal(pick.reason, 'no_ready');
});

test('pickWork: dirty git paths hold a colliding ready spec', () => {
  const specs = [mk('collides', { files: ['ui/index.html'] })];
  const pick = pickWork({ specs, continuations: [], lane: 'claude', dirtyPaths: ['ui/index.html'] });
  assert.equal(pick.picked, null);
  assert.equal(pick.reason, 'no_ready');
});

test('pickWork: empty queue is no_ready', () => {
  const pick = pickWork({ specs: [], continuations: [], lane: 'claude' });
  assert.equal(pick.reason, 'no_ready');
});

// ---------- calm cap (TRIAGE.yml run: { cap: N }) ----------

test('pickWork: run cap bounds the fresh batch — cap 1 with 3 eligible ready specs selects 1', () => {
  const specs = [
    mk('a', { files: ['a.js'], priority: 'p0' }),
    mk('b', { files: ['b.js'], priority: 'p1' }),
    mk('c', { files: ['c.js'], priority: 'p2' }),
  ];
  const pick = pickWork({ specs, continuations: [], lane: 'claude', triageCfg: { run: { cap: 1 } } });
  assert.equal(pick.kind, 'ready');
  assert.equal(pick.picked, 'specs/a/');       // highest priority still wins the one slot
  assert.equal(pick.batch.length, 1);          // capped at 1, not the default 4
});

test('pickWork: missing or garbage run cap falls back to the default 4 (bin/tl.js parity)', () => {
  const specs = [
    mk('a', { files: ['a.js'], mtime: 1 }),
    mk('b', { files: ['b.js'], mtime: 2 }),
    mk('c', { files: ['c.js'], mtime: 3 }),
  ];
  for (const triageCfg of [undefined, null, {}, { run: {} }, { run: { cap: 0 } }, { run: { cap: -2 } }, { run: { cap: 'banana' } }]) {
    const pick = pickWork({ specs, continuations: [], lane: 'claude', triageCfg });
    assert.equal(pick.batch.length, 3, 'fallback cap 4 admits all 3 for cfg ' + JSON.stringify(triageCfg));
  }
});

// ---------- claim-time asset preflight: repo-held work is not eligible work ----------

// Non-tl workspace stub: nothing is a usable checkout.
const NO_REPOS = { isRepo: () => false, tlRoot: '/tl/checkout', workspaceRepo: '/repos/proj' };

test('pickWork: a repo-held ready spec is not eligible work', () => {
  const specs = [mk('void', { files: ['a.js'] })];
  specs[0].meta.repo = '/repos/missing';
  const pick = pickWork({ specs, continuations: [], lane: 'claude', preflight: NO_REPOS });
  assert.equal(pick.picked, null);
  assert.equal(pick.reason, 'no_ready');
});

test('pickWork: an eligible continuation whose repo is a void does not spawn — repo_held', () => {
  const kicked = mk('kicked', { stage: 'in-progress', claimedBy: 'claude', files: ['a.js'] });
  kicked.meta.repo = '/repos/missing';
  const pick = pickWork({ specs: [kicked], continuations: [cont(kicked)], lane: 'claude', preflight: NO_REPOS });
  assert.equal(pick.picked, null);
  assert.equal(pick.reason, 'repo_held');
});

test('repoPreflight: reads PROJECT.md repo, checks .git existence via fs', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'projects', 'tl-preflight-'));
  try {
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: "x"\nrepo: "/some/where"\n---\n');
    const p = repoPreflight(ROOT, dir);
    assert.equal(p.tlRoot, ROOT);
    assert.equal(p.workspaceRepo, '/some/where');
    assert.equal(p.isRepo(ROOT), true);                          // this checkout has .git
    assert.equal(p.isRepo(path.join(ROOT, 'lib')), false);       // dir without .git
    assert.equal(p.isRepo('/nonexistent-tl-preflight'), false);  // missing dir
    // no PROJECT.md → workspaceRepo null
    assert.equal(repoPreflight(ROOT, path.join(dir, 'nope')).workspaceRepo, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- shell-safe prompt delivery ----------

test('buildCommand: {prompt_file} substitutes the escaped temp-file path', () => {
  const { command, stdin } = buildCommand('claude -p {prompt_file}', '/tmp/x y.txt', 'brief');
  assert.equal(command, "claude -p '/tmp/x y.txt'");
  assert.equal(stdin, false);
});

test('buildCommand: {prompt} substitutes a shell-escaped single-line brief', () => {
  const { command, stdin } = buildCommand('agent --prompt {prompt}', '/tmp/p.txt', "line one\nit's line two\n");
  assert.equal(stdin, false);
  assert.equal(command, "agent --prompt 'line one it'\\''s line two'");
});

test('buildCommand: neither placeholder → prompt on stdin, template untouched', () => {
  const { command, stdin } = buildCommand('codex exec -', '/tmp/p.txt', 'brief');
  assert.equal(command, 'codex exec -');
  assert.equal(stdin, true);
});

test('promptOneLine collapses newlines, preserves content order', () => {
  assert.equal(promptOneLine('a\n\n  b\r\nc  '), 'a b c');
});

// ---------- lock check ----------

test('checkLock: free / held / stale by mtime against the timeout', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'projects', 'tl-worker-lock-'));
  try {
    const file = path.join(dir, 'claude.lock');
    assert.equal(checkLock(file, Date.now(), 120).state, 'free');
    fs.writeFileSync(file, '{}');
    assert.equal(checkLock(file, Date.now(), 120).state, 'held');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);   // 3h ago > 2h timeout
    fs.utimesSync(file, old, old);
    assert.equal(checkLock(file, Date.now(), 120).state, 'stale');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- tick (integration over a throwaway workspace; no real spawns) ----------

const LANES_YML = [
  'lanes:',
  '  claude:',
  '    command: "echo run -p {prompt_file}"',
  '  codex:',
  '    command: "echo codex-stdin"',
  '',
].join('\n');

function withWorkspace(opts, fn) {
  const name = 'tl-workertest-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(ROOT, 'projects', name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), opts.triage !== undefined ? opts.triage : LANES_YML);
    // Default identity: a tl-developing-tl workspace (PROJECT.md repo points at
    // this checkout), so the claim-time containment guard is exempt and the
    // scaffold's repo-less code specs stay eligible. Pass projectRepo to make
    // the workspace target another repo instead.
    fs.writeFileSync(path.join(dir, 'PROJECT.md'),
      `---\nname: "${name}"\nrepo: "${opts.projectRepo || ROOT}"\n---\n`);
    for (const s of opts.specs || []) {
      const folder = (s.stage && s.stage !== 'ready') ? s.stage : 'specs';
      const specDir = path.join(dir, folder, s.slug);
      fs.mkdirSync(specDir, { recursive: true });
      const fm = ['---', `title: "${s.slug}"`, 'type: feature', `status: ${s.stage || 'ready'}`]
        .concat(s.agent ? [`agent: ${s.agent}`] : [])
        .concat(s.claimedBy ? [`claimed_by: ${s.claimedBy}`] : [])
        .concat(s.repo ? [`repo: "${s.repo}"`] : [])
        .concat(['---', '', '## Objective', 'x', '', '## Scope', '', '### Files to touch',
          ...(s.files || []).map(f => `- \`${f}\``), '']).join('\n');
      fs.writeFileSync(path.join(specDir, 'SPEC.md'), fm);
    }
    for (const [rel, content] of Object.entries(opts.files || {})) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    return fn({ name, dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// run a tick with mocked seams; returns { result, lines, spawns, ws }
function runTick(ws, { lane = 'claude', dryRun = false, brief = 'RUN BRIEF\nbody\n', childCode = 0, spawnThrows = false, onSpawn } = {}) {
  const lines = [];
  const spawns = [];
  const result = tick({
    root: ROOT, wsDir: ws.dir, wsName: ws.name, lane, dryRun,
    dirtyPaths: [],                       // deterministic — the real repo tree is not under test
    print: s => lines.push(s),
    getRunBrief: () => brief,
    spawnLane: args => {
      spawns.push(args);
      if (onSpawn) onSpawn(args);
      if (spawnThrows) throw new Error('ENOENT: agent CLI not found');
      return childCode;
    },
  });
  return { result, lines, spawns };
}

function readLog(ws) {
  const f = path.join(ws.dir, '_metrics', 'worker-log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('tick: no work exits 0, prints the reason, logs spawned:false, spawns nothing', () => {
  withWorkspace({}, ws => {
    const { result, lines, spawns } = runTick(ws);
    assert.equal(result.code, 0);
    assert.equal(result.spawned, false);
    assert.equal(spawns.length, 0);
    assert.match(lines.join('\n'), /no work for lane "claude" — no_ready/);
    const log = readLog(ws);
    assert.equal(log.length, 1);
    assert.equal(log[0].workspace, ws.name);
    assert.equal(log[0].lane, 'claude');
    assert.equal(log[0].picked, 'none');
    assert.equal(log[0].spawned, false);
    assert.equal(log[0].exit_code, 0);
    assert.equal(log[0].reason, 'no_ready');
    assert.equal(typeof log[0].duration_seconds, 'number');
  });
});

test('tick: unconfigured lane exits 1, nothing executes', () => {
  withWorkspace({ triage: 'goals: []\n', specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const { result, lines, spawns } = runTick(ws);
    assert.equal(result.code, 1);
    assert.equal(spawns.length, 0);
    assert.match(lines.join('\n'), /lane "claude" is not configured/);
    assert.equal(readLog(ws)[0].reason, 'lane_unconfigured');
  });
});

test('tick: invalid lane exits 1 before artifact path construction', () => {
  withWorkspace({
    triage: [
      'lanes:',
      '  ../codex:',
      '    command: "echo bad {prompt_file}"',
      '',
    ].join('\n'),
    specs: [{ slug: 'r', files: ['a.js'] }],
  }, ws => {
    const { result, lines, spawns } = runTick(ws, { lane: '../codex' });
    assert.equal(result.code, 1);
    assert.equal(result.reason, 'lane_unconfigured');
    assert.equal(spawns.length, 0);
    assert.match(lines.join('\n'), /invalid lane/);
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'worker-prompts')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, 'codex.lock')), false);
  });
});

test('tick: PAUSE halts all lanes — exit 2, no spawn', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }], files: { PAUSE: '' } }, ws => {
    const { result, spawns } = runTick(ws);
    assert.equal(result.code, 2);
    assert.equal(result.reason, 'paused');
    assert.equal(spawns.length, 0);
    assert.equal(readLog(ws)[0].exit_code, 2);
  });
});

test('tick: held lock exits 2 without spawning; stale lock is taken over', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const lock = lockPathFor(ws.dir, 'claude');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '{}');

    const held = runTick(ws);
    assert.equal(held.result.code, 2);
    assert.equal(held.result.reason, 'locked');
    assert.equal(held.spawns.length, 0);

    // age the lock past the 2h default → takeover, spawn happens, lock removed
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    const stale = runTick(ws);
    assert.equal(stale.result.code, 0);
    assert.equal(stale.result.spawned, true);
    assert.equal(stale.spawns.length, 1);
    assert.match(stale.lines.join('\n'), /stale lock.*taking over/);
    assert.equal(fs.existsSync(lock), false);
    const last = readLog(ws).pop();
    assert.equal(last.stale_lock_takeover, true);
  });
});

test('tick: dry run prints the exact command + prompt path, writes nothing, exit 0', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const { result, lines, spawns } = runTick(ws, { dryRun: true });
    assert.equal(result.code, 0);
    assert.equal(spawns.length, 0);
    const outText = lines.join('\n');
    assert.match(outText, /dry run — lane "claude" would spawn for specs\/r\//);
    assert.match(outText, /echo run -p '.*_metrics\/worker-prompts\/claude-.*\.txt'/);
    assert.match(outText, /prompt file: /);
    // no artifacts: no lock, no prompt file, no log line
    assert.equal(fs.existsSync(lockPathFor(ws.dir, 'claude')), false);
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'worker-prompts')), false);
    assert.equal(readLog(ws).length, 0);
  });
});

test('tick: eligible ready spec spawns once — prompt file written, lock held during spawn, removed after, child 0 → exit 0', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const lock = lockPathFor(ws.dir, 'claude');
    let lockDuringSpawn = false, promptDuringSpawn = null;
    const { result, spawns } = runTick(ws, {
      brief: 'THE BRIEF\nsecond line\n',
      onSpawn: args => {
        lockDuringSpawn = fs.existsSync(lock);
        const m = args.command.match(/'([^']*worker-prompts[^']*)'/);
        promptDuringSpawn = m && fs.readFileSync(m[1], 'utf8');
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.spawned, true);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].stdin, null);              // {prompt_file} template → no stdin
    assert.equal(lockDuringSpawn, true);              // created just before spawn
    assert.equal(promptDuringSpawn, 'THE BRIEF\nsecond line\n');
    assert.equal(fs.existsSync(lock), false);         // removed after child exit
    const line = readLog(ws)[0];
    assert.equal(line.picked, 'specs/r/');
    assert.equal(line.spawned, true);
    assert.equal(line.exit_code, 0);
    assert.equal(line.child_exit_code, 0);
  });
});

test('tick: template with no placeholder delivers the brief on stdin', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const { result, spawns } = runTick(ws, { lane: 'codex', brief: 'STDIN BRIEF\n' });
    assert.equal(result.code, 0);
    assert.equal(spawns[0].command, 'echo codex-stdin');
    assert.equal(spawns[0].stdin, 'STDIN BRIEF\n');
  });
});

test('tick: child non-zero → exit 1; spawn failure → exit 1; lock removed either way', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const bad = runTick(ws, { childCode: 3 });
    assert.equal(bad.result.code, 1);
    assert.equal(readLog(ws).pop().child_exit_code, 3);
    assert.equal(fs.existsSync(lockPathFor(ws.dir, 'claude')), false);

    const boom = runTick(ws, { spawnThrows: true });
    assert.equal(boom.result.code, 1);
    assert.equal(boom.result.spawned, false);
    assert.equal(readLog(ws).pop().reason, 'spawn_failed');
    assert.equal(fs.existsSync(lockPathFor(ws.dir, 'claude')), false);
  });
});

test('tick: `tl run` subprocess failure → exit 1, no spawn, no lock left behind', () => {
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const lines = [];
    const result = tick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name, lane: 'claude',
      dirtyPaths: [], print: s => lines.push(s),
      getRunBrief: () => { throw new Error('tl.js exploded'); },
      spawnLane: () => { throw new Error('must not spawn'); },
    });
    assert.equal(result.code, 1);
    assert.equal(result.spawned, false);
    assert.equal(readLog(ws)[0].reason, 'tl_run_failed');
    assert.equal(fs.existsSync(lockPathFor(ws.dir, 'claude')), false);
  });
});

test('tick: continuation lane mismatch end-to-end — codex tick exits 0 no_continuation', () => {
  withWorkspace({
    specs: [
      { slug: 'kicked', stage: 'in-progress', claimedBy: 'claude', files: ['a.js'] },
      { slug: 'fresh', files: ['b.js'] },
    ],
    files: {
      '_dispatch/kicked.json': JSON.stringify({
        spec: 'kicked', mode: 'continuation', stage: 'in-progress',
        notes_path: 'kicked/NOTES.md', status: 'pending', created: '2026-07-04',
      }),
    },
  }, ws => {
    const codex = runTick(ws, { lane: 'codex' });
    assert.equal(codex.result.code, 0);
    assert.equal(codex.result.reason, 'no_continuation');
    assert.equal(codex.spawns.length, 0);
    // the owning lane picks it up
    const claude = runTick(ws);
    assert.equal(claude.result.spawned, true);
    assert.equal(readLog(ws).pop().picked, '_dispatch/kicked.json');
  });
});

test('tick: a lane whose only ready work is repo-held spawns nothing — exit 0', () => {
  withWorkspace({ specs: [{ slug: 'void', files: ['a.js'], repo: '/nonexistent-tl-void-repo' }] }, ws => {
    const { result, lines, spawns } = runTick(ws);
    assert.equal(result.code, 0);
    assert.equal(result.spawned, false);
    assert.equal(spawns.length, 0);
    assert.match(lines.join('\n'), /no work for lane "claude" — no_ready/);
  });
});

test('tick: containment — a repo-less code spec in a non-tl workspace never spawns into this checkout', () => {
  withWorkspace({ projectRepo: '/repos/some-project', specs: [{ slug: 'homeless', files: ['a.js'] }] }, ws => {
    const { result, spawns } = runTick(ws);
    assert.equal(result.code, 0);
    assert.equal(result.spawned, false);
    assert.equal(spawns.length, 0);
    assert.equal(readLog(ws)[0].reason, 'no_ready');
  });
});

test('tick: a repo-held continuation is no work — exit 0, reason repo_held, no spawn', () => {
  withWorkspace({
    specs: [{ slug: 'kicked', stage: 'in-progress', claimedBy: 'claude', files: ['a.js'], repo: '/nonexistent-tl-void-repo' }],
    files: {
      '_dispatch/kicked.json': JSON.stringify({
        spec: 'kicked', mode: 'continuation', stage: 'in-progress', status: 'pending', created: '2026-07-11',
      }),
    },
  }, ws => {
    const { result, spawns } = runTick(ws);
    assert.equal(result.code, 0);
    assert.equal(result.spawned, false);
    assert.equal(spawns.length, 0);
    assert.equal(readLog(ws)[0].reason, 'repo_held');
  });
});

test('tick: workspace run cap flows through — run: { cap: 1 } with 3 eligible ready specs spawns for exactly one', () => {
  withWorkspace({
    triage: LANES_YML + 'run:\n  cap: 1\n',
    specs: [
      { slug: 'one', files: ['a.js'] },
      { slug: 'two', files: ['b.js'] },
      { slug: 'three', files: ['c.js'] },
    ],
  }, ws => {
    const { result, spawns } = runTick(ws);
    assert.equal(result.code, 0);
    assert.equal(result.spawned, true);
    assert.equal(spawns.length, 1);                              // one tick, one spawn
    assert.match(result.picked, /^specs\/(one|two|three)\/$/);   // exactly one spec claimed the slot
    assert.equal(readLog(ws)[0].picked, result.picked);
  });
});

test('readWorkspaceSpecs + readPendingContinuations: stale pending trigger is not live', () => {
  withWorkspace({
    specs: [{ slug: 'fresh', files: ['b.js'] }],
    files: {
      '_dispatch/gone.json': JSON.stringify({ spec: 'gone', mode: 'continuation', status: 'pending' }),
      '_dispatch/settled.json': JSON.stringify({ spec: 'fresh', mode: 'continuation', status: 'claimed' }),
    },
  }, ws => {
    const specs = readWorkspaceSpecs(ws.dir);
    assert.equal(readPendingContinuations(ws.dir, specs).length, 0);
    // and the ready queue still runs
    const { result } = runTick(ws);
    assert.equal(result.spawned, true);
    assert.equal(readLog(ws)[0].picked, 'specs/fresh/');
  });
});

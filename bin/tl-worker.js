#!/usr/bin/env node
// tl-worker — one headless lane tick per invocation; cron/launchd owns the interval.
//
//   tl-worker <workspace> --agent <lane> [--mode run|verify] [--dry-run]
//   tl-worker <workspace> --mode verify [--agent <verifier-lane>] [--dry-run]
//   tl-worker <workspace> --lease <acquire|renew|release|expire|show> \
//       --spec <slug> --agent <actor> --run <run_id> [--stage <s>] [--ttl <m>] [--reason <r>]
//   tl-worker <workspace> --finalize --spec <slug> --agent <actor> --run <run_id> \
//       --base <commit> --tests <tests.json|-> [--artifact <rel>]... \
//       [--initiation <i>] [--source <s>]
//
// Run mode: decide whether lane <lane> has eligible RUN work (pending
// continuation dispatch first, then one conflict-free ready spec), and if so
// launch the lane's configured agent CLI (TRIAGE.yml `lanes.<lane>.command`)
// exactly once with the assembled `tl run` brief as its prompt. The tick
// acquires the spec's builder lease before the spawn; the brief's trailer
// hands the session its run_id plus the renew/finalize commands below.
//
// Verify mode: claim at most one awaiting-verifier spec through a configured
// isolated verifier lane (TRIAGE.yml `verification.verifier_lanes`), lock it,
// invoke lib/verifier-worker.js, and record the outcome. Never assigns work to
// the builder. UI/server never reach this path — they only write request files.
//
// Lease mode: the builder-session surface for the expiring lease contract —
// `renew` is the heartbeat a live builder sends at each major step; `release`/
// `expire` end a lease you own; `show` prints the typed liveness state. One
// lease per spec (_metrics/builder-leases/<slug>.json); a live foreign lease
// is a typed refusal, never a takeover.
//
// Finalize mode: the ONE builder hand-off order for interactive and headless
// runs — checks → outcome artifacts → terminal HANDOFF.json → guarded
// in-progress → tests move — executed atomically under the caller's lease by
// lib/worker.js finalizeBuilderHandoff. `--tests` names a JSON file (or `-`
// for stdin) holding non-empty [{command, ok, exit_code?, summary?}]. Prints
// the typed result as JSON; a refusal exits 1 and leaves the spec where it
// was observed.
//
// Exit codes (cron-friendly):
//   0  no work (quiet), the child / verify session exited 0, or lease/finalize ok
//   1  lane misconfigured, spawn failure, child / verify non-zero, or typed refusal
//   2  workspace PAUSE file present, or a lock / live foreign lease is held
//
// Decision logic lives in lib/worker.js; this file is the wiring.

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { isDir } = require('../lib/workspace');
const {
  tick, verifyTick,
  acquireBuilderLease, renewBuilderLease, releaseBuilderLease, expireBuilderLease,
  builderLeaseState, finalizeBuilderHandoff,
} = require('../lib/worker');

function fail(msg) { process.stderr.write('tl-worker: ' + msg + '\n'); process.exit(1); }

function resolveWorkspace(arg) {
  const projects = path.join(ROOT, 'projects');
  const all = isDir(projects)
    ? fs.readdirSync(projects).sort().filter(n => isDir(path.join(projects, n))).map(n => ({ name: n, dir: path.join(projects, n) }))
    : [];
  if (arg) {
    const hit = all.find(w => w.name === arg);
    if (hit) return hit;
    fail(`Unknown workspace "${arg}". Available: ${all.map(w => w.name).join(', ') || '(none)'}`);
  }
  if (all.length === 1) return all[0];
  if (all.length === 0) fail('No workspaces found under projects/.');
  fail(`Multiple workspaces — name one: ${all.map(w => w.name).join(', ')}`);
}

function usage() {
  process.stderr.write([
    'usage: tl-worker <workspace> --agent <lane> [--mode run|verify] [--dry-run]',
    '       tl-worker <workspace> --mode verify [--agent <verifier-lane>] [--dry-run]',
    '       tl-worker <workspace> --lease <acquire|renew|release|expire|show> \\',
    '           --spec <slug> --agent <actor> --run <run_id> [--stage <s>] [--ttl <m>] [--reason <r>]',
    '       tl-worker <workspace> --finalize --spec <slug> --agent <actor> --run <run_id> \\',
    '           --base <commit> --tests <tests.json|-> [--artifact <rel>]... [--initiation <i>] [--source <s>]',
    '',
    'Run mode: spawn the lane\'s configured agent once if it has eligible run work.',
    'Verify mode: claim ≤1 awaiting-verifier spec via an isolated verifier lane.',
    'Lease mode: heartbeat/release/inspect one spec\'s expiring builder lease.',
    'Finalize mode: the write-last builder hand-off (artifacts → manifest → guarded move).',
    'Exit codes: 0 no work / ok · 1 misconfig / fail / refusal · 2 paused / locked / lease held',
  ].join('\n') + '\n');
  process.exit(1);
}

function whichSync(bin) {
  try {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  } catch { return ''; }
}

// Print a typed lib/worker.js result as JSON and exit 0 (ok) / 1 (refusal).
function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result && result.ok ? 0 : 1);
}

function main() {
  const args = process.argv.slice(2);
  let lane = null, dryRun = false, mode = 'run';
  let leaseOp = null, finalize = false;
  let spec = null, run = null, stage = null, ttl = null, reason = null;
  let base = null, testsPath = null, initiation = null, source = null;
  const artifacts = [];
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') lane = String(args[++i] || '').toLowerCase();
    else if (args[i].startsWith('--agent=')) lane = args[i].slice(8).toLowerCase();
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--mode') mode = String(args[++i] || '');
    else if (args[i].startsWith('--mode=')) mode = args[i].slice(7);
    else if (args[i] === '--lease') leaseOp = String(args[++i] || '');
    else if (args[i].startsWith('--lease=')) leaseOp = args[i].slice(8);
    else if (args[i] === '--finalize') finalize = true;
    else if (args[i] === '--spec') spec = String(args[++i] || '');
    else if (args[i].startsWith('--spec=')) spec = args[i].slice(7);
    else if (args[i] === '--run') run = String(args[++i] || '');
    else if (args[i].startsWith('--run=')) run = args[i].slice(6);
    else if (args[i] === '--stage') stage = String(args[++i] || '');
    else if (args[i].startsWith('--stage=')) stage = args[i].slice(8);
    else if (args[i] === '--ttl') ttl = Number(args[++i]);
    else if (args[i].startsWith('--ttl=')) ttl = Number(args[i].slice(6));
    else if (args[i] === '--reason') reason = String(args[++i] || '');
    else if (args[i].startsWith('--reason=')) reason = args[i].slice(9);
    else if (args[i] === '--base') base = String(args[++i] || '');
    else if (args[i].startsWith('--base=')) base = args[i].slice(7);
    else if (args[i] === '--tests') testsPath = String(args[++i] || '');
    else if (args[i].startsWith('--tests=')) testsPath = args[i].slice(8);
    else if (args[i] === '--artifact') artifacts.push(String(args[++i] || ''));
    else if (args[i].startsWith('--artifact=')) artifacts.push(args[i].slice(11));
    else if (args[i] === '--initiation') initiation = String(args[++i] || '');
    else if (args[i].startsWith('--initiation=')) initiation = args[i].slice(13);
    else if (args[i] === '--source') source = String(args[++i] || '');
    else if (args[i].startsWith('--source=')) source = args[i].slice(9);
    else if (args[i] === '-h' || args[i] === '--help') usage();
    else pos.push(args[i]);
  }

  // Lease surface: the builder session's heartbeat / release / inspect verbs.
  if (leaseOp) {
    if (finalize) fail('--lease and --finalize are mutually exclusive');
    if (!['acquire', 'renew', 'release', 'expire', 'show'].includes(leaseOp)) {
      fail('--lease must be acquire, renew, release, expire, or show');
    }
    const ws = resolveWorkspace(pos[0]);
    if (!spec) fail('--lease requires --spec <slug>');
    if (leaseOp === 'show') {
      const state = builderLeaseState(ws.dir, spec);
      return emit({ ok: true, slug: spec, ...state });
    }
    if (!lane) fail('--lease ' + leaseOp + ' requires --agent <actor>');
    if (!run) fail('--lease ' + leaseOp + ' requires --run <run_id>');
    const opts = { slug: spec, actor: lane, runId: run };
    if (stage) opts.stage = stage;
    if (Number.isFinite(ttl) && ttl > 0) opts.ttlMinutes = ttl;
    if (reason) opts.reason = reason;
    const fns = {
      acquire: acquireBuilderLease, renew: renewBuilderLease,
      release: releaseBuilderLease, expire: expireBuilderLease,
    };
    return emit(fns[leaseOp](ws.dir, opts));
  }

  // Finalize surface: the write-last hand-off, shared by interactive and
  // headless builders (lib/worker.js finalizeBuilderHandoff owns the order).
  if (finalize) {
    const ws = resolveWorkspace(pos[0]);
    if (!spec) fail('--finalize requires --spec <slug>');
    if (!lane) fail('--finalize requires --agent <actor>');
    if (!run) fail('--finalize requires --run <run_id>');
    if (!base) fail('--finalize requires --base <commit>');
    if (!testsPath) fail('--finalize requires --tests <tests.json|->');
    let testsRaw;
    try {
      testsRaw = testsPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(testsPath), 'utf8');
    } catch (e) { fail('could not read --tests ' + testsPath + ' — ' + (e && e.message ? e.message : e)); }
    let tests;
    try { tests = JSON.parse(testsRaw); } catch (e) { fail('--tests is not valid JSON — ' + (e && e.message ? e.message : e)); }
    return emit(finalizeBuilderHandoff({
      wsDir: ws.dir, slug: spec, actor: lane, runId: run,
      baseCommit: base, tests,
      artifacts,
      ...(Number.isFinite(ttl) && ttl > 0 ? { ttlMinutes: ttl } : {}),
      initiation: initiation || 'unknown',
      source: source || 'cli',
    }));
  }

  if (!['run', 'verify'].includes(mode)) fail('--mode must be run or verify');
  if (mode === 'run' && !lane) usage();

  const ws = resolveWorkspace(pos[0]);

  if (mode === 'verify') {
    const result = verifyTick({
      root: ROOT, wsDir: ws.dir, wsName: ws.name,
      preferLane: lane || null,
      dryRun,
      which: whichSync,
    });
    process.exit(result.code);
  }

  const result = tick({
    root: ROOT, wsDir: ws.dir, wsName: ws.name, lane, dryRun,

    getRunBrief: () => execFileSync(process.execPath,
      [path.join(ROOT, 'bin', 'tl.js'), 'run', ws.name, '--agent', lane],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),

    // Argv-first spawn (lib/worker.js buildInvocation): the default executes
    // argv[0] directly with argv.slice(1) — no shell parses the command or the
    // prompt anywhere. `shell: true` is the lane's explicit opt-in
    // (lanes.<lane>.shell in TRIAGE.yml) and keeps the old sh -c behavior.
    spawnLane: ({ argv, command, shell, stdin }) => {
      const opts = {
        cwd: ROOT,
        input: stdin != null ? stdin : undefined,
        stdio: [stdin != null ? 'pipe' : 'inherit', 'inherit', 'inherit'],
      };
      const r = shell
        ? spawnSync(command, { ...opts, shell: true })
        : spawnSync(argv[0], argv.slice(1), opts);
      if (r.error) throw r.error;
      return r.status === null ? 1 : r.status;
    },
  });

  process.exit(result.code);
}

main();

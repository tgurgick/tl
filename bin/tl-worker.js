#!/usr/bin/env node
// tl-worker — one headless lane tick per invocation; cron/launchd owns the interval.
//
//   tl-worker <workspace> --agent <lane> [--mode run|verify] [--dry-run]
//   tl-worker <workspace> --mode verify [--agent <verifier-lane>] [--dry-run]
//
// Run mode: decide whether lane <lane> has eligible RUN work (pending
// continuation dispatch first, then one conflict-free ready spec), and if so
// launch the lane's configured agent CLI (TRIAGE.yml `lanes.<lane>.command`)
// exactly once with the assembled `tl run` brief as its prompt.
//
// Verify mode: claim at most one awaiting-verifier spec through a configured
// isolated verifier lane (TRIAGE.yml `verification.verifier_lanes`), lock it,
// invoke lib/verifier-worker.js, and record the outcome. Never assigns work to
// the builder. UI/server never reach this path — they only write request files.
//
// Exit codes (cron-friendly):
//   0  no work (quiet) or the child / verify session exited 0
//   1  lane misconfigured, spawn failure, or child / verify exited non-zero
//   2  workspace PAUSE file present, or a lock is held
//
// Decision logic lives in lib/worker.js; this file is the wiring.

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { isDir } = require('../lib/workspace');
const { tick, verifyTick } = require('../lib/worker');

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
    '',
    'Run mode: spawn the lane\'s configured agent once if it has eligible run work.',
    'Verify mode: claim ≤1 awaiting-verifier spec via an isolated verifier lane.',
    'Exit codes: 0 no work / ok · 1 misconfig / fail · 2 paused / locked',
  ].join('\n') + '\n');
  process.exit(1);
}

function whichSync(bin) {
  try {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  } catch { return ''; }
}

function main() {
  const args = process.argv.slice(2);
  let lane = null, dryRun = false, mode = 'run';
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') lane = String(args[++i] || '').toLowerCase();
    else if (args[i].startsWith('--agent=')) lane = args[i].slice(8).toLowerCase();
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--mode') mode = String(args[++i] || '');
    else if (args[i].startsWith('--mode=')) mode = args[i].slice(7);
    else if (args[i] === '-h' || args[i] === '--help') usage();
    else pos.push(args[i]);
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

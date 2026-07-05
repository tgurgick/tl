#!/usr/bin/env node
// tl-worker — one headless lane tick per invocation; cron/launchd owns the interval.
//
//   tl-worker <workspace> --agent <lane> [--dry-run]
//
// Decide whether lane <lane> has eligible RUN work (pending continuation
// dispatch first, then one conflict-free ready spec), and if so launch the
// lane's configured agent CLI (TRIAGE.yml `lanes.<lane>.command`) exactly once
// with the assembled `tl run` brief as its prompt. The spawned session does
// everything else under the run SKILL, stopping at in-review/ — this driver
// never moves a spec, never advances a stage. v1 covers the run lane only;
// verifier scheduling (`tl verify`) is a separate tick (see docs/headless-lanes.md).
//
// Exit codes (cron-friendly):
//   0  no work (quiet) or the child session exited 0
//   1  lane misconfigured, spawn failure, or child exited non-zero
//   2  workspace PAUSE file present, or the lane lock is held
//
// The decision logic lives in lib/worker.js; this file is only the wiring —
// arg parsing, workspace resolution, and the real subprocess/spawn seams.

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { isDir } = require('../lib/workspace');
const { tick } = require('../lib/worker');

function fail(msg) { process.stderr.write('tl-worker: ' + msg + '\n'); process.exit(1); }

// Workspace resolution — same convention as bin/tl.js: an arg names a
// workspace under projects/, or if exactly one exists use it, else list + error.
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
    'usage: tl-worker <workspace> --agent <lane> [--dry-run]',
    '',
    'One headless lane tick: spawn the lane\'s configured agent (TRIAGE.yml',
    '`lanes.<lane>.command`) once if it has eligible run work, then exit.',
    'Exit codes: 0 no work / child ok · 1 misconfig / spawn fail / child non-zero · 2 paused / locked',
  ].join('\n') + '\n');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let lane = null, dryRun = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') lane = String(args[++i] || '').toLowerCase();
    else if (args[i].startsWith('--agent=')) lane = args[i].slice(8).toLowerCase();
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '-h' || args[i] === '--help') usage();
    else pos.push(args[i]);
  }
  if (!lane) usage();  // the lane is the whole point — no default

  const ws = resolveWorkspace(pos[0]);

  const result = tick({
    root: ROOT, wsDir: ws.dir, wsName: ws.name, lane, dryRun,

    // The authoritative prompt: exactly the stdout of `tl run <ws> --agent <lane>`.
    getRunBrief: () => execFileSync(process.execPath,
      [path.join(ROOT, 'bin', 'tl.js'), 'run', ws.name, '--agent', lane],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),

    // The one spawn: a shell command from config, blocking until the session
    // exits (the tick ends when the child does). stdin carries the prompt only
    // when the template has no {prompt_file}/{prompt} placeholder.
    spawnLane: ({ command, stdin }) => {
      const r = spawnSync(command, {
        cwd: ROOT, shell: true,
        input: stdin != null ? stdin : undefined,
        stdio: [stdin != null ? 'pipe' : 'inherit', 'inherit', 'inherit'],
      });
      if (r.error) throw r.error;
      return r.status === null ? 1 : r.status;  // killed by signal → failure
    },
  });

  process.exit(result.code);
}

main();

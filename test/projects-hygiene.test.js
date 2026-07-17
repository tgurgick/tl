'use strict';
// projects/ hygiene — the real checkout's projects/ holds real workspaces
// only. Regression probe for the does-not-exist-<epoch> junk leak (spec:
// projects-junk-cleanup): experiment-auto-initiation's bogus-workspace test
// pointed wsDir at the real projects/, and the auto-initiation error log's
// mkdirSync(recursive) created one junk workspace per npm test run — 55 of
// them by the time they were swept.
//
// Test files run as parallel child processes, so scaffolds from sibling
// files may transiently exist under projects/ while this file runs (they
// are removed in finally blocks). The probe therefore asserts three things:
//   1. no junk-pattern entries exist at all — a reintroduced leak from any
//      run fails the suite deterministically by the next run;
//   2. the historical leak vector (auto-initiation error logging for a
//      bogus workspace) writes only under the wsDir it is given;
//   3. across this file's lifetime, projects/ gains no entries beyond the
//      known transient scaffolds.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const PROJECTS = path.join(ROOT, 'projects');

// Permanent residue no run may ever leave behind.
const JUNK = [/^does-not-exist-/, /^tl-clitest-/];

// Transient scaffolds sibling test files create (and remove in finally)
// under the real projects/ while the suite runs in parallel. Keep in sync
// with test/experiment-auto-initiation.test.js and test/worker.test.js.
const TRANSIENT = [/^tl-autoinit-/, /^tl-workertest-/, /^tl-preflight-/, /^tl-worker-lock-/];

function entries() {
  if (!fs.existsSync(PROJECTS)) return [];
  return fs.readdirSync(PROJECTS)
    .filter(e => {
      try { return fs.statSync(path.join(PROJECTS, e)).isDirectory(); } catch { return false; }
    })
    .sort();
}
const isTransient = e => TRANSIENT.some(re => re.test(e));

// Snapshot at file load — the baseline for the end-of-file gain check.
const baseline = entries().filter(e => !isTransient(e));

test('projects/ contains no junk workspaces (does-not-exist-*, tl-clitest-*)', () => {
  const junk = entries().filter(e => JUNK.some(re => re.test(e)));
  assert.deepEqual(junk, [],
    'junk workspaces under projects/ — a test is writing to the real root again: ' + junk.join(', '));
});

test('bogus-workspace auto-initiation writes only under its wsDir, never real projects/', () => {
  const { maybeAutoInitiateExperiment } = require('../lib/worker');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-hygiene-'));
  try {
    const wsDir = path.join(scratch, 'does-not-exist-' + Date.now());
    const before = entries().filter(e => !isTransient(e));
    const out = maybeAutoInitiateExperiment({
      wsDir,
      specPath: 'specs/none/',
      spec: {
        meta: { title: 'none', type: 'feature' },
        body: '## Objective\nx\n\n## Scope\n\n### Files to touch\n- `a.js`\n',
      },
      triageCfg: {
        experiments: {
          enabled: true, auto_initiate: true,
          candidates: ['claude', 'codex'], judge: 'gemini',
          budget_usd: 2.5, timeout_minutes: 30,
        },
      },
    });
    assert.ok(['error', 'skipped', 'held', 'initiated'].includes(out.decision));
    // Whatever it logged landed under the wsDir it was given (the tmpdir),
    // and the real projects/ is entry-for-entry unchanged (transient
    // scaffolds from concurrently-running sibling test files excepted).
    assert.deepEqual(entries().filter(e => !isTransient(e)), before,
      'real projects/ changed during the bogus-workspace call');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// Runs last (tests within a file are sequential): across this file's
// lifetime the real projects/ gained no non-transient entries.
test('projects/ gained no new entries across this test run', () => {
  const now = entries().filter(e => !isTransient(e));
  const gained = now.filter(e => !baseline.includes(e));
  assert.deepEqual(gained, [],
    'projects/ gained entries during the npm test run: ' + gained.join(', '));
});

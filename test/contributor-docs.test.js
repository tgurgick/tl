'use strict';
// Contributor-readiness docs — drift probe (spec: contributor-readiness-baseline).
// CONTRIBUTING.md and SECURITY.md make claims about the repo: the supported
// Node version, the check command, the zero-dependency rule, referenced
// files. Each claim is asserted against the thing itself, so the docs can't
// silently rot when CI or package.json changes.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const contributing = read('CONTRIBUTING.md');
const security = read('SECURITY.md');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));
const ci = read('.github/workflows/test.yml');

test('CONTRIBUTING and SECURITY exist and are non-trivial', () => {
  assert.ok(contributing.length > 500, 'CONTRIBUTING.md suspiciously short');
  assert.ok(security.length > 500, 'SECURITY.md suspiciously short');
});

test('README links both docs', () => {
  assert.match(readme, /\(CONTRIBUTING\.md\)/, 'README does not link CONTRIBUTING.md');
  assert.match(readme, /\(SECURITY\.md\)/, 'README does not link SECURITY.md');
});

test('stated Node version matches what CI actually runs', () => {
  const m = ci.match(/node-version:\s*(\d+)/);
  assert.ok(m, 'could not find node-version in .github/workflows/test.yml');
  const ciNode = m[1];
  assert.ok(contributing.includes(`Node: ${ciNode}`) || contributing.includes(`Node ${ciNode}`),
    `CONTRIBUTING.md does not state the CI Node version (${ciNode})`);
  assert.ok(readme.includes(`Node ${ciNode}`),
    `README contributing section does not state the CI Node version (${ciNode})`);
});

test('the documented check command exists', () => {
  assert.match(contributing, /npm test/, 'CONTRIBUTING.md does not document npm test');
  assert.ok(pkg.scripts && pkg.scripts.test, 'package.json has no test script');
});

test('zero-dependency claim is still true', () => {
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    'package.json grew dependencies — the zero-dependency rule in CONTRIBUTING.md is now false');
  assert.ok(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0,
    'package.json grew devDependencies — update CONTRIBUTING.md if this is intentional');
});

test('files the docs reference exist', () => {
  const referenced = [
    '.github/workflows/test.yml', // CONTRIBUTING: where CI checks live
    '_templates/SCHEMA.md',       // CONTRIBUTING: frontmatter contract
    'AGENTS.md',                  // CONTRIBUTING: generated rules + quickstart
    'docs/headless-lanes.md',     // SECURITY + README: per-lane sandbox posture
    'skills',                     // CONTRIBUTING: sync-rules source of truth
    'bin/tl.js',                  // CONTRIBUTING: setup entrypoint
  ];
  for (const f of referenced) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `doc-referenced path missing: ${f}`);
  }
});

test('no license is invented anywhere', () => {
  // The missing license is an explicit open human decision (workspace
  // PRIORITIES.md, Human notes). Nothing may quietly resolve it.
  const licenseFile = fs.existsSync(path.join(ROOT, 'LICENSE'));
  const docSaysOpen = /no license file yet/i.test(contributing);
  if (licenseFile) {
    // A human decided. The docs must stop claiming the decision is open.
    assert.ok(!docSaysOpen,
      'LICENSE exists but CONTRIBUTING.md still says the decision is open — update it');
  } else {
    assert.ok(docSaysOpen,
      'CONTRIBUTING.md no longer surfaces the open license decision');
    assert.ok(!('license' in pkg),
      'package.json has a license field but no LICENSE file — a spec guessed; that is a human governance decision');
  }
  assert.ok(!/\b(MIT|Apache|GPL|BSD|MPL|ISC)\b/.test(security),
    'SECURITY.md references a specific license — it must not');
});

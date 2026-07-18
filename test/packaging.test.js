'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

test('npm package contains runtime assets and excludes development files', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-npm-pack-cache-'));
  let result;
  try {
    result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache, npm_config_offline: 'true' },
    });
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);

  const files = report[0].files.map(({ path: file }) => file).sort();
  const required = [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '_patterns/PATTERNS.md',
    '_templates/SCHEMA.md',
    'assets/logo.svg',
    'bin/tl.js',
    'lib/workspace.js',
    'package.json',
    'README.md',
    'skills/run/SKILL.md',
    'ui/index.html',
    'ui/server.js',
  ];
  for (const file of required) {
    assert.ok(files.includes(file), `package is missing required file: ${file}`);
  }

  const allowedRoots = [
    '.claude-plugin/',
    '.codex-plugin/',
    '_patterns/',
    '_templates/',
    'assets/',
    'bin/',
    'lib/',
    'skills/',
    'ui/',
  ];
  const allowedTopLevel = new Set(['package.json', 'README.md']);
  const unexpected = files.filter(file =>
    !allowedTopLevel.has(file) && !allowedRoots.some(root => file.startsWith(root))
  );
  assert.deepEqual(unexpected, [], `unexpected files in package: ${unexpected.join(', ')}`);

  const forbidden = [
    '.claude/settings.local.json',
    '.github/',
    'projects/',
    'test/',
    'AGENTS.md',
    'GEMINI.md',
  ];
  for (const entry of forbidden) {
    assert.ok(
      !files.some(file => file === entry || file.startsWith(entry)),
      `package contains forbidden entry: ${entry}`
    );
  }
});

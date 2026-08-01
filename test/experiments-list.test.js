'use strict';
// test/experiments-list.test.js — Review list contract (ui/server.js /api/experiments
// + ui/index.html list assembly).
//
// Covers the two live bugs from 2026-07-25:
//   1. multi-project mode: the client must fetch every selected workspace's
//      experiments and merge them with per-row attribution (it used to query
//      only selected[0], so multi-select rendered "no experiments yet" while
//      the other workspace had records).
//   2. _experiments/queue/ (and any non-experiment dir) must never surface as
//      a phantom "UNKNOWN" experiment row — an experiment is defined by its
//      EXPERIMENT.md (docs/agent-experiments.md).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const UI_HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');

function writeExperiment(wsDir, id, { status = 'succeeded', created = '2026-07-01', agent = 'claude' } = {}) {
  const dir = path.join(wsDir, '_experiments', id);
  fs.mkdirSync(path.join(dir, 'candidates', 'cand-a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'EXPERIMENT.md'),
    `---\nstatus: "${status}"\ntask_type: "bugfix"\nprimary_agent: "${agent}"\ncreated: "${created}"\n---\n\n# Task\n\nfixture experiment ${id}\n`);
  fs.writeFileSync(path.join(dir, 'candidates', 'cand-a', 'METRICS.json'),
    JSON.stringify({ role: 'primary', status, agent_tool: agent, agent_model: 'fixture-model' }));
  return dir;
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-exp-list-'));
  for (const ws of ['alpha', 'beta']) {
    const dir = path.join(root, 'projects', ws);
    fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: "${ws}"\n---\n`);
  }
  const alpha = path.join(root, 'projects', 'alpha');
  const beta = path.join(root, 'projects', 'beta');
  // alpha: two real experiments + a queue/ dir + a stray non-experiment dir
  writeExperiment(alpha, '2026-07-01-exp-old', { created: '2026-07-01' });
  writeExperiment(alpha, '2026-07-20-exp-new', { created: '2026-07-20', status: 'running' });
  fs.mkdirSync(path.join(alpha, '_experiments', 'queue'), { recursive: true });
  fs.writeFileSync(path.join(alpha, '_experiments', 'queue', '2026-07-25-request.json'),
    JSON.stringify({ tl_spec: 'specs/foo.md', runtime: 'fixture' }));
  fs.mkdirSync(path.join(alpha, '_experiments', 'scratch-notes'), { recursive: true });
  fs.writeFileSync(path.join(alpha, '_experiments', 'scratch-notes', 'notes.txt'), 'not an experiment\n');
  // beta: one experiment, plus an empty queue/
  writeExperiment(beta, '2026-07-10-beta-exp', { created: '2026-07-10', agent: 'cursor' });
  fs.mkdirSync(path.join(beta, '_experiments', 'queue'), { recursive: true });
  return root;
}

function startServer(root, port) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('tl ui')) resolve(); });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => reject(new Error('server exited early (' + code + '): ' + out)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 8000).unref();
  });
  return { child, ready };
}

async function getJSON(port, pathname) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: r.status, body: await r.json() };
}

test('cockpit HTML: Review list fetches every selected workspace and attributes rows', () => {
  // multi-select merge — all selected workspaces are queried, not just selected[0]
  assert.match(UI_HTML, /wsNames\.map\(n =>\s*\n?\s*fetch\('\/api\/experiments\?ws='/);
  assert.doesNotMatch(UI_HTML, /const wsName = selected\[0\];/);
  // per-row workspace attribution in multi mode + per-row workspace routing
  assert.match(UI_HTML, /class="ews"/);
  assert.match(UI_HTML, /\.exp-item \.ews/);
  assert.match(UI_HTML, /selectExperiment\(e\._ws, e\.id\)/);
  // active row is tracked per (workspace, id), not by id text alone
  assert.match(UI_HTML, /expActiveWs/);
  assert.match(UI_HTML, /el\.dataset\.id === id && el\.dataset\.ws === wsName/);
});

test('/api/experiments: real experiments only — queue/ and non-experiment dirs never listed', async () => {
  const root = makeRoot();
  const port = 47800 + (process.pid % 1500);
  const { child, ready } = startServer(root, port);
  try {
    await ready;

    const a = await getJSON(port, '/api/experiments?ws=alpha');
    assert.equal(a.status, 200);
    assert.ok(Array.isArray(a.body));
    const aIds = a.body.map(e => e.id);
    assert.deepEqual(aIds.sort(), ['2026-07-01-exp-old', '2026-07-20-exp-new']);
    assert.ok(!aIds.includes('queue'), 'queue/ must not render as an experiment row');
    assert.ok(!aIds.includes('scratch-notes'), 'non-experiment dirs must not render as rows');
    // no phantom UNKNOWN rows with zero candidates
    assert.ok(a.body.every(e => e.status !== 'unknown'), JSON.stringify(a.body.map(e => e.status)));
    // newest first
    assert.equal(a.body[0].id, '2026-07-20-exp-new');

    const b = await getJSON(port, '/api/experiments?ws=beta');
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.map(e => e.id), ['2026-07-10-beta-exp']);

    // each workspace answers independently — the multi-select client merges these
    assert.equal(a.body.length + b.body.length, 3);

    // unknown workspace still 404s (client skips non-array bodies when merging)
    const bad = await getJSON(port, '/api/experiments?ws=nope');
    assert.equal(bad.status, 404);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('insights: queue/ does not inflate experiment counts in the workspace payload', async () => {
  const root = makeRoot();
  const port = 47810 + (process.pid % 1500);
  const { child, ready } = startServer(root, port);
  try {
    await ready;
    const ws = await getJSON(port, '/api/ws/alpha');
    assert.equal(ws.status, 200);
    const ex = ws.body.insights && ws.body.insights.experiments;
    assert.ok(ex, 'insights.experiments missing');
    assert.equal(ex.total, 2, 'queue/ + stray dir must not count as experiments');
    assert.ok(!('unknown' in (ex.by_status || {})), JSON.stringify(ex.by_status));
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

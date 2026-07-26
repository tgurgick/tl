'use strict';
// test/ui-stall-badge.test.js — cockpit stalled-claim badge payload + explicit
// per-spec reclaim endpoint (ui/server.js + ui/index.html rendering contract).
//
// Covers: workspace payload annotates stalled in-progress specs via
// lib/stall.js (no duplicated thresholds); fresh/active claims are refused by
// POST /api/reclaim; a successful explicit reclaim moves the folder and leaves
// NOTES.md audit evidence; the HTML renders STALLED ~Nh + a confirm/reason
// reclaim action (never a bulk sweep).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const UI_HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const WS = 'stall-badge-ws';
const HOUR = 3600000;
const NOW_CLAIMED = '2026-06-01'; // far enough in the past that default 24h threshold trips

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-stall-badge-'));
  const dir = path.join(root, 'projects', WS);
  fs.mkdirSync(path.join(dir, 'in-progress'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), 'goals: []\nstall:\n  idle_hours: 24\n');
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: "${WS}"\nrepo: "${ROOT}"\n---\n`);
  return { root, dir };
}

function writeClaim(dir, slug, { claimedBy = 'claude', claimedAt = NOW_CLAIMED, atMs = Date.now() - 72 * HOUR, extraFm = '' } = {}) {
  const specDir = path.join(dir, 'in-progress', slug);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, 'SPEC.md'),
    `---\ntitle: "${slug}"\ncreated: 2026-06-01\nproject: "${WS}"\ntype: "feature"\nstatus: "in-progress"\nclaimed_by: "${claimedBy}"\nclaimed_at: "${claimedAt}"\n${extraFm}---\n\n# ${slug}\n`);
  const t = new Date(atMs);
  const walk = d => {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      if (fs.statSync(p).isDirectory()) walk(p);
      else fs.utimesSync(p, t, t);
    }
    fs.utimesSync(d, t, t);
  };
  walk(specDir);
  return specDir;
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

async function fetchToken(port) {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const m = html.match(/window\.TL_WRITE_TOKEN="([0-9a-f]+)"/);
  return m ? m[1] : null;
}

async function post(port, pathname, body, token) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-tl-token': token } : {}),
    },
    body: JSON.stringify({ ws: WS, ...body }),
  });
  return { status: r.status, body: await r.json() };
}

async function getWs(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/ws/${encodeURIComponent(WS)}`);
  assert.equal(r.status, 200);
  return r.json();
}

test('cockpit HTML: stalled badge + per-spec reclaim (confirm + reason), no bulk sweep', () => {
  assert.match(UI_HTML, /STALLED ~\$\{/);
  assert.match(UI_HTML, /lc-status lc-stalled/);
  assert.match(UI_HTML, /idle ~\$\{/);
  assert.match(UI_HTML, /dr-reclaim/);
  assert.match(UI_HTML, /\/api\/reclaim/);
  assert.match(UI_HTML, /confirm\(/);
  assert.match(UI_HTML, /prompt\(['"]Why reclaim/);
  assert.match(UI_HTML, /A non-empty reason is required/);
  assert.match(UI_HTML, /never a bulk sweep/i);
  // no bulk reclaim control on the lane head
  assert.doesNotMatch(UI_HTML, /reclaim all/i);
  assert.doesNotMatch(UI_HTML, /\/api\/reclaim-all/);
});

test('stall badge payload + reclaim endpoint', async t => {
  const { root, dir } = makeRoot();
  writeClaim(dir, 'idle-orphan', { claimedBy: 'claude', atMs: Date.now() - 72 * HOUR });
  writeClaim(dir, 'still-working', {
    claimedBy: 'cursor',
    claimedAt: new Date().toISOString().slice(0, 10),
    atMs: Date.now() - 30 * 60 * 1000, // 30 minutes ago — inside 24h threshold
  });
  const port = 47000 + (process.pid % 2000);
  const { child, ready } = startServer(root, port);
  let token = null;
  try {
    await ready;
    token = await fetchToken(port);
    assert.ok(token, 'write token missing from GET /');

    await t.test('workspace payload: stalled card carries STALLED metadata; active does not', async () => {
      const ws = await getWs(port);
      const idle = ws.specs.find(s => s.path === 'in-progress/idle-orphan/');
      const live = ws.specs.find(s => s.path === 'in-progress/still-working/');
      assert.ok(idle, 'idle-orphan missing from payload');
      assert.ok(live, 'still-working missing from payload');
      assert.ok(idle.stall && idle.stall.stalled === true, JSON.stringify(idle.stall));
      assert.equal(idle.stall.owner, 'claude');
      assert.ok(idle.stall.idle_hours >= 24, 'idle_hours should reflect past-threshold idle');
      assert.equal(idle.stall.reason, 'idle-past-threshold');
      assert.ok(!live.stall, 'fresh claim must not be annotated stalled: ' + JSON.stringify(live.stall));
    });

    await t.test('POST /api/reclaim rejects active claim (never force-steal)', async () => {
      const r = await post(port, '/api/reclaim', {
        spec: 'in-progress/still-working/',
        reason: 'I want it anyway',
        by: 'tester',
      }, token);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.ok, false);
      assert.equal(r.body.reason, 'active-claim');
      assert.ok(fs.existsSync(path.join(dir, 'in-progress', 'still-working', 'SPEC.md')));
    });

    await t.test('POST /api/reclaim refuses empty reason', async () => {
      const r = await post(port, '/api/reclaim', {
        spec: 'in-progress/idle-orphan/',
        reason: '   ',
        by: 'tester',
      }, token);
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /reason/i);
      assert.ok(fs.existsSync(path.join(dir, 'in-progress', 'idle-orphan', 'SPEC.md')));
    });

    await t.test('POST /api/reclaim without token is 403 (write guard)', async () => {
      const r = await post(port, '/api/reclaim', {
        spec: 'in-progress/idle-orphan/',
        reason: 'no token',
      });
      assert.equal(r.status, 403);
      assert.ok(fs.existsSync(path.join(dir, 'in-progress', 'idle-orphan', 'SPEC.md')));
    });

    await t.test('successful explicit reclaim: release + NOTES audit + board refresh shape', async () => {
      const before = await getWs(port);
      assert.ok(before.specs.some(s => s.path === 'in-progress/idle-orphan/' && s.stall && s.stall.stalled));

      const r = await post(port, '/api/reclaim', {
        spec: 'in-progress/idle-orphan/',
        reason: 'session died mid-flight; reclaiming idle claim',
        by: 'tester',
      }, token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.equal(r.body.mode, 'release');
      assert.equal(r.body.from, 'in-progress/idle-orphan/');
      assert.equal(r.body.to, 'specs/idle-orphan/');

      assert.ok(!fs.existsSync(path.join(dir, 'in-progress', 'idle-orphan')));
      assert.ok(fs.existsSync(path.join(dir, 'specs', 'idle-orphan', 'SPEC.md')));
      const notes = fs.readFileSync(path.join(dir, 'specs', 'idle-orphan', 'NOTES.md'), 'utf8');
      assert.match(notes, /## Reclaimed /);
      assert.match(notes, /prior claim: claude/);
      assert.match(notes, /by: tester/);
      assert.match(notes, /reason: session died mid-flight/);

      const after = await getWs(port);
      assert.ok(!after.specs.some(s => s.path === 'in-progress/idle-orphan/'));
      const ready = after.specs.find(s => s.path === 'specs/idle-orphan/');
      assert.ok(ready);
      assert.equal(ready.stage, 'ready');
      assert.ok(!ready.stall);
    });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

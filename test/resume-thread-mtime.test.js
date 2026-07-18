'use strict';
// test/resume-thread-mtime.test.js — thread records that feed resume ranking
// carry `mtime`, on every surface.
//
// The drift this kills (threads/2026-07-14-cli-readthreads-mtime-drift.md):
// bin/tl.js kept a private readThreads that omitted mtime while
// lib/resume-recommended.js ranks open loops oldest-first by t.mtime — so
// /tl resume saw every thread as infinitely old and could order the decay
// inbox differently from the cockpit Resume tab. The fix routes the CLI
// through the shared reader in lib/recall.js. Parity is proved recall-style:
// deepEqual across surfaces (shared reader vs GET /api/ws threads vs the CLI's
// printed open loops), not by asserting source text.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const { readThreads } = require('../lib/recall');
const { collectOpenLoops, rankOpenLoops } = require('../lib/resume-recommended');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tl.js');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const WS = 'resumemtimews';

const fm = (fields, body) =>
  '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n\n' + body + '\n';

// Scaffold: open threads whose FILENAME order is the exact reverse of their
// MTIME order. If mtime is missing (the old CLI records), every age is 0 and
// the rank sort — stable — degrades to readdir/filename order; with mtime the
// oldest file wins. The two orders being opposites is what makes the
// deepEqual below a proof, not a coincidence.
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-resume-mtime-'));
  const dir = path.join(root, 'projects', WS);
  const put = (rel, text, ageDays) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    const t = (Date.now() - ageDays * 86400000) / 1000;
    fs.utimesSync(full, t, t);
  };

  put('PROJECT.md', fm({ name: WS, repo: ROOT }, '# ' + WS), 30);
  // filename-first is mtime-newest; filename-last is mtime-oldest
  put('threads/2026-01-01-newest-question.md',
    fm({ title: 'Newest question', type: 'question', status: 'open' }, 'Fresh.'), 1);
  put('threads/2026-01-02-middle-question.md',
    fm({ title: 'Middle question', type: 'question', status: 'open' }, 'Aging.'), 5);
  put('threads/2026-01-03-oldest-question.md',
    fm({ title: 'Oldest question', type: 'question', status: 'open' }, 'Ancient.'), 20);
  // a risk (higher severity) proves kind still outranks age
  put('threads/2026-01-04-young-risk.md',
    fm({ title: 'Young risk', type: 'risk', status: 'open' }, 'Sharp edge.'), 2);
  // non-open / non-typed threads must not enter the decay inbox
  put('threads/2026-01-05-parked-idea.md',
    fm({ title: 'Parked idea', type: 'idea', status: 'parked' }, 'Later.'), 3);
  return { root, dir };
}

const rankedPaths = (threads) =>
  rankOpenLoops(collectOpenLoops({ threads })).map(l => l.item.path);

// ---------- the mtime stamp itself ----------

test('shared reader: every CLI-bound thread record carries the file mtime', () => {
  const { root, dir } = makeRoot();
  try {
    const threads = readThreads(dir);
    assert.equal(threads.length, 5);
    for (const t of threads) {
      const stat = fs.statSync(path.join(dir, t.path));
      assert.equal(typeof t.mtime, 'number');
      assert.ok(t.mtime > 0, t.path + ' has no mtime');
      assert.equal(t.mtime, stat.mtimeMs, t.path + ' mtime is not the file mtime');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- ranking uses it ----------

test('resume ranking: open loops order by thread mtime (oldest first) — and collapse to filename order when mtime is stripped', () => {
  const { root, dir } = makeRoot();
  try {
    const threads = readThreads(dir);

    // with mtime: risk (severity) first, then questions oldest-first —
    // the exact REVERSE of filename order.
    assert.deepEqual(rankedPaths(threads), [
      'threads/2026-01-04-young-risk.md',
      'threads/2026-01-03-oldest-question.md',
      'threads/2026-01-02-middle-question.md',
      'threads/2026-01-01-newest-question.md',
    ]);

    // control — the old CLI shape (no mtime): every thread looks infinitely
    // old, the age tiebreak dies, and the questions fall back to filename
    // order. This is the drift the shared reader closes.
    const legacy = threads.map(({ mtime, ...t }) => t);
    assert.deepEqual(rankedPaths(legacy), [
      'threads/2026-01-04-young-risk.md',
      'threads/2026-01-01-newest-question.md',
      'threads/2026-01-02-middle-question.md',
      'threads/2026-01-03-oldest-question.md',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- parity: CLI surface ----------

// cmdResume prints one `- open <type>: <title> (<path>)` line per open
// question/risk. Parse them back for comparison against the shared reader.
function parseCliOpenLoops(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^- open (question|risk): (.*) \((threads\/.*)\)$/);
    if (m) out.push({ type: m[1], title: m[2], path: m[3] });
  }
  return out;
}

test('parity: tl resume surfaces exactly the shared-reader open threads', () => {
  const { root, dir } = makeRoot();
  try {
    const cli = spawnSync(process.execPath, [BIN, 'resume', WS], {
      encoding: 'utf8', env: { ...process.env, TL_ROOT: root },
    });
    assert.equal(cli.status, 0, cli.stderr);
    const expected = readThreads(dir)
      .filter(t => ['question', 'risk'].includes(String(t.meta.type)) && t.meta.status === 'open')
      .map(t => ({ type: String(t.meta.type), title: t.title, path: t.path }));
    assert.deepEqual(parseCliOpenLoops(cli.stdout), expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- parity: cockpit surface ----------

test('parity: GET /api/ws threads match the shared reader, and both surfaces rank open loops identically', async t => {
  const { root, dir } = makeRoot();
  const port = 46300 + (process.pid % 1800);
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', d => { buf += d; if (buf.includes('tl ui')) resolve(); });
    child.stderr.on('data', d => { buf += d; });
    child.on('exit', code => reject(new Error('server exited early (' + code + '): ' + buf)));
    setTimeout(() => reject(new Error('server did not start: ' + buf)), 8000).unref();
  });
  try {
    await ready;
    const r = await fetch(`http://127.0.0.1:${port}/api/ws/${WS}`);
    assert.equal(r.status, 200);
    const body = await r.json();

    // record parity — same records, mtime included, on both surfaces
    const cliThreads = readThreads(dir);
    assert.deepEqual(body.threads, JSON.parse(JSON.stringify(cliThreads)));

    // ranking parity — the whole point: identical open-loop order + ages
    const key = (l) => ({ kind: l.kind, path: l.item.path, age: l.age });
    assert.deepEqual(
      rankOpenLoops(collectOpenLoops({ threads: cliThreads })).map(key),
      rankOpenLoops(collectOpenLoops({ threads: body.threads })).map(key),
    );
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

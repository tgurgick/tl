'use strict';
// lib/recall.js — the shared /tl recall corpus/scoring/grouping helpers, plus
// parity proof: the CLI (`tl recall`) and the UI server (GET /api/recall) must
// surface EXACTLY the hits the shared helper computes — same order, same
// scores, same kind buckets — because both are thin callers of recallSearch().
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const {
  KIND_ORDER, recallTerms, scoreMatch, firstMatchSnippet, recallKind,
  groupHits, buildCorpus, recallSearch,
} = require('../lib/recall');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tl.js');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const WS = 'recallws';

// ---------- scaffold: one workspace exercising every corpus source + bucket ----------

const fm = (fields, body) =>
  '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n\n' + body + '\n';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-recall-'));
  const dir = path.join(root, 'projects', WS);
  const put = (rel, text, ageDays) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    // distinct, deterministic mtimes so recency tie-breaks are stable
    const t = (Date.now() - ageDays * 86400000) / 1000;
    fs.utimesSync(full, t, t);
  };

  put('PROJECT.md', fm({ name: WS, repo: ROOT }, '# ' + WS), 30);
  put('intents/2026-01-01-widget.md',
    fm({ title: 'Widget direction', status: 'approved' }, 'We should build a widget properly.'), 20);
  put('specs/widget-ready/SPEC.md',
    fm({ title: 'Widget ready spec', type: 'feature', status: 'ready' }, 'Build the widget frame.'), 10);
  put('in-progress/widget-active/SPEC.md',
    fm({ title: 'Widget active spec', type: 'feature', status: 'in-progress' }, 'Wiring the widget now.'), 5);
  put('done/widget-done/SPEC.md',
    fm({ title: 'Widget done spec', type: 'feature', status: 'done' }, 'The widget shipped.'), 8);
  put('done/widget-done/outcome/FEEDBACK.md',
    fm({ spec: 'tests/widget-done/SPEC.md' }, '## Asked vs. delivered\n\nDelivered the widget end to end.'), 7);
  put('done/widget-research/SPEC.md',
    fm({ title: 'Widget research', type: 'research', status: 'done' }, 'Recommendation: keep the widget local.'), 9);
  put('threads/2026-01-02-widget-decision.md',
    fm({ title: 'Widget stays zero-dependency', type: 'decision', status: 'closed' }, 'Decided: the widget uses no external index.'), 6);
  put('threads/2026-01-03-widget-question.md',
    fm({ title: 'Widget open question', type: 'question', status: 'open' }, 'Should the widget cap results?'), 4);
  put('threads/2026-01-04-widget-note.md',
    fm({ title: 'Widget closed note', type: 'note', status: 'closed' }, 'The widget note is settled.'), 3);
  // a file recall must NOT match for "widget"
  put('threads/2026-01-05-unrelated.md',
    fm({ title: 'Unrelated thought', type: 'idea', status: 'parked' }, 'Nothing to see here.'), 2);
  return { root, dir };
}

// ---------- pure helpers ----------

test('recallTerms: lowercases and splits on whitespace', () => {
  assert.deepEqual(recallTerms('  Widget   CAP  '), ['widget', 'cap']);
  assert.deepEqual(recallTerms(''), []);
  assert.deepEqual(recallTerms(null), []);
});

test('scoreMatch: title/frontmatter hit (+3) beats body hit (+1); a homeless term drops the item', () => {
  const item = { title: 'Widget spec', meta: { tags: ['gadget'] }, body: 'the frame is wooden' };
  assert.equal(scoreMatch(item, ['widget']).score, 3);      // title
  assert.equal(scoreMatch(item, ['gadget']).score, 3);      // frontmatter
  assert.equal(scoreMatch(item, ['wooden']).score, 1);      // body
  assert.equal(scoreMatch(item, ['widget', 'wooden']).score, 4);
  assert.equal(scoreMatch(item, ['widget', 'missing']), null);
  assert.equal(scoreMatch({ title: 'X', meta: {}, body: 'CASE Insensitive' }, ['case']).score, 1);
});

test('firstMatchSnippet: first matching body line, trimmed to one line of context', () => {
  const body = 'no hit here\n\n  the widget line matched  \nlater widget line';
  assert.equal(firstMatchSnippet(body, ['widget']), 'the widget line matched');
  const long = 'x'.repeat(200) + ' widget';
  assert.equal(firstMatchSnippet(long, ['widget']).length, 158); // 157 chars + '…'
  assert.ok(firstMatchSnippet(long, ['widget']).endsWith('…'));
  assert.equal(firstMatchSnippet('nothing relevant', ['widget']), '');
});

test('recallKind: the skill buckets, best-effort from frontmatter + stage', () => {
  assert.equal(recallKind({ path: 'intents/a.md', meta: {} }), 'intent');
  assert.equal(recallKind({ path: 'done/s/outcome/FEEDBACK.md', meta: {} }), 'done outcome');
  assert.equal(recallKind({ path: 'threads/t.md', meta: { type: 'decision' } }), 'decision');
  assert.equal(recallKind({ path: 'threads/t.md', meta: { type: 'question', status: 'closed' } }), 'open thread');
  assert.equal(recallKind({ path: 'threads/t.md', meta: { status: 'parked' } }), 'open thread');
  assert.equal(recallKind({ path: 'threads/t.md', meta: { type: 'note', status: 'closed' } }), 'thread');
  assert.equal(recallKind({ path: 'done/s/', stage: 'done', meta: { type: 'feature' } }), 'done outcome');
  assert.equal(recallKind({ path: 'done/s/', stage: 'done', meta: { type: 'research' } }), 'recommendation');
  assert.equal(recallKind({ path: 'specs/s/', stage: 'ready', meta: { type: 'research' } }), 'recommendation');
  assert.equal(recallKind({ path: 'specs/s/', stage: 'ready', meta: { type: 'feature' } }), 'ready / active spec');
});

test('groupHits: groups follow KIND_ORDER; ranked order is preserved within a group', () => {
  const h = (kind, title) => ({ kind, title });
  const groups = groupHits([
    h('intent', 'i1'), h('decision', 'd1'), h('ready / active spec', 's1'),
    h('decision', 'd2'), h('mystery', 'm1'),
  ]);
  assert.deepEqual(groups.map(g => g.kind), ['decision', 'ready / active spec', 'intent', 'mystery']);
  assert.deepEqual(groups[0].hits.map(x => x.title), ['d1', 'd2']); // rank preserved
  assert.ok(KIND_ORDER.includes('done outcome'));
});

// ---------- recallSearch over a real workspace tree ----------

test('recallSearch: corpus, ranking, buckets, empty answers, and the cap', async t => {
  const { root, dir } = makeRoot();
  try {
    await t.test('corpus covers intents, all spec stages, threads, and done outcomes', () => {
      const paths = buildCorpus(dir).map(i => i.path);
      for (const p of [
        'intents/2026-01-01-widget.md', 'specs/widget-ready/', 'in-progress/widget-active/',
        'done/widget-done/', 'done/widget-done/outcome/FEEDBACK.md', 'done/widget-research/',
        'threads/2026-01-03-widget-question.md',
      ]) assert.ok(paths.includes(p), 'corpus missing ' + p);
    });

    const r = recallSearch(dir, 'widget');

    await t.test('matches only files that carry every term; the unrelated thread stays out', () => {
      assert.equal(r.total, 9);
      assert.ok(!r.hits.some(h => h.path.includes('unrelated')));
    });

    await t.test('rank: score first, then recency breaks ties', () => {
      for (let i = 1; i < r.hits.length; i++) {
        const a = r.hits[i - 1], b = r.hits[i];
        assert.ok(a.score > b.score || (a.score === b.score && a.mtime >= b.mtime),
          `rank broken at ${a.path} -> ${b.path}`);
      }
      // all title hits score 3 here, so the newest file leads
      assert.equal(r.hits[0].path, 'threads/2026-01-04-widget-note.md');
    });

    await t.test('every skill bucket appears, in stable display order', () => {
      const kinds = r.groups.map(g => g.kind);
      assert.deepEqual(kinds, ['decision', 'recommendation', 'done outcome', 'ready / active spec', 'open thread', 'intent', 'thread']);
      const byKind = Object.fromEntries(r.groups.map(g => [g.kind, g.hits.map(h => h.path)]));
      assert.deepEqual(byKind['decision'], ['threads/2026-01-02-widget-decision.md']);
      assert.deepEqual(byKind['recommendation'], ['done/widget-research/']);
      assert.deepEqual(byKind['done outcome'], ['done/widget-done/outcome/FEEDBACK.md', 'done/widget-done/']);
      assert.deepEqual(byKind['open thread'], ['threads/2026-01-03-widget-question.md']);
      assert.deepEqual(byKind['intent'], ['intents/2026-01-01-widget.md']);
      assert.deepEqual(byKind['thread'], ['threads/2026-01-04-widget-note.md']);
      assert.deepEqual(byKind['ready / active spec'].sort(), ['in-progress/widget-active/', 'specs/widget-ready/']);
    });

    await t.test('hits are plain serializable records (JSON-safe for the endpoint)', () => {
      assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
      for (const h of r.hits) assert.ok(!('meta' in h) && !('body' in h));
    });

    await t.test('cap truncates the ranked list before grouping and says so', () => {
      const capped = recallSearch(dir, 'widget', { cap: 3 });
      assert.equal(capped.total, 9);
      assert.equal(capped.capped, true);
      assert.equal(capped.hits.length, 3);
      assert.deepEqual(capped.hits, r.hits.slice(0, 3));
      assert.equal(capped.groups.reduce((n, g) => n + g.hits.length, 0), 3);
    });

    await t.test('no match and empty query answer plainly with zero hits', () => {
      const none = recallSearch(dir, 'zeppelin');
      assert.equal(none.total, 0);
      assert.deepEqual(none.hits, []);
      assert.deepEqual(none.groups, []);
      const empty = recallSearch(dir, '   ');
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.terms, []);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- parity: CLI and UI server are thin callers of the same helper ----------

// The CLI prints one `- title (path) [score N]` line per hit, grouped under
// `### kind` headings. Parse them back into records for comparison.
function parseCliHits(stdout) {
  const hits = [];
  let kind = null;
  for (const line of stdout.split('\n')) {
    const k = line.match(/^### (.+)$/);
    if (k) { kind = k[1]; continue; }
    const m = line.match(/^- (.*) \((.*)\) \[score (\d+)\]$/);
    if (m && kind) hits.push({ kind, title: m[1], path: m[2], score: Number(m[3]) });
  }
  return hits;
}

test('parity: tl recall prints exactly the shared helper hits (order, scores, buckets)', () => {
  const { root, dir } = makeRoot();
  try {
    const expected = recallSearch(dir, 'widget');
    const cli = spawnSync(process.execPath, [BIN, 'recall', WS, 'widget'], {
      encoding: 'utf8', env: { ...process.env, TL_ROOT: root },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, new RegExp('## Matches \\(' + expected.total + ', grouped by kind\\)'));
    const flat = expected.groups.flatMap(g => g.hits.map(h => ({ kind: g.kind, title: h.title, path: h.path, score: h.score })));
    assert.deepEqual(parseCliHits(cli.stdout), flat);

    // no prior art → the plain empty answer, on both surfaces
    const none = spawnSync(process.execPath, [BIN, 'recall', WS, 'zeppelin'], {
      encoding: 'utf8', env: { ...process.env, TL_ROOT: root },
    });
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /No prior discussion found across intents, specs, threads, or done outcomes\./);
    assert.equal(recallSearch(dir, 'zeppelin').total, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parity: GET /api/recall returns the shared helper result verbatim (capped)', async t => {
  const { root, dir } = makeRoot();
  const port = 44100 + (process.pid % 1800);
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

    await t.test('same hits as recallSearch with the server cap', async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/recall?ws=${WS}&q=widget`);
      assert.equal(r.status, 200);
      const body = await r.json();
      const expected = recallSearch(dir, 'widget', { cap: 30 });
      assert.deepEqual(body, JSON.parse(JSON.stringify(expected)));
      // and the CLI agrees on the same ranked list (cap is a truncation only)
      const cli = spawnSync(process.execPath, [BIN, 'recall', WS, 'widget'], {
        encoding: 'utf8', env: { ...process.env, TL_ROOT: root },
      });
      const flat = body.groups.flatMap(g => g.hits.map(h => ({ kind: g.kind, title: h.title, path: h.path, score: h.score })));
      assert.deepEqual(parseCliHits(cli.stdout), flat);
    });

    await t.test('no-match answers with zero hits; guards reject bad input', async () => {
      const none = await (await fetch(`http://127.0.0.1:${port}/api/recall?ws=${WS}&q=zeppelin`)).json();
      assert.equal(none.total, 0);
      assert.deepEqual(none.groups, []);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/recall?ws=nope&q=widget`)).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/recall?ws=${WS}`)).status, 400);
    });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

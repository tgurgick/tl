'use strict';
// /api/map-repair — the Map's break-repair endpoint (ui/server.js).
// Covers the three corrective actions as plain file edits: attach writes the
// spec's intent: field and appends to the intent's specs: list; create-intent
// scaffolds a goal-carrying intent from _templates/intent.md; set-goal points a
// goal-less intent at a TRIAGE.yml goal. Plus the guards: goal-less create is
// rejected, unknown goals are rejected, and paths can't escape the workspace.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { parseFrontmatter } = require('../lib/parse');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const WS = 'wsrepair';

const specMd = slug => `---\ntitle: "${slug}"\ncreated: 2026-07-01\nproject: "${WS}"\nintent: ""\ntype: "feature"\nstatus: "ready"\n---\n\n# ${slug}\n`;

// scaffold a throwaway server root: projects/<ws>/ with orphan specs, one
// intent, a goal-less intent, a TRIAGE.yml, and the real intent template
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-maprepair-'));
  const dir = path.join(root, 'projects', WS);
  for (const slug of ['orphan-a', 'orphan-b', 'orphan-c']) {
    fs.mkdirSync(path.join(dir, 'specs', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'specs', slug, 'SPEC.md'), specMd(slug));
  }
  fs.mkdirSync(path.join(dir, 'intents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'intents', '2026-01-01-existing.md'),
    '---\ntitle: "Existing intent"\ncreated: 2026-01-01\nproject: "' + WS + '"\nstatus: "approved"\ngoals: [goal-a]\npriority: "p1"\ntags: []\nspecs:\n  - "specs/already-there/"\n---\n\n# Existing intent\n');
  fs.writeFileSync(path.join(dir, 'intents', '2026-01-02-goalless.md'),
    '---\ntitle: "Goal-less intent"\ncreated: 2026-01-02\nproject: "' + WS + '"\nstatus: "draft"\ngoals: []\npriority: ""\ntags: []\nspecs: []\n---\n\n# Goal-less intent\n');
  fs.writeFileSync(path.join(dir, 'TRIAGE.yml'),
    'goals:\n  - id: goal-a\n    description: "Goal A"\n    weight: 0.6\n  - id: goal-b\n    description: "Goal B"\n    weight: 0.4\n');
  fs.mkdirSync(path.join(root, '_templates'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '_templates', 'intent.md'), path.join(root, '_templates', 'intent.md'));
  return { root, dir };
}

function startServer(root, port) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', d => { out += d; if (out.includes('tl ui')) resolve(); });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => reject(new Error('server exited early (' + code + '): ' + out)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 8000).unref();
  });
  return { child, ready };
}

async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/api/map-repair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ws: WS, ...body }),
  });
  return { status: r.status, body: await r.json() };
}

test('map-repair endpoint', async t => {
  const { root, dir } = makeRoot();
  const port = 42000 + (process.pid % 2000);
  const { child, ready } = startServer(root, port);
  try {
    await ready;

    await t.test('attach: writes the spec intent field and appends to the intent specs list', async () => {
      const r = await post(port, { action: 'attach', spec: 'specs/orphan-a/', intent: 'intents/2026-01-01-existing.md' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const spec = parseFrontmatter(fs.readFileSync(path.join(dir, 'specs', 'orphan-a', 'SPEC.md'), 'utf8'));
      assert.equal(spec.meta.intent, 'intents/2026-01-01-existing.md');
      const raw = fs.readFileSync(path.join(dir, 'intents', '2026-01-01-existing.md'), 'utf8');
      const intent = parseFrontmatter(raw);
      assert.deepEqual(intent.meta.specs, ['specs/already-there/', 'specs/orphan-a/']);
      assert.equal(intent.meta.title, 'Existing intent');          // rest of the record untouched
      assert.match(raw, /\n# Existing intent\n/);                  // body untouched
    });

    await t.test('attach: is idempotent on the specs list', async () => {
      const r = await post(port, { action: 'attach', spec: 'specs/orphan-a/', intent: 'intents/2026-01-01-existing.md' });
      assert.equal(r.status, 200);
      const intent = parseFrontmatter(fs.readFileSync(path.join(dir, 'intents', '2026-01-01-existing.md'), 'utf8'));
      assert.deepEqual(intent.meta.specs, ['specs/already-there/', 'specs/orphan-a/']);
    });

    await t.test('create-intent: scaffolds a goal-carrying intent and links the spec', async () => {
      const r = await post(port, { action: 'create-intent', spec: 'specs/orphan-b/', title: 'A new direction', goal: 'goal-b' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rel = r.body.path;
      assert.match(rel, /^intents\/\d{4}-\d{2}-\d{2}-a-new-direction\.md$/);
      const raw = fs.readFileSync(path.join(dir, rel), 'utf8');
      const it = parseFrontmatter(raw);
      assert.equal(it.meta.title, 'A new direction');
      assert.equal(it.meta.project, WS);
      assert.equal(it.meta.status, 'draft');
      assert.deepEqual(it.meta.goals, ['goal-b']);                 // never a goal-less intent
      assert.deepEqual(it.meta.specs, ['specs/orphan-b/']);
      assert.match(raw, /# A new direction/);                      // template heading filled in
      assert.match(raw, /## Outcome/);                             // scaffolded from _templates/intent.md
      const spec = parseFrontmatter(fs.readFileSync(path.join(dir, 'specs', 'orphan-b', 'SPEC.md'), 'utf8'));
      assert.equal(spec.meta.intent, rel);
    });

    await t.test('create-intent: a goal-less create is rejected and writes nothing', async () => {
      const before = fs.readdirSync(path.join(dir, 'intents')).sort();
      const r = await post(port, { action: 'create-intent', spec: 'specs/orphan-c/', title: 'Drifting work', goal: '' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /goal is required/);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'intents')).sort(), before);
      const spec = parseFrontmatter(fs.readFileSync(path.join(dir, 'specs', 'orphan-c', 'SPEC.md'), 'utf8'));
      assert.equal(spec.meta.intent ?? '', '');                    // spec left orphaned, not half-linked
    });

    await t.test('create-intent: a goal not in TRIAGE.yml is rejected', async () => {
      const r = await post(port, { action: 'create-intent', spec: 'specs/orphan-c/', title: 'Drifting work', goal: 'not-a-goal' });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /unknown goal/);
    });

    await t.test('set-goal: points a goal-less intent at a TRIAGE.yml goal', async () => {
      const r = await post(port, { action: 'set-goal', intent: 'intents/2026-01-02-goalless.md', goal: 'goal-a' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const it = parseFrontmatter(fs.readFileSync(path.join(dir, 'intents', '2026-01-02-goalless.md'), 'utf8'));
      assert.deepEqual(it.meta.goals, ['goal-a']);
      assert.equal(it.meta.title, 'Goal-less intent');
    });

    await t.test('set-goal: an unknown goal is rejected', async () => {
      const r = await post(port, { action: 'set-goal', intent: 'intents/2026-01-02-goalless.md', goal: 'nope' });
      assert.equal(r.status, 400);
    });

    await t.test('path safety: traversal and off-pattern paths are refused', async () => {
      for (const bad of [
        { action: 'attach', spec: '../../etc', intent: 'intents/2026-01-01-existing.md' },
        { action: 'attach', spec: 'specs/../../x', intent: 'intents/2026-01-01-existing.md' },
        { action: 'attach', spec: 'specs/orphan-c/', intent: 'intents/../TRIAGE.yml' },
        { action: 'attach', spec: 'specs/orphan-c/', intent: '../outside.md' },
        { action: 'set-goal', intent: 'threads/x.md', goal: 'goal-a' },
      ]) {
        const r = await post(port, bad);
        assert.ok(r.status === 400 || r.status === 404, `expected refusal for ${JSON.stringify(bad)}, got ${r.status}`);
      }
      const r = await post(port, { action: 'attach', spec: 'specs/no-such-spec/', intent: 'intents/2026-01-01-existing.md' });
      assert.equal(r.status, 404);
    });

    await t.test('unknown action is rejected', async () => {
      const r = await post(port, { action: 'frobnicate' });
      assert.equal(r.status, 400);
    });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

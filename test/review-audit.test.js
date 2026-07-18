'use strict';
// /api/review — the audit line behind the human gate (ui/server.js hReview).
// Incident 2026-07-14 (threads/2026-07-14-judge-drain-stage-advance-without-
// verification.md): a cockpit accept left nothing on disk, so it was
// indistinguishable from an agent folder-move. Covers: accept stamps
// accepted_by/accepted_at/gate and appends {date, spec, action, via, gate} to
// _metrics/review-log.jsonl; kick-back does the equivalent; an accept past a
// failing canAdvanceToReview still succeeds but is flagged gate: unverified
// (visible flag, never a block); the log is append-only; historical unstamped
// done/ specs are left untouched; a workspace without a verification policy
// records gate: verified (gate not enforced ≠ gate failed).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { parseFrontmatter } = require('../lib/parse');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const WS = 'wsreview';        // verification.require_independent_verifier: true
const WS_NOGATE = 'wsnogate'; // no verification section — gate not enforced

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const specMd = slug => `---
title: "${slug}"
created: 2026-07-01
project: "${WS}"
type: "feature"
status: "in-review"
claimed_by: "claude"
---

# ${slug}
`;

const alignmentMd = slug => `---
spec: "in-review/${slug}/"
builder: "claude"
verifier: "codex"
verification_type: "independent"
rounds: 1
verdict: "pass"
residual_concerns: []
---

# Alignment

Round 1: verifier reviewed the diff, no concerns.
`;

const LEGACY_RAW = `---
title: "legacy-spec"
created: 2026-06-01
project: "${WS}"
type: "feature"
status: "done"
---

# legacy-spec (accepted before the audit line existed — no stamps, stays valid)
`;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-reviewaudit-'));
  const dir = path.join(root, 'projects', WS);
  for (const slug of ['verified-spec', 'unverified-spec', 'kick-spec']) {
    fs.mkdirSync(path.join(dir, 'in-review', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'in-review', slug, 'SPEC.md'), specMd(slug));
  }
  fs.mkdirSync(path.join(dir, 'in-review', 'verified-spec', 'outcome'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'in-review', 'verified-spec', 'outcome', 'ALIGNMENT.md'), alignmentMd('verified-spec'));
  fs.mkdirSync(path.join(dir, 'done', 'legacy-spec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'done', 'legacy-spec', 'SPEC.md'), LEGACY_RAW);
  fs.writeFileSync(path.join(dir, 'TRIAGE.yml'),
    'verification:\n  require_independent_verifier: true\n  allow_self_check_for: []\n');

  const dir2 = path.join(root, 'projects', WS_NOGATE);
  fs.mkdirSync(path.join(dir2, 'in-review', 'free-spec'), { recursive: true });
  fs.writeFileSync(path.join(dir2, 'in-review', 'free-spec', 'SPEC.md'),
    specMd('free-spec').replace(`"${WS}"`, `"${WS_NOGATE}"`));
  fs.writeFileSync(path.join(dir2, 'TRIAGE.yml'), 'goals: []\n');
  return { root, dir, dir2 };
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

// same-session write token — POSTs need the token the server injects at GET /
async function fetchToken(port) {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  return (html.match(/window\.TL_WRITE_TOKEN="([0-9a-f]+)"/) || [])[1] || '';
}

let TOKEN = '';
async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tl-token': TOKEN },
    body: JSON.stringify({ ws: WS, ...body }),
  });
  return { status: r.status, body: await r.json() };
}

const readLog = dir => (fs.existsSync(path.join(dir, '_metrics', 'review-log.jsonl'))
  ? fs.readFileSync(path.join(dir, '_metrics', 'review-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  : []);

test('review audit line and reviewer stamp', async t => {
  const { root, dir, dir2 } = makeRoot();
  const port = 45000 + (process.pid % 2000);
  const { child, ready } = startServer(root, port);
  let firstRow = null;
  try {
    await ready;
    TOKEN = await fetchToken(port);

    await t.test('accept with a passing gate: stamps the spec and logs gate: verified', async () => {
      const r = await post(port, { action: 'accept', spec: 'in-review/verified-spec/' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.path, 'done/verified-spec/');
      assert.equal(r.body.gate, 'verified');
      const raw = fs.readFileSync(path.join(dir, 'done', 'verified-spec', 'SPEC.md'), 'utf8');
      const { meta } = parseFrontmatter(raw);
      assert.equal(meta.status, 'done');
      assert.equal(meta.accepted_by, 'human-cockpit');
      assert.match(String(meta.accepted_at), ISO_TS);
      assert.equal(meta.gate, 'verified');
      assert.match(raw, /\n# verified-spec\n/);                    // body untouched
      const rows = readLog(dir);
      assert.equal(rows.length, 1);
      firstRow = rows[0];
      assert.match(String(firstRow.date), ISO_TS);
      assert.equal(firstRow.spec, 'in-review/verified-spec/');
      assert.equal(firstRow.action, 'accepted');
      assert.equal(firstRow.via, 'cockpit');
      assert.equal(firstRow.gate, 'verified');
    });

    await t.test('accept past a failing gate: succeeds (never blocks) but records gate: unverified', async () => {
      const r = await post(port, { action: 'accept', spec: 'in-review/unverified-spec/' });
      assert.equal(r.status, 200, JSON.stringify(r.body));         // recorded, not blocked
      assert.equal(r.body.gate, 'unverified');
      assert.ok(fs.existsSync(path.join(dir, 'done', 'unverified-spec', 'SPEC.md')));
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, 'done', 'unverified-spec', 'SPEC.md'), 'utf8'));
      assert.equal(meta.status, 'done');
      assert.equal(meta.accepted_by, 'human-cockpit');
      assert.match(String(meta.accepted_at), ISO_TS);
      assert.equal(meta.gate, 'unverified');                       // the visible flag on the card
      const rows = readLog(dir);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].spec, 'in-review/unverified-spec/');
      assert.equal(rows[1].action, 'accepted');
      assert.equal(rows[1].via, 'cockpit');
      assert.equal(rows[1].gate, 'unverified');
    });

    await t.test('kick-back: stamps kicked_back_by/at and logs action: kicked-back', async () => {
      const r = await post(port, { action: 'reject', spec: 'in-review/kick-spec/', note: 'tests are thin' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.path, 'in-progress/kick-spec/');
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, 'in-progress', 'kick-spec', 'SPEC.md'), 'utf8'));
      assert.equal(meta.status, 'in-progress');
      assert.equal(meta.kicked_back_by, 'human-cockpit');
      assert.match(String(meta.kicked_back_at), ISO_TS);
      assert.equal(meta.gate, 'unverified');                       // no ALIGNMENT under the policy
      // pre-existing kick-back behavior is unchanged: note + continuation dispatch
      assert.match(fs.readFileSync(path.join(dir, 'in-progress', 'kick-spec', 'NOTES.md'), 'utf8'), /kicked back\ntests are thin/);
      assert.ok(fs.existsSync(path.join(dir, '_dispatch', 'kick-spec.json')));
      const rows = readLog(dir);
      assert.equal(rows.length, 3);
      assert.equal(rows[2].spec, 'in-review/kick-spec/');
      assert.equal(rows[2].action, 'kicked-back');
      assert.equal(rows[2].via, 'cockpit');
      assert.equal(rows[2].gate, 'unverified');
    });

    await t.test('the log is append-only: earlier rows are never rewritten', async () => {
      const rows = readLog(dir);
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[0], firstRow);                         // row 1 byte-identical after two more writes
    });

    await t.test('historical unstamped done/ specs are left untouched (no retro-validation)', async () => {
      const raw = fs.readFileSync(path.join(dir, 'done', 'legacy-spec', 'SPEC.md'), 'utf8');
      assert.equal(raw, LEGACY_RAW);
      const { meta } = parseFrontmatter(raw);
      assert.equal(meta.accepted_by ?? '', '');
      assert.equal(meta.gate ?? '', '');
    });

    await t.test('no verification policy: accept without ALIGNMENT records gate: verified', async () => {
      const r = await post(port, { ws: WS_NOGATE, action: 'accept', spec: 'in-review/free-spec/' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.gate, 'verified');                       // gate not enforced ≠ gate failed
      const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir2, 'done', 'free-spec', 'SPEC.md'), 'utf8'));
      assert.equal(meta.gate, 'verified');
      const rows = readLog(dir2);                                  // logged in its own workspace
      assert.equal(rows.length, 1);
      assert.equal(rows[0].via, 'cockpit');
      assert.equal(rows[0].gate, 'verified');
      assert.equal(readLog(dir).length, 3);                        // and not cross-written
    });

    await t.test('guards unchanged: non-in-review paths and unknown actions still refused', async () => {
      for (const bad of [
        { action: 'accept', spec: 'done/legacy-spec/' },
        { action: 'accept', spec: 'in-review/no-such-spec/' },
        { action: 'frobnicate', spec: 'in-review/verified-spec/' },
      ]) {
        const r = await post(port, bad);
        assert.ok(r.status === 400 || r.status === 404, `expected refusal for ${JSON.stringify(bad)}, got ${r.status}`);
      }
      assert.equal(readLog(dir).length, 3);                        // refusals never log
    });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

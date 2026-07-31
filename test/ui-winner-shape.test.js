'use strict';
// test/ui-winner-shape.test.js — the Review winner panel binds the shipped
// WINNER.json shape (lib/experiment-apply: state, decided_by / decision_source,
// decided_at, patch_path + patch_sha256, reason, error_summary, review_artifact)
// plus the _metrics/winner-log.jsonl decision history, with the legacy
// /api/experiment mapping (set_by / apply_state / apply_error) only as the
// degrade path when no WINNER.json exists.
//
// Two layers:
//  1. HTML contract — the client reads the real field names and fetches the
//     raw record/log via /api/file (the server's /api/experiment still maps
//     legacy names; do-not-touch for this spec).
//  2. Server integration — an authentic WINNER.json written by
//     lib/experiment-apply.selectWinner is reachable through the exact
//     /api/file paths the panel uses, and parses with the real field names.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const UI_HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const { selectWinner } = require('../lib/experiment-apply.js');

const WS = 'winner-shape-ws';
const EXP = 'exp-20260731000000-winner-shape';

test('HTML contract: winner panel binds the real WINNER.json fields', () => {
  // raw record + decision log come straight from the workspace files
  assert.match(UI_HTML, /_experiments\/\$\{id\}\/WINNER\.json/);
  assert.match(UI_HTML, /_metrics\/winner-log\.jsonl/);
  assert.match(UI_HTML, /\/api\/file\?ws=/);
  // real field names drive the view model
  for (const f of ['decided_by', 'decision_source', 'decided_at', 'patch_sha256', 'error_summary', 'review_artifact']) {
    assert.match(UI_HTML, new RegExp(`rec\\.${f}`), `winnerModel must read rec.${f}`);
  }
  assert.match(UI_HTML, /rec\.state\b/);
  // decision trail + history are rendered, not just parsed
  assert.match(UI_HTML, /decided by /);
  assert.match(UI_HTML, /decision log/i);
  assert.match(UI_HTML, /overrides the judge/);
  assert.match(UI_HTML, /exp-artifact-btn/);
  // every winner state the apply lib can write has a badge class
  for (const st of ['selected', 'applied', 'rejected', 'apply-failed', 'superseded', 'sent-to-review']) {
    assert.ok(UI_HTML.includes(`'${st}'`), `EXP_ST must include ${st}`);
  }
});

test('HTML contract: legacy names survive only as the degrade path', () => {
  // fallback branch still reads the legacy server mapping…
  assert.match(UI_HTML, /w\.apply_state \|\| 'selected'/);
  assert.match(UI_HTML, /w\.set_by/);
  // …but the record branch never touches legacy names
  const model = UI_HTML.match(/function winnerModel\([\s\S]*?\n}/);
  assert.ok(model, 'winnerModel missing');
  const recordBranch = model[0].slice(0, model[0].indexOf('const w = legacy'));
  assert.doesNotMatch(recordBranch, /apply_state|set_by|human_override/);
});

test('server integration: authentic WINNER.json + log reachable via /api/file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-winner-shape-'));
  const dir = path.join(root, 'projects', WS);
  const expDir = path.join(dir, '_experiments', EXP);
  fs.mkdirSync(path.join(expDir, 'candidates', 'cand-a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), `---\nname: "${WS}"\nrepo: "${ROOT}"\n---\n`);
  fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), 'goals: []\n');
  fs.writeFileSync(path.join(expDir, 'EXPERIMENT.md'),
    `---\nid: "${EXP}"\ntl_spec: "specs/x/"\nbase_commit: "abc123"\nstatus: "succeeded"\nprimary_agent: "claude"\n---\n\n# ${EXP}\n`);
  fs.writeFileSync(path.join(expDir, 'candidates', 'cand-a', 'PATCH.diff'),
    'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  fs.writeFileSync(path.join(expDir, 'candidates', 'cand-a', 'METRICS.json'),
    JSON.stringify({ candidate_id: 'cand-a', status: 'succeeded', role: 'primary' }));

  // the real writer, not a hand-rolled file — shape drift breaks this test
  const rec = selectWinner(dir, EXP, 'cand-a', { decidedBy: 'tester', decisionSource: 'human' });
  assert.equal(rec.state, 'selected');

  const port = 45500 + (process.pid % 1500);
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', d => { out += d; if (out.includes('tl ui')) resolve(); });
      child.stderr.on('data', d => { out += d; });
      child.on('exit', code => reject(new Error('server exited early (' + code + '): ' + out)));
      setTimeout(() => reject(new Error('server did not start: ' + out)), 8000).unref();
    });

    // 1. the exact fetch the panel performs for the record
    let r = await fetch(`http://127.0.0.1:${port}/api/file?ws=${WS}&path=${encodeURIComponent(`_experiments/${EXP}/WINNER.json`)}`);
    assert.equal(r.status, 200);
    const winner = JSON.parse((await r.json()).content);
    assert.equal(winner.candidate_id, 'cand-a');
    assert.equal(winner.state, 'selected');
    assert.equal(winner.decided_by, 'tester');
    assert.equal(winner.decision_source, 'human');
    assert.ok(winner.decided_at, 'decided_at missing');
    assert.match(winner.patch_sha256, /^[0-9a-f]{64}$/);
    assert.ok('reason' in winner && 'error_summary' in winner && 'review_artifact' in winner);

    // 2. the decision log the history section reads
    r = await fetch(`http://127.0.0.1:${port}/api/file?ws=${WS}&path=${encodeURIComponent('_metrics/winner-log.jsonl')}`);
    assert.equal(r.status, 200);
    const rows = (await r.json()).content.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].experiment_id, EXP);
    assert.equal(rows[0].decided_by, 'tester');

    // 3. degrade-path contract unchanged: /api/experiment still serves the
    //    legacy-mapped winner block the fallback branch consumes
    r = await fetch(`http://127.0.0.1:${port}/api/experiment?ws=${WS}&id=${EXP}`);
    assert.equal(r.status, 200);
    const detail = await r.json();
    assert.equal(detail.winner.candidate_id, 'cand-a');
    assert.ok('set_by' in detail.winner && 'apply_state' in detail.winner);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

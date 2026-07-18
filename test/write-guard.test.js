'use strict';
// The localhost POST write guard (ui/server.js). The cockpit binds to
// 127.0.0.1 but any page open in the local browser can still fire
// cross-origin POSTs at localhost — so every mutating POST must carry the
// per-process token injected into the HTML served at GET /. Covers: the
// token is served in the page and nowhere on disk; a same-session POST
// (token in x-tl-token) succeeds; missing/wrong token is a clear 403 with a
// hint and no write; a cross-origin-shaped request (foreign Origin/Referer)
// is 403 even WITH a valid token; local origins pass; the guard fronts the
// whole write surface uniformly (spot-checked on a second route); the GET
// read surface and SSE stay tokenless; and two server processes never mint
// the same token (per-process, not per-install).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.js');
const WS = 'wsguard';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-writeguard-'));
  const dir = path.join(root, 'projects', WS);
  fs.mkdirSync(path.join(dir, 'threads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'triage', 'held-spec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'triage', 'held-spec', 'SPEC.md'),
    `---\ntitle: "held-spec"\ncreated: 2026-07-01\nproject: "${WS}"\ntype: "feature"\nstatus: "triage"\n---\n\n# held-spec\n`);
  fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), 'goals: []\n');
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

// the same bootstrap the browser gets: GET / and read the injected token
async function fetchToken(port) {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const m = html.match(/window\.TL_WRITE_TOKEN="([0-9a-f]+)"/);
  return { html, token: m ? m[1] : null };
}

async function post(port, pathname, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ws: WS, ...body }),
  });
  return { status: r.status, body: await r.json() };
}

const threadCount = dir => fs.readdirSync(path.join(dir, 'threads')).length;

test('localhost POST write guard', async t => {
  const { root, dir } = makeRoot();
  const port = 46000 + (process.pid % 2000);
  const { child, ready } = startServer(root, port);
  let token = null;
  try {
    await ready;

    await t.test('GET / serves a per-process token in the page, and it is not persisted to disk', async () => {
      const got = await fetchToken(port);
      token = got.token;
      assert.ok(token, 'token script missing from served HTML');
      assert.ok(token.length >= 32, 'token too short to be a real secret');
      assert.match(got.html, /<script>window\.TL_WRITE_TOKEN="/);
      // never persisted: the token appears nowhere under the served root
      const hits = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d)) {
          const p = path.join(d, e);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (fs.readFileSync(p, 'utf8').includes(token)) hits.push(p);
        }
      })(root);
      assert.deepEqual(hits, []);
    });

    await t.test('missing token: 403 with a hint, and nothing is written', async () => {
      const before = threadCount(dir);
      const r = await post(port, '/api/capture', { text: 'should be refused' });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'missing or bad write token');
      assert.match(String(r.body.hint), /x-tl-token/);
      assert.match(String(r.body.hint), /reload the cockpit tab/);
      assert.equal(threadCount(dir), before);
    });

    await t.test('wrong token: 403, nothing written', async () => {
      const before = threadCount(dir);
      const r = await post(port, '/api/capture', { text: 'still refused' }, { 'x-tl-token': 'f'.repeat(token.length) });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'missing or bad write token');
      assert.equal(threadCount(dir), before);
    });

    await t.test('same-session token: the write goes through', async () => {
      const r = await post(port, '/api/capture', { text: 'accepted with token' }, { 'x-tl-token': token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.equal(threadCount(dir), 1);
    });

    await t.test('cross-origin-shaped request: foreign Origin is 403 even with a valid token', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:9999', 'null']) {
        const r = await post(port, '/api/capture', { text: 'cross-origin' }, { 'x-tl-token': token, Origin: origin });
        assert.equal(r.status, 403, `origin ${origin} should be refused`);
        assert.equal(r.body.error, 'cross-origin POST refused');
      }
      const ref = await post(port, '/api/capture', { text: 'cross-origin' }, { 'x-tl-token': token, Referer: 'https://evil.example/page' });
      assert.equal(ref.status, 403);
      assert.equal(ref.body.error, 'cross-origin POST refused');
      assert.equal(threadCount(dir), 1); // none of the above wrote
    });

    await t.test('the served origin passes: browser-stamped local Origin + token is accepted', async () => {
      for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
        const r = await post(port, '/api/capture', { text: `same-origin ok via ${origin}` }, { 'x-tl-token': token, Origin: origin });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      assert.equal(threadCount(dir), 3);
    });

    await t.test('the guard fronts the whole write surface: another route, same 403/200 behavior', async () => {
      const bare = await post(port, '/api/release', { spec: 'triage/held-spec/' });
      assert.equal(bare.status, 403);
      assert.equal(bare.body.error, 'missing or bad write token');
      assert.ok(fs.existsSync(path.join(dir, 'triage', 'held-spec')));   // not moved
      const ok = await post(port, '/api/release', { spec: 'triage/held-spec/' }, { 'x-tl-token': token });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(fs.existsSync(path.join(dir, 'specs', 'held-spec', 'SPEC.md')));
    });

    await t.test('the read surface stays tokenless: GET APIs and SSE are untouched', async () => {
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspaces`)).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/ws/${WS}`)).status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/changes`)).status, 200);
      // SSE: connects and greets without a token
      const ac = new AbortController();
      const sse = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
      assert.equal(sse.status, 200);
      assert.equal(sse.headers.get('content-type'), 'text/event-stream');
      const first = await sse.body.getReader().read();
      assert.match(Buffer.from(first.value).toString(), /: connected/);
      ac.abort();
    });

    await t.test('per-process: a second server process mints a different token', async () => {
      const { root: root2 } = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'tl-writeguard2-')) };
      fs.mkdirSync(path.join(root2, 'projects'), { recursive: true });
      const port2 = port + 2001;
      const other = startServer(root2, port2);
      try {
        await other.ready;
        const { token: token2 } = await fetchToken(port2);
        assert.ok(token2);
        assert.notEqual(token2, token);
        // and tokens do not cross processes: this server's token is rejected there
        const r = await post(port2, '/api/capture', { text: 'wrong process' }, { 'x-tl-token': token });
        assert.equal(r.status, 403);
      } finally {
        other.child.kill();
        fs.rmSync(root2, { recursive: true, force: true });
      }
    });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
// tl UI server — zero dependencies, read-only.
// Usage: node ui/server.js [--port 4400] [--root <repo root>]

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(arg('port', '4400'), 10);
const ROOT = path.resolve(arg('root', process.cwd()));

// ---------- tiny YAML subset parser (maps, lists, scalars, inline arrays) ----------

function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line.replace(/\s+$/, '');
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(parseScalar);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    lines.push({ indent: line.match(/^ */)[0].length, content: line.trim() });
  }
  function parseBlock(idx, indent) {
    if (idx >= lines.length) return [null, idx];
    if (lines[idx].content.startsWith('- ') || lines[idx].content === '-') {
      return parseList(idx, lines[idx].indent);
    }
    return parseMap(idx, lines[idx].indent);
  }
  function parseList(idx, indent) {
    const out = [];
    while (idx < lines.length && lines[idx].indent === indent && (lines[idx].content.startsWith('- ') || lines[idx].content === '-')) {
      const rest = lines[idx].content.replace(/^-\s*/, '');
      const kv = rest.match(/^([\w][\w.-]*):(?:\s+(.*))?$/);
      if (kv) {
        const obj = {};
        idx++;
        if (kv[2] !== undefined && kv[2] !== '') obj[kv[1]] = parseScalar(kv[2]);
        else if (idx < lines.length && lines[idx].indent > indent) {
          const [v, ni] = parseBlock(idx, lines[idx].indent);
          obj[kv[1]] = v; idx = ni;
        } else obj[kv[1]] = null;
        while (idx < lines.length && lines[idx].indent > indent && !lines[idx].content.startsWith('- ')) {
          const m = lines[idx].content.match(/^([\w][\w.-]*):(?:\s+(.*))?$/);
          if (!m) break;
          const childIndent = lines[idx].indent;
          if (m[2] !== undefined && m[2] !== '') { obj[m[1]] = parseScalar(m[2]); idx++; }
          else {
            idx++;
            if (idx < lines.length && lines[idx].indent > childIndent) {
              const [v, ni] = parseBlock(idx, lines[idx].indent);
              obj[m[1]] = v; idx = ni;
            } else obj[m[1]] = null;
          }
        }
        out.push(obj);
      } else {
        out.push(parseScalar(rest));
        idx++;
      }
    }
    return [out, idx];
  }
  function parseMap(idx, indent) {
    const obj = {};
    while (idx < lines.length && lines[idx].indent === indent && !lines[idx].content.startsWith('- ')) {
      const m = lines[idx].content.match(/^([\w][\w.-]*):(?:\s+(.*))?$/);
      if (!m) { idx++; continue; }
      if (m[2] !== undefined && m[2] !== '') { obj[m[1]] = parseScalar(m[2]); idx++; }
      else {
        idx++;
        if (idx < lines.length && lines[idx].indent > indent) {
          const [v, ni] = parseBlock(idx, lines[idx].indent);
          obj[m[1]] = v; idx = ni;
        } else obj[m[1]] = null;
      }
    }
    return [obj, idx];
  }
  return parseBlock(0, 0)[0];
}

function parseFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  let meta;
  try { meta = parseYaml(m[1]) || {}; } catch { meta = {}; }
  return { meta, body: m[2] };
}

// ---------- workspace reading ----------

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readFirst(...paths) { for (const p of paths) { const t = safeRead(p); if (t !== null) return t; } return null; }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

function listWorkspaces() {
  const out = [];
  const projects = path.join(ROOT, 'projects');
  if (isDir(projects)) {
    for (const name of fs.readdirSync(projects).sort()) {
      if (isDir(path.join(projects, name))) out.push({ name, dir: path.join(projects, name), example: false });
    }
  }
  const sample = path.join(ROOT, 'examples', 'sample-project');
  if (isDir(sample)) out.push({ name: 'sample-project', dir: sample, example: true });
  return out;
}

function readStage(dir, stage, folder) {
  const stageDir = path.join(dir, folder);
  if (!isDir(stageDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(stageDir).sort()) {
    if (entry.startsWith('.')) continue;
    const p = path.join(stageDir, entry);
    let file = null, isFolder = false;
    if (isDir(p)) { file = path.join(p, 'SPEC.md'); isFolder = true; }
    else if (entry.endsWith('.md')) file = p;
    if (!file) continue;
    const text = safeRead(file);
    if (text === null) continue;
    const { meta, body } = parseFrontmatter(text);
    const item = {
      stage, path: folder + '/' + entry + (isFolder ? '/' : ''),
      title: meta.title || entry.replace(/\.md$/, ''),
      meta, body, mtime: mtime(file),
    };
    if (stage === 'done' && isFolder) {
      const fb = readFirst(path.join(p, 'outcome', 'FEEDBACK.md'), path.join(p, 'outcome', 'feedback.md'));
      if (fb) item.feedback = parseFrontmatter(fb).meta;
    }
    out.push(item);
  }
  return out;
}

function readWorkspace(ws) {
  const dir = ws.dir;
  const configText = readFirst(path.join(dir, 'TRIAGE.yml'), path.join(dir, 'triage.yml'));
  let config = null;
  try { config = configText ? parseYaml(configText) : null; } catch { config = null; }

  const intents = [];
  const intentsDir = path.join(dir, 'intents');
  if (isDir(intentsDir)) {
    for (const f of fs.readdirSync(intentsDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const { meta, body } = parseFrontmatter(safeRead(path.join(intentsDir, f)) || '');
      intents.push({ path: 'intents/' + f, title: meta.title || f, meta, body });
    }
  }

  const specs = [
    ...readStage(dir, 'triage', 'triage'),
    ...readStage(dir, 'ready', 'specs'),
    ...readStage(dir, 'in-progress', 'in-progress'),
    ...readStage(dir, 'tests', 'tests'),
    ...readStage(dir, 'in-review', 'in-review'),
    ...readStage(dir, 'done', 'done'),
  ];

  const threads = [];
  const threadsDir = path.join(dir, 'threads');
  if (isDir(threadsDir)) {
    for (const f of fs.readdirSync(threadsDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const { meta, body } = parseFrontmatter(safeRead(path.join(threadsDir, f)) || '');
      threads.push({ path: 'threads/' + f, title: meta.title || f, meta, body, mtime: mtime(path.join(threadsDir, f)) });
    }
  }

  const metrics = {};
  const metricsDir = path.join(dir, '_metrics');
  if (isDir(metricsDir)) {
    for (const f of fs.readdirSync(metricsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const linesOut = [];
      for (const line of (safeRead(path.join(metricsDir, f)) || '').split('\n')) {
        if (!line.trim()) continue;
        try { linesOut.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
      metrics[f.replace('.jsonl', '')] = linesOut;
    }
  }

  const dispatch = [];
  const dispatchDir = path.join(dir, '_dispatch');
  if (isDir(dispatchDir)) {
    for (const f of fs.readdirSync(dispatchDir).sort()) {
      if (!f.endsWith('.json')) continue;
      try { dispatch.push({ file: '_dispatch/' + f, ...JSON.parse(safeRead(path.join(dispatchDir, f)) || '{}') }); }
      catch { /* skip malformed dispatch */ }
    }
  }

  return {
    name: ws.name, example: ws.example,
    config, intents, specs, threads, metrics, dispatch,
    priorities: readFirst(path.join(dir, 'PRIORITIES.md'), path.join(dir, 'priorities.md')),
    project: parseFrontmatter(safeRead(path.join(dir, 'PROJECT.md')) || '').meta,
  };
}

// ---------- change tracking (snapshot diffs — workspaces aren't in git) ----------

const TEXT_RE = /\.(md|yml|yaml|jsonl|json)$/;
const snapshots = new Map();   // full path -> array of lines
const changes = new Map();     // ws|path -> {ws, path, status, added, removed, ts}

function readLines(p) { const t = safeRead(p); return t === null ? null : t.split('\n'); }

function walkFiles(dir, cb) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const full = path.join(dir, e);
    if (isDir(full)) walkFiles(full, cb);
    else if (TEXT_RE.test(e)) cb(full);
  }
}

function primeSnapshots() {
  for (const ws of listWorkspaces()) walkFiles(ws.dir, f => snapshots.set(f, readLines(f)));
}

function diffCounts(oldL, newL) {
  const m = new Map();
  for (const l of oldL) m.set(l, (m.get(l) || 0) + 1);
  let added = 0;
  for (const l of newL) {
    const c = m.get(l) || 0;
    if (c > 0) m.set(l, c - 1); else added++;
  }
  let removed = 0;
  for (const c of m.values()) removed += c;
  return { added, removed };
}

// LCS line diff -> ops [type, line] where type is ' ', '+', '-'
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4000000) return null; // too big — counts only
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

// keep 2 context lines around changes, collapse the rest into gap markers
function toHunks(ops, maxLines = 120) {
  if (!ops) return null;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o[0] !== ' ') for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
  });
  const out = [];
  let gap = 0;
  for (let i = 0; i < ops.length && out.length < maxLines; i++) {
    if (keep[i]) {
      if (gap) { out.push({ t: '.', n: gap }); gap = 0; }
      out.push({ t: ops[i][0], s: ops[i][1].slice(0, 200) });
    } else gap++;
  }
  if (gap) out.push({ t: '.', n: gap });
  return out;
}

const diffBuffer = [];
function pushDiff(rec, hunks) {
  diffBuffer.push({ ...rec, hunks });
  if (diffBuffer.length > 60) diffBuffer.shift();
}

function trackChange(wsName, rel, full, exists) {
  if (!TEXT_RE.test(rel)) return null;
  let status, added = 0, removed = 0, hunks = null;
  const before = snapshots.get(full);
  if (!exists) {
    if (before == null) return null;
    status = 'D'; removed = before.length;
    hunks = toHunks(before.map(l => ['-', l]));
    snapshots.delete(full);
  } else {
    const now = readLines(full) || [];
    if (before == null) {
      status = 'A'; added = now.length;
      hunks = toHunks(now.map(l => ['+', l]));
    } else {
      status = 'M';
      ({ added, removed } = diffCounts(before, now));
      hunks = toHunks(lcsOps(before, now));
    }
    snapshots.set(full, now);
  }
  const key = wsName + '|' + rel;
  const prev = changes.get(key);
  if (exists && prev && added === 0 && removed === 0) return null; // duplicate watch event, content unchanged
  if (prev && prev.status === 'A' && status === 'M') status = 'A';
  const rec = { ws: wsName, path: rel, status, added, removed, ts: Date.now() };
  changes.set(key, rec);
  if (changes.size > 300) changes.delete(changes.keys().next().value);
  if (added || removed) pushDiff(rec, hunks);
  return rec;
}

// ---------- live events (SSE + fs watch) ----------

const clients = new Set();
function broadcast(obj) {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 30000).unref();

const debounceTimers = new Map();
function watchTree(base, wsOf) {
  if (!isDir(base)) return;
  let watcher;
  try {
    watcher = fs.watch(base, { recursive: true }, (event, rel) => {
      if (!rel) return;
      rel = String(rel).replace(/\\/g, '/');
      if (/(^|\/)\.|\.swp$|~$/.test(rel)) return; // dotfiles, editor temp files
      const key = base + '|' + rel;
      clearTimeout(debounceTimers.get(key));
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        const full = path.join(base, rel);
        const ws = wsOf(rel);
        const payload = {
          ws: ws.name, path: ws.rel, exists: fs.existsSync(full), ts: Date.now(),
        };
        const change = trackChange(ws.name, ws.rel, full, payload.exists);
        if (change) {
          payload.change = { status: change.status, added: change.added, removed: change.removed };
          const d = diffBuffer[diffBuffer.length - 1];
          if (d && d.ws === change.ws && d.path === change.path && d.ts === change.ts) payload.diff = d;
        }
        if (ws.rel.endsWith('.jsonl') && payload.exists) {
          const lines = (safeRead(full) || '').trim().split('\n');
          try { payload.log = { file: path.basename(ws.rel, '.jsonl'), line: JSON.parse(lines[lines.length - 1]) }; }
          catch { payload.log = { file: path.basename(ws.rel, '.jsonl'), line: null }; }
        }
        broadcast(payload);
      }, 250));
    });
    watcher.on('error', () => {});
  } catch { /* fs.watch recursive unavailable — feed stays quiet */ }
}

watchTree(path.join(ROOT, 'projects'), rel => {
  const ix = rel.indexOf('/');
  return ix < 0 ? { name: rel, rel: '' } : { name: rel.slice(0, ix), rel: rel.slice(ix + 1) };
});
watchTree(path.join(ROOT, 'examples', 'sample-project'), rel => ({ name: 'sample-project', rel }));
primeSnapshots();

// ---------- http ----------

const INDEX = path.join(__dirname, 'index.html');
const LOGO = path.join(ROOT, 'assets', 'logo.png');

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// resolve a workspace-relative path, refusing anything that escapes the workspace
function safePath(ws, rel) {
  const full = path.resolve(ws.dir, rel);
  if (full !== path.resolve(ws.dir) && !full.startsWith(path.resolve(ws.dir) + path.sep)) return null;
  return full;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'note';
}

// classify a free-text capture into a thread type/status (mirrors /tl capture)
function inferThread(text) {
  const t = text.trim();
  if (/\?$/.test(t) || /^(does|can|should|is|are|how|why|what|when|will|could|would)\b/i.test(t)) return { type: 'question', status: 'open' };
  if (/\b(decid|chose|chosen|will use|going with|adopt)\b/i.test(t)) return { type: 'decision', status: 'closed' };
  if (/\b(risk|might break|could fail|may not|unsafe|vulnerab)\b/i.test(t)) return { type: 'risk', status: 'open' };
  if (/\b(clean ?up|refactor|tech debt|tidy)\b/i.test(t)) return { type: 'cleanup', status: 'parked' };
  if (/\b(follow ?up|later|revisit|then)\b/i.test(t)) return { type: 'followup', status: 'parked' };
  return { type: 'idea', status: 'parked' };
}

function isoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      readBody(req).then(body => handlePost(u.pathname, body, res)).catch(() => json(res, 400, { error: 'bad body' }));
      return;
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(safeRead(INDEX) || 'index.html missing');
    } else if (u.pathname === '/logo.png') {
      const buf = (() => { try { return fs.readFileSync(LOGO); } catch { return null; } })();
      if (buf) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(buf); }
      else { res.writeHead(404); res.end(); }
    } else if (u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (u.pathname === '/api/changes') {
      json(res, 200, Array.from(changes.values()).sort((a, b) => b.ts - a.ts).slice(0, 120));
    } else if (u.pathname === '/api/diffs') {
      json(res, 200, diffBuffer.slice().reverse().slice(0, 40));
    } else if (u.pathname === '/api/tree') {
      const ws = listWorkspaces().find(w => w.name === u.searchParams.get('ws'));
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      const build = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir).filter(e => !e.startsWith('.') && e !== 'node_modules'); } catch { return []; }
        const dirs = entries.filter(e => isDir(path.join(dir, e))).sort();
        const files = entries.filter(e => !isDir(path.join(dir, e))).sort();
        return [
          ...dirs.map(e => ({ name: e, path: rel + e, dir: true, children: build(path.join(dir, e), rel + e + '/') })),
          ...files.map(e => ({ name: e, path: rel + e, dir: false })),
        ];
      };
      json(res, 200, { name: ws.name, tree: build(ws.dir, '') });
    } else if (u.pathname === '/api/file') {
      const ws = listWorkspaces().find(w => w.name === u.searchParams.get('ws'));
      const rel = u.searchParams.get('path') || '';
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      const full = path.resolve(ws.dir, rel);
      if (!full.startsWith(path.resolve(ws.dir) + path.sep)) return json(res, 400, { error: 'bad path' });
      const content = safeRead(full);
      if (content === null) return json(res, 404, { error: 'not found' });
      json(res, 200, { path: rel, content });
    } else if (u.pathname === '/api/workspaces') {
      json(res, 200, listWorkspaces().map(w => ({ name: w.name, example: w.example })));
    } else if (u.pathname.startsWith('/api/ws/')) {
      const name = decodeURIComponent(u.pathname.slice('/api/ws/'.length));
      const ws = listWorkspaces().find(w => w.name === name);
      if (!ws) return json(res, 404, { error: 'unknown workspace' });
      json(res, 200, readWorkspace(ws));
    } else {
      res.writeHead(404); res.end('not found');
    }
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

function handlePost(pathname, body, res) {
  const ws = listWorkspaces().find(w => w.name === body.ws);
  if (!ws) return json(res, 404, { error: 'unknown workspace' });

  if (pathname === '/api/capture') {
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { error: 'empty thought' });
    const inf = inferThread(text);
    const type = body.type || inf.type;
    const status = body.status || inf.status;
    const file = `threads/${isoDate()}-${slugify(text)}.md`;
    const full = safePath(ws, file);
    if (!full) return json(res, 400, { error: 'bad path' });
    if (fs.existsSync(full)) return json(res, 409, { error: 'thread already exists' });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const q = s => String(s).replace(/"/g, "'");
    const fm = `---\ntitle: "${q(text)}"\ncreated: ${isoDate()}\ntype: "${type}"\nstatus: "${status}"\norigin: "${q(body.origin || 'captured in Resume')}"\nlinked_intent: "${q(body.linked_intent || '')}"\nlinked_spec: "${q(body.linked_spec || '')}"\n---\n\n# ${text}\n`;
    fs.writeFileSync(full, fm);
    return json(res, 200, { ok: true, path: file, type, status });
  }

  if (pathname === '/api/goal') {
    const full = safePath(ws, 'TRIAGE.yml');
    let yml = readFirst(full, safePath(ws, 'triage.yml'));
    const target = fs.existsSync(full) ? full : safePath(ws, 'triage.yml');
    if (yml == null) return json(res, 404, { error: 'no TRIAGE.yml' });
    const oldV = String(body.old ?? ''), newV = String(body.new ?? '');
    let replaced = false;
    if (body.field === 'description') {
      const needle = `description: "${oldV}"`;
      if (yml.includes(needle)) { yml = yml.replace(needle, `description: "${newV.replace(/"/g, "'")}"`); replaced = true; }
    } else if (body.field === 'weight') {
      const re = new RegExp(`weight:\\s*${oldV.replace(/[.]/g, '\\.')}(\\s|$)`, 'm');
      if (re.test(yml)) { yml = yml.replace(re, `weight: ${newV}$1`); replaced = true; }
    } else if (body.field === 'kr') {
      const needle = `- "${oldV}"`;
      if (yml.includes(needle)) { yml = yml.replace(needle, `- "${newV.replace(/"/g, "'")}"`); replaced = true; }
    }
    if (!replaced) return json(res, 409, { error: 'value not found — may have changed' });
    fs.writeFileSync(target, yml);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/priority') {
    const rel = String(body.spec || '');
    const full = safePath(ws, rel.endsWith('.md') ? rel : rel.replace(/\/$/, '') + '/SPEC.md');
    if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'spec not found' });
    const p = String(body.priority || '').toLowerCase();
    if (!/^p[0-3]$/.test(p)) return json(res, 400, { error: 'bad priority' });
    let text = safeRead(full);
    const fm0 = text.match(/^priority:\s*"?(p[0-3])"?/m);
    const from = fm0 ? fm0[1] : String(body.from || '').toLowerCase();
    text = /^priority:.*$/m.test(text)
      ? text.replace(/^priority:.*$/m, `priority: "${p}"`)
      : text.replace(/^---\n/, `---\npriority: "${p}"\n`);
    text = /^priority_set_by:.*$/m.test(text)
      ? text.replace(/^priority_set_by:.*$/m, 'priority_set_by: "human"')
      : text.replace(/^(priority:.*\n)/m, '$1priority_set_by: "human"\n');
    fs.writeFileSync(full, text);
    // contrast memory: a human override is a 'this, not that' training example
    if (from && from !== p) {
      try {
        const md = path.join(ws.dir, '_metrics');
        fs.mkdirSync(md, { recursive: true });
        fs.appendFileSync(path.join(md, 'override-log.jsonl'),
          JSON.stringify({ date: isoDate(), spec: rel, from, to: p, reason: String(body.reason || ''), source: 'resume-ui' }) + '\n');
      } catch {}
    }
    return json(res, 200, { ok: true, from });
  }

  if (pathname === '/api/thread-status') {
    const rel = String(body.path || '');
    if (!/^(threads|intents)\//.test(rel) || !rel.endsWith('.md')) return json(res, 400, { error: 'not a thread or intent' });
    const full = safePath(ws, rel);
    if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'file not found' });
    const st = String(body.status || '');
    if (!['open', 'parked', 'promoted', 'closed', 'draft', 'approved', 'decomposed', 'done'].includes(st)) return json(res, 400, { error: 'bad status' });
    let text = safeRead(full);
    text = /^status:.*$/m.test(text) ? text.replace(/^status:.*$/m, `status: "${st}"`) : text.replace(/^---\n/, `---\nstatus: "${st}"\n`);
    fs.writeFileSync(full, text);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/research') {
    const title = String(body.title || '').trim();
    if (!title) return json(res, 400, { error: 'empty topic' });
    const slug = 'research-' + slugify(title);
    const dir = safePath(ws, 'specs/' + slug);
    if (!dir) return json(res, 400, { error: 'bad path' });
    if (fs.existsSync(dir)) return json(res, 409, { error: 'research spec already exists' });
    fs.mkdirSync(dir, { recursive: true });
    const q = s => String(s).replace(/"/g, "'");
    const src = body.source ? String(body.source) : '';
    const spec = `---
title: "Research: ${q(title)}"
created: ${isoDate()}
project: "${ws.name}"
intent: ""
type: "research"
status: "ready"
priority: ""
priority_set_by: ""
size: "small"
depends_on: []
blocks: []
tags: [research]
origin: "${q(src || 'dispatched from resume')}"
---

# Research: ${title}

## Objective

Investigate this question and recommend a direction — do not implement. Produce a recommendation the human can decide on.

## Question

${title}

## Deliverable

- A short recommendation ("this, not that") with the reasoning
- Options considered and why the recommended one wins
- Anything that would change the recommendation
`;
    fs.writeFileSync(path.join(dir, 'SPEC.md'), spec);
    if (src && /^threads\//.test(src)) {
      const tf = safePath(ws, src);
      if (tf && fs.existsSync(tf)) {
        let t = safeRead(tf);
        if (/^status:.*$/m.test(t)) { t = t.replace(/^status:.*$/m, 'status: "promoted"'); fs.writeFileSync(tf, t); }
      }
    }
    return json(res, 200, { ok: true, path: 'specs/' + slug + '/' });
  }

  if (pathname === '/api/dispatch') {
    // producer side of the dispatch queue: write an intent-to-run file. Never executes.
    const rel = String(body.spec || '');
    if (!/^specs\//.test(rel)) return json(res, 400, { error: 'only ready specs can be dispatched' });
    const specFull = safePath(ws, rel.endsWith('.md') ? rel : rel.replace(/\/$/, '') + '/SPEC.md');
    if (!specFull || !fs.existsSync(specFull)) return json(res, 404, { error: 'spec not found' });
    const meta = parseFrontmatter(safeRead(specFull) || '').meta;
    if (meta.status === 'blocked') return json(res, 409, { error: 'spec is blocked — unblock before dispatching' });
    const slug = rel.replace(/\/$/, '').split('/').pop().replace(/\.md$/, '');
    const dispFull = safePath(ws, '_dispatch/' + slug + '.json');
    if (!dispFull) return json(res, 400, { error: 'bad path' });
    // idempotent: a pending/claimed dispatch already exists — no duplicate
    if (fs.existsSync(dispFull)) {
      try { const ex = JSON.parse(safeRead(dispFull) || '{}'); if (ex.status === 'pending' || ex.status === 'claimed') return json(res, 200, { ok: true, already: true, status: ex.status }); } catch {}
    }
    let goal = '';
    const intent = meta.intent || '';
    if (intent) {
      const itFull = safePath(ws, intent.replace(/^\.\//, ''));
      if (itFull && fs.existsSync(itFull)) { try { goal = (parseFrontmatter(safeRead(itFull)).meta.goals || [])[0] || ''; } catch {} }
    }
    const rec = {
      spec: rel.replace(/\/$/, '') + (rel.endsWith('.md') ? '' : '/'),
      intent, goal, repo: meta.repo || '',
      status: 'pending', created: new Date().toISOString(),
      claimed_by: null, claimed_at: null, finished_at: null,
    };
    fs.mkdirSync(path.dirname(dispFull), { recursive: true });
    fs.writeFileSync(dispFull, JSON.stringify(rec, null, 2) + '\n');
    return json(res, 200, { ok: true, file: '_dispatch/' + slug + '.json' });
  }

  return json(res, 404, { error: 'unknown endpoint' });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tl ui → http://localhost:${PORT}  (root: ${ROOT})`);
  if (args.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${cmd} http://localhost:${PORT}`);
  }
});

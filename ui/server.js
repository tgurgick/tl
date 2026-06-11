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
      const fb = safeRead(path.join(p, 'outcome', 'feedback.md'));
      if (fb) item.feedback = parseFrontmatter(fb).meta;
    }
    out.push(item);
  }
  return out;
}

function readWorkspace(ws) {
  const dir = ws.dir;
  const configText = safeRead(path.join(dir, 'triage.yml'));
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
    ...readStage(dir, 'done', 'done'),
  ];

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

  return {
    name: ws.name, example: ws.example,
    config, intents, specs, metrics,
    priorities: safeRead(path.join(dir, 'priorities.md')),
    project: parseFrontmatter(safeRead(path.join(dir, 'PROJECT.md')) || '').meta,
  };
}

// ---------- change tracking (snapshot diffs — workspaces aren't in git) ----------

const TEXT_RE = /\.(md|yml|yaml|jsonl)$/;
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

function trackChange(wsName, rel, full, exists) {
  if (!TEXT_RE.test(rel)) return null;
  let status, added = 0, removed = 0;
  const before = snapshots.get(full);
  if (!exists) {
    if (before == null) return null;
    status = 'D'; removed = before.length;
    snapshots.delete(full);
  } else {
    const now = readLines(full) || [];
    if (before == null) { status = 'A'; added = now.length; }
    else { status = 'M'; ({ added, removed } = diffCounts(before, now)); }
    snapshots.set(full, now);
  }
  const key = wsName + '|' + rel;
  const prev = changes.get(key);
  if (exists && prev && added === 0 && removed === 0) return null; // duplicate watch event, content unchanged
  if (prev && prev.status === 'A' && status === 'M') status = 'A';
  const rec = { ws: wsName, path: rel, status, added, removed, ts: Date.now() };
  changes.set(key, rec);
  if (changes.size > 300) changes.delete(changes.keys().next().value);
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
        if (change) payload.change = { status: change.status, added: change.added, removed: change.removed };
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
const ICON = path.join(ROOT, 'assets', 'icon.png');

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(safeRead(INDEX) || 'index.html missing');
    } else if (u.pathname === '/logo.png' || u.pathname === '/icon.png') {
      const buf = (() => { try { return fs.readFileSync(u.pathname === '/icon.png' ? ICON : LOGO); } catch { return null; } })();
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tl ui → http://localhost:${PORT}  (root: ${ROOT})`);
  if (args.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${cmd} http://localhost:${PORT}`);
  }
});

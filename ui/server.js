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

// ---------- http ----------

const INDEX = path.join(__dirname, 'index.html');
const LOGO = path.join(ROOT, 'assets', 'logo.png');

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
    } else if (u.pathname === '/logo.png') {
      const buf = (() => { try { return fs.readFileSync(LOGO); } catch { return null; } })();
      if (buf) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(buf); }
      else { res.writeHead(404); res.end(); }
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
});

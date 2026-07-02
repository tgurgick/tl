#!/usr/bin/env node
// tl — the throughline CLI. Zero dependencies, Node stdlib only.
//
// Thin, deterministic glue: each subcommand does the file work (resolve the
// workspace, read the stages, evaluate conflicts) and then prints the matching
// SKILL.md as a prompt for whatever agent is running. The CLI does the
// bookkeeping; the agent supplies the reasoning.
//
//   tl resume [ws]        reconstruct context — stage counts, ready top, open loops
//   tl run    [ws] [spec] work the ready queue — pick the conflict-free batch
//   tl review [ws]        sign off in-review work — criteria + feedback
//
// Workspace resolution mirrors the skills: an arg names a workspace under
// projects/, or if exactly one exists use it, else list and error.

const fs = require('fs');
const path = require('path');

// The repo root is the parent of bin/ — the CLI is installed from this repo.
const ROOT = path.resolve(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');

// ---------- tiny file helpers (mirrors ui/server.js) ----------

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readFirst(...paths) { for (const p of paths) { const t = safeRead(p); if (t !== null) return t; } return null; }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

// Frontmatter: split the leading --- YAML block from the body. We only need a
// handful of scalar/list fields, so this is a deliberately small parser (not the
// full YAML subset in ui/server.js — just enough for the fields the skills read).
function parseFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  return { meta: parseMeta(m[1]), body: m[2] };
}

function parseMeta(yaml) {
  const meta = {};
  for (const raw of String(yaml).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = line.match(/^([\w][\w.-]*):\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = parseScalar(m[2]);
  }
  return meta;
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return '';
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(x => parseScalar(x));
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

// ---------- workspace resolution (same convention as the skills) ----------

function listWorkspaces() {
  const out = [];
  const projects = path.join(ROOT, 'projects');
  if (isDir(projects)) {
    for (const name of fs.readdirSync(projects).sort()) {
      if (isDir(path.join(projects, name))) out.push({ name, dir: path.join(projects, name) });
    }
  }
  return out;
}

// An arg names a workspace; else if exactly one exists use it; else list + error.
function resolveWorkspace(arg) {
  const all = listWorkspaces();
  if (arg) {
    const hit = all.find(w => w.name === arg);
    if (hit) return hit;
    fail(`Unknown workspace "${arg}". Available: ${all.map(w => w.name).join(', ') || '(none)'}`);
  }
  if (all.length === 1) return all[0];
  if (all.length === 0) fail('No workspaces found under projects/.');
  fail(`Multiple workspaces — name one: ${all.map(w => w.name).join(', ')}`);
}

function fail(msg) { process.stderr.write('tl: ' + msg + '\n'); process.exit(1); }

// ---------- stage reading (stage -> folder, from _templates/SCHEMA.md) ----------

// A spec's lifecycle stage IS its folder. This is the triage -> done ladder.
const STAGES = [
  ['triage', 'triage'],
  ['ready', 'specs'],
  ['in-progress', 'in-progress'],
  ['tests', 'tests'],
  ['in-review', 'in-review'],
  ['done', 'done'],
];

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
    const rel = folder + '/' + entry + (isFolder ? '/' : '');
    const item = {
      stage, path: rel, dir: isFolder ? p : null,
      title: meta.title || entry.replace(/\.md$/, ''),
      meta, body, mtime: mtime(file),
      notes: isFolder ? safeRead(path.join(p, 'NOTES.md')) : null,
    };
    if (isFolder) {
      const fb = readFirst(path.join(p, 'outcome', 'FEEDBACK.md'), path.join(p, 'outcome', 'feedback.md'));
      item.feedback = fb;
    }
    out.push(item);
  }
  return out;
}

function readAllSpecs(dir) {
  const specs = [];
  for (const [stage, folder] of STAGES) specs.push(...readStage(dir, stage, folder));
  return specs;
}

function readThreads(dir) {
  const out = [];
  const threadsDir = path.join(dir, 'threads');
  if (!isDir(threadsDir)) return out;
  for (const f of fs.readdirSync(threadsDir).sort()) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const { meta, body } = parseFrontmatter(safeRead(path.join(threadsDir, f)) || '');
    out.push({ path: 'threads/' + f, title: meta.title || f, meta, body });
  }
  return out;
}

// ---------- body section extraction ----------

// Pull one markdown section by its heading (## Foo ... up to the next ## / ###).
function section(body, heading) {
  const lines = String(body).split('\n');
  const norm = heading.toLowerCase();
  let start = -1, hLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,6})\s+(.*)$/);
    if (m && m[2].trim().toLowerCase().replace(/[:]+$/, '') === norm) { start = i + 1; hLevel = m[1].length; break; }
  }
  if (start < 0) return '';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,6})\s+/);
    if (m && m[1].length <= hLevel) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// The declared write scope of a code spec — the `- \`path\`` list under
// "### Files to touch". Undeclared scope => empty (can't be proven disjoint).
function filesToTouch(spec) {
  const scope = section(spec.body, 'Files to touch');
  const files = [];
  for (const line of scope.split('\n')) {
    const m = line.match(/^\s*[-*]\s+`([^`]+)`/);
    if (!m) continue;
    // a single bullet may list several comma-separated paths
    for (const part of m[1].split(',')) {
      const f = part.trim();
      if (f) files.push(f);
    }
  }
  return files;
}

function isReadOnly(spec) {
  const type = String(spec.meta.type || '').toLowerCase();
  if (type === 'research') return true;
  return filesToTouch(spec).length === 0 && !section(spec.body, 'Files to touch');
}

function priorityRank(p) {
  const m = String(p || '').toLowerCase().match(/^p([0-3])$/);
  return m ? Number(m[1]) : 9; // no priority sorts last
}

// ---------- SKILL printing ----------

function printSkill(name) {
  const text = safeRead(path.join(SKILLS, name, 'SKILL.md'));
  if (text === null) { fail(`skills/${name}/SKILL.md not found — cannot print the procedure.`); }
  // strip the frontmatter; print the procedure body the agent should follow
  const { body } = parseFrontmatter(text);
  out('===== SKILL: ' + name + ' (follow this procedure) =====\n');
  out(body.trim() + '\n');
  out('===== END SKILL =====\n');
}

function out(s) { process.stdout.write(s + '\n'); }
function hr() { out('---'); }

// ---------- tl resume ----------

function cmdResume(args) {
  const ws = resolveWorkspace(args[0]);
  printSkill('resume');

  const specs = readAllSpecs(ws.dir);
  const threads = readThreads(ws.dir);
  const priorities = readFirst(path.join(ws.dir, 'PRIORITIES.md'), path.join(ws.dir, 'priorities.md'));
  const triage = readFirst(path.join(ws.dir, 'TRIAGE.yml'), path.join(ws.dir, 'triage.yml'));

  out('\n===== SNAPSHOT: ' + ws.name + ' =====\n');

  // stage counts
  const counts = {};
  for (const [stage] of STAGES) counts[stage] = 0;
  for (const s of specs) counts[s.stage] = (counts[s.stage] || 0) + 1;
  out('## Stage counts');
  out(STAGES.map(([stage]) => `${stage}: ${counts[stage]}`).join('  ·  '));

  // most recently touched done spec (what changed while away)
  const done = specs.filter(s => s.stage === 'done').sort((a, b) => b.mtime - a.mtime);
  if (done.length) {
    out('\n## Recently completed');
    out(`${done.length} in done/ — latest: ${done[0].title} (${done[0].path})`);
  }

  // in-progress
  const inProgress = specs.filter(s => s.stage === 'in-progress');
  if (inProgress.length) {
    out('\n## In progress');
    for (const s of inProgress) out(`- ${s.title} (${s.path})`);
  }

  // goal in focus — top-weighted goal from TRIAGE.yml (best-effort text scan)
  if (triage) {
    const goal = topGoal(triage);
    if (goal) { out('\n## Goal in focus'); out(`${goal.id} (weight ${goal.weight}) — ${goal.description}`); }
  }

  // ready top — the queue, priority-ranked (fall back to PRIORITIES.md ordering intent)
  const ready = specs.filter(s => s.stage === 'ready')
    .sort((a, b) => priorityRank(a.meta.priority) - priorityRank(b.meta.priority) || a.mtime - b.mtime);
  out('\n## Ready queue (top)');
  if (!ready.length) out('empty — decompose the next slice of an intent.');
  else ready.slice(0, 5).forEach((s, i) =>
    out(`${i + 1}. ${s.title} (${s.path})${s.meta.priority ? ' [' + s.meta.priority + ']' : ''}`));

  // open loops — the decay inbox (surfaced; the agent ranks + caps to 3)
  out('\n## Open loops (decay inbox — rank and cap to 3)');
  const loops = [];
  for (const t of threads) {
    const type = String(t.meta.type || '').toLowerCase();
    const status = String(t.meta.status || '').toLowerCase();
    if ((type === 'question' || type === 'risk') && status === 'open') loops.push(`open ${type}: ${t.title} (${t.path})`);
  }
  for (const s of specs) {
    if (String(s.meta.status || '').toLowerCase() === 'blocked') loops.push(`blocked spec: ${s.title} (${s.path})`);
    if (s.stage === 'done' && !s.feedback) loops.push(`done, no FEEDBACK: ${s.title} (${s.path})`);
    if (s.stage === 'in-review') loops.push(`awaiting review: ${s.title} (${s.path})`);
  }
  const parked = threads.filter(t => String(t.meta.status || '').toLowerCase() === 'parked').length;
  if (parked) loops.push(`${parked} parked thread${parked === 1 ? '' : 's'} (cleanup review)`);
  if (!loops.length) out('none — clean.');
  else loops.forEach(l => out('- ' + l));

  // backlog reference
  out('\n## Backlog · parked (reference)');
  out(`ready: ${counts.ready}  ·  triage: ${counts.triage}  ·  threads: ${threads.length} (${parked} parked)`);

  if (priorities) { out('\n## PRIORITIES.md'); out(priorities.trim()); }

  hr();
  out('The snapshot above is the deterministic read. Now follow the resume SKILL: report Status, Goal in focus, In focus, Open loops (cap 3), Backlog — for workspace "' + ws.name + '".');
}

// Best-effort: pull the highest-weight goal from TRIAGE.yml by scanning the
// goals block. (The CLI stays thin; the agent reads the file properly.)
function topGoal(triage) {
  const lines = triage.split('\n');
  const goals = [];
  let cur = null;
  for (const line of lines) {
    const id = line.match(/^\s*-\s+id:\s*(.+)$/);
    if (id) { cur = { id: parseScalar(id[1]), weight: 0, description: '' }; goals.push(cur); continue; }
    if (!cur) continue;
    const w = line.match(/^\s*weight:\s*([\d.]+)/);
    if (w) cur.weight = Number(w[1]);
    const d = line.match(/^\s*description:\s*(.+)$/);
    if (d) cur.description = parseScalar(d[1]);
  }
  if (!goals.length) return null;
  return goals.sort((a, b) => b.weight - a.weight)[0];
}

// ---------- tl run ----------

function cmdRun(args) {
  const ws = resolveWorkspace(args[0]);
  const named = args[1];
  printSkill('run');

  const specs = readAllSpecs(ws.dir);
  const ready = specs.filter(s => s.stage === 'ready');
  const doneSet = new Set(specs.filter(s => s.stage === 'done').map(s => s.path));

  out('\n===== RUN BRIEF: ' + ws.name + ' =====\n');

  if (!ready.length) {
    out('The ready/ queue is empty — nothing to run. Stop and say so.');
    hr();
    return;
  }

  // If a spec is named, that's the batch (just it).
  let batch, held = [];
  if (named) {
    const hit = ready.find(s => s.path === named || s.path === named + '/' || s.path.replace(/\/$/, '') === named.replace(/^specs\//, 'specs/').replace(/\/$/, '') || s.path.includes(named));
    if (!hit) fail(`Named spec "${named}" not found in ready/. Ready: ${ready.map(s => s.path).join(', ')}`);
    batch = [hit];
    held = ready.filter(s => s !== hit).map(s => ({ ...s, holdReason: 'not the named spec' }));
  } else {
    ({ batch, held } = selectBatch(ready, doneSet));
  }

  out('## Selected batch (' + batch.length + ')');
  for (const s of batch) {
    const ro = isReadOnly(s);
    const files = filesToTouch(s);
    out(`- ${s.title} (${s.path})${s.meta.priority ? ' [' + s.meta.priority + ']' : ''} — ${ro ? 'read-only' : 'files: ' + (files.join(', ') || 'UNDECLARED SCOPE')}`);
  }

  if (held.length) {
    out('\n## Held back for the next run');
    for (const h of held) {
      out(`- ${h.title} (${h.path})${h.holdReason ? ' — ' + h.holdReason : ''}`);
    }
  }

  // The per-spec brief the agent works from.
  out('\n## Per-spec brief');
  for (const s of batch) {
    out('\n### ' + s.title + '  (' + s.path + ')');
    const obj = section(s.body, 'Objective');
    const acc = section(s.body, 'Acceptance criteria');
    const scope = section(s.body, 'Scope');
    if (obj) { out('**Objective**'); out(obj); }
    if (acc) { out('\n**Acceptance criteria**'); out(acc); }
    if (scope) { out('\n**Scope**'); out(scope); }
    if (s.notes) { out('\n**NOTES.md (binding — honor like acceptance criteria)**'); out(s.notes.trim()); }
  }

  hr();
  out('The batch above is conflict-free and claimed-ready. Now follow the run SKILL: claim each spec ready → in-progress, do the work in scope, carry each to in-review (never done). Workspace "' + ws.name + '".');
}

// Largest conflict-free batch: read-only specs never conflict; code specs are
// eligible only if their Files to touch are disjoint from every spec already in
// the batch AND every depends_on is in done/. Prefer higher priority, then
// oldest. Cap at ~4.
function selectBatch(ready, doneSet) {
  const CAP = 4;
  const sorted = ready.slice().sort((a, b) =>
    priorityRank(a.meta.priority) - priorityRank(b.meta.priority) || a.mtime - b.mtime);

  const batch = [];
  const claimed = new Set();   // files claimed by code specs in the batch
  const held = [];

  for (const s of sorted) {
    if (batch.length >= CAP) { held.push({ ...s, holdReason: 'batch capped at ' + CAP }); continue; }

    // dependencies must all be in done/
    const deps = Array.isArray(s.meta.depends_on) ? s.meta.depends_on : (s.meta.depends_on ? [s.meta.depends_on] : []);
    const unmet = deps.filter(d => d && !doneSet.has(d) && !doneSet.has(d.replace(/\/$/, '') + '/'));
    if (unmet.length) { held.push({ ...s, holdReason: 'blocked on ' + unmet.join(', ') }); continue; }

    if (isReadOnly(s)) { batch.push(s); continue; } // read-only never conflicts

    const files = filesToTouch(s);
    if (!files.length) {
      // undeclared scope — can't prove disjoint; conflicts with all code specs
      if (batch.some(b => !isReadOnly(b))) { held.push({ ...s, holdReason: 'undeclared scope — conflicts with code specs' }); continue; }
      batch.push(s); files.forEach(f => claimed.add(f)); continue;
    }
    const collision = files.find(f => claimed.has(f));
    if (collision) { held.push({ ...s, holdReason: 'file conflict on ' + collision }); continue; }
    batch.push(s); files.forEach(f => claimed.add(f));
  }
  return { batch, held };
}

// ---------- tl review ----------

function cmdReview(args) {
  const ws = resolveWorkspace(args[0]);
  printSkill('review');

  const specs = readAllSpecs(ws.dir);
  const inReview = specs.filter(s => s.stage === 'in-review').sort((a, b) => a.mtime - b.mtime);

  out('\n===== REVIEW QUEUE: ' + ws.name + ' =====\n');
  if (!inReview.length) {
    out('in-review/ is empty — nothing to sign off. Stop and say so.');
    hr();
    return;
  }

  out(`## Sign-off queue (${inReview.length}, oldest first)\n`);
  for (const s of inReview) {
    out('### ' + s.title + '  (' + s.path + ')');
    const acc = section(s.body, 'Acceptance criteria');
    out('\n**Acceptance criteria (the contract to check)**');
    out(acc || '(none declared)');
    out('\n**outcome/FEEDBACK.md (the worker\'s claim — verify against the diff)**');
    out(s.feedback ? s.feedback.trim() : '(missing — a spec in review should have FEEDBACK)');
    if (s.notes) { out('\n**NOTES.md**'); out(s.notes.trim()); }
    out('');
  }

  hr();
  out('For each spec: check the diff in its repo against the criteria, then accept (→ done/) or kick back (→ in-progress/ with a thread reason). Workspace "' + ws.name + '".');
}

// ---------- usage ----------

function usage() {
  out('tl — the throughline CLI');
  out('');
  out('Deterministic file work, then prints the matching SKILL as a prompt for the agent.');
  out('');
  out('Usage:');
  out('  tl resume [workspace]           Reconstruct context — stage counts, ready top, open loops');
  out('  tl run    [workspace] [spec]    Work the ready queue — pick the conflict-free batch (or a named spec)');
  out('  tl review [workspace]           Sign off in-review work — criteria + feedback');
  out('');
  out('Workspace: an argument names a workspace under projects/; if exactly one exists it is used;');
  out('otherwise the available workspaces are listed.');
  const all = listWorkspaces();
  out('');
  out('Workspaces: ' + (all.map(w => w.name).join(', ') || '(none under projects/)'));
}

// ---------- dispatch ----------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'resume': return cmdResume(rest);
    case 'run': return cmdRun(rest);
    case 'review': return cmdReview(rest);
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return usage();
    default:
      out('tl: unknown command "' + cmd + '"\n');
      return usage();
  }
}

main();

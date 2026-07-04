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

// Shared logic lives in lib/ so the CLI and ui/server.js can't drift into
// separate copies of the parser, the batch rules, or the path guard.
const { parseFrontmatter, parseYaml } = require('../lib/parse');
const { safeRead, readFirst, isDir, mtime } = require('../lib/workspace');
const { section, filesToTouch, isReadOnly, priorityRank, specSlug, activeConflicts, selectBatch } = require('../lib/batch');
const { runFixtureExperiment } = require('../lib/experiment-fixture');
const { execFileSync } = require('child_process');

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

// Dirty paths in the TL repo itself — the uncommitted edits an agent may be
// mid-flight on that no spec has declared yet. Repo-relative, matching how
// `Files to touch` bullets are written, so they compare directly against a
// ready spec's declared scope. Only consulted when the workspace's repo IS this
// TL repo (the guard is about *this* checkout); returns [] if git is
// unavailable, not a repo, or errors — never throws, never blocks a run.
function dirtyGitPaths() {
  try {
    const raw = execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const paths = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      // porcelain: XY <path> (or `orig -> path` for renames). Take the dest.
      let p = line.slice(3).trim();
      const arrow = p.indexOf(' -> ');
      if (arrow >= 0) p = p.slice(arrow + 4).trim();
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p) paths.push(p);
    }
    return paths;
  } catch { return []; }
}

// Does this workspace's `repo` frontmatter point at the current TL repo? Only
// then do dirty git paths of THIS checkout belong in the conflict set. Best
// effort: tolerate `~`, trailing slashes, and relative forms.
function workspaceIsThisRepo(specs) {
  const repoRef = specs.map(s => s.meta && s.meta.repo).find(Boolean);
  if (!repoRef) return false;
  let r = String(repoRef).trim().replace(/\/+$/, '');
  if (r.startsWith('~')) r = path.join(process.env.HOME || '', r.slice(1));
  try {
    return path.resolve(r) === path.resolve(ROOT) || path.basename(path.resolve(r)) === path.basename(ROOT);
  } catch { return false; }
}

// ---------- continuation dispatches (_dispatch/<slug>.json) ----------

// The continuation half of dispatch (contract in _templates/SCHEMA.md): a
// kickback leaves `_dispatch/<slug>.json` with mode "continuation" and status
// "pending" so the next run resumes the claimed spec before touching the ready
// queue. `live` pairs each pending trigger with its in-progress/tests spec;
// `stale` collects pending triggers whose spec is no longer active (accepted or
// removed meanwhile) — surfaced so they get marked done/failed, never deleted.
function readContinuations(dir, specs) {
  const dDir = path.join(dir, '_dispatch');
  const live = [], stale = [];
  if (!isDir(dDir)) return { live, stale };
  for (const f of fs.readdirSync(dDir).sort()) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    let d = null;
    try { d = JSON.parse(safeRead(path.join(dDir, f)) || ''); } catch {
      // unparseable is a failure to surface, not to swallow — a corrupt trigger
      // would otherwise silently never fire.
      stale.push({ file: '_dispatch/' + f, slug: f.replace(/\.json$/, ''), note: 'unparseable JSON — fix it or mark it failed' });
      continue;
    }
    if (!d || d.mode !== 'continuation' || d.status !== 'pending') continue;
    const slug = specSlug(d.spec || f.replace(/\.json$/, ''));
    const spec = specs.find(s => (s.stage === 'in-progress' || s.stage === 'tests') && specSlug(s.path) === slug);
    if (spec) live.push({ file: '_dispatch/' + f, dispatch: d, spec });
    else stale.push({ file: '_dispatch/' + f, slug, note: 'no matching in-progress/tests spec — mark it done (accepted meanwhile) or failed; do not delete' });
  }
  return { live, stale };
}

// The tail of NOTES.md — the most recent `## …` section (a kickback note is
// appended last), capped so the run banner stays a banner.
function notesExcerpt(notes, maxLines = 8) {
  if (!notes || !notes.trim()) return '(no NOTES.md — resume from SPEC.md and outcome/)';
  const lines = notes.trim().split('\n');
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^##\s/.test(lines[i])) { start = i; break; }
  }
  const excerpt = lines.slice(start, start + maxLines);
  if (start + maxLines < lines.length) excerpt.push('…');
  return excerpt.join('\n');
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

// The highest-weight goal from TRIAGE.yml, read from the parsed structure (the
// shared YAML parser) rather than line-scanning.
function topGoal(triage) {
  let cfg;
  try { cfg = parseYaml(triage); } catch { return null; }
  const goals = (cfg && Array.isArray(cfg.goals)) ? cfg.goals : [];
  if (!goals.length) return null;
  return goals.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))[0];
}

// ---------- tl run ----------

function cmdRun(args) {
  // extract --agent <me> (heterogeneous routing) from the positional args
  let agent = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') agent = String(args[++i] || '').toLowerCase();
    else if (args[i].startsWith('--agent=')) agent = args[i].slice(8).toLowerCase();
    else pos.push(args[i]);
  }
  const ws = resolveWorkspace(pos[0]);
  const named = pos[1];
  printSkill('run');

  const specs = readAllSpecs(ws.dir);
  // dependencies are matched by slug, so a dep `specs/foo/` is satisfied once
  // foo is done (as `done/foo/`) — not by literal path.
  const doneSlugs = new Set(specs.filter(s => s.stage === 'done').map(s => specSlug(s.path)));
  // Active conflict set: files already locked by work underway — specs in
  // in-progress/, tests/, in-review/ (their declared scope) plus the dirty git
  // tree of THIS repo. A ready spec whose scope overlaps this is held back so a
  // fresh run won't collide with an agent already mid-flight. This is a
  // guardrail: it explains the conflict, it does not try to resolve it.
  const activeSpecs = specs.filter(s => ['in-progress', 'tests', 'in-review'].includes(s.stage));
  const dirty = workspaceIsThisRepo(specs) ? dirtyGitPaths() : [];
  const active = activeConflicts(activeSpecs, dirty);
  const allReady = specs.filter(s => s.stage === 'ready');
  // agent routing: a spec's `agent:` (default `any`) must match the running agent's lane.
  const agentOf = s => (s.meta.agent || 'any').toLowerCase();
  const ready = agent ? allReady.filter(s => agentOf(s) === 'any' || agentOf(s) === agent) : allReady;
  const otherLane = agent ? allReady.filter(s => agentOf(s) !== 'any' && agentOf(s) !== agent)
    .map(s => ({ ...s, holdReason: 'assigned to agent "' + agentOf(s) + '"' })) : [];

  out('\n===== RUN BRIEF: ' + ws.name + (agent ? ' (agent lane: ' + agent + ')' : '') + ' =====\n');

  // Continuation dispatches outrank fresh claims: kicked-back / mid-flight work
  // resumes before anything new is started (skills/run step 0). The ready queue
  // waits for the next run; its specs are listed as held, not claimed.
  const conts = readContinuations(ws.dir, specs);
  if (conts.stale.length) {
    out('## Stale continuation dispatches');
    for (const c of conts.stale) {
      out(`- ${c.file} → "${c.slug}" — ${c.note}.`);
    }
    out('');
  }
  if (conts.live.length && named) {
    // a named run is an explicit human choice — surface the pending resume, honor the name.
    out('Note: ' + conts.live.length + ' pending continuation dispatch(es) — kicked-back work is waiting (resume it first unless this named run is intentional).\n');
  }
  if (conts.live.length && !named) {
    out('## Continuation dispatches — resume these before fresh claims (' + conts.live.length + ')');
    for (const c of conts.live) {
      out(`\n### ${c.spec.title}  (${c.spec.path}) [${c.file}]`);
      if (c.dispatch.reason) out('Reason: ' + c.dispatch.reason);
      out('**NOTES.md excerpt (binding — read the full file first)**');
      out(notesExcerpt(c.spec.notes));
    }
    if (ready.length) {
      out('\n## Held back for the next run');
      for (const s of ready) out(`- ${s.title} (${s.path}) — continuation pending, resume in-progress work first`);
    }
    hr();
    out('Follow run SKILL step 0: flip each dispatch to "claimed", read NOTES.md then SPEC.md, and continue the spec from its current folder — never claim fresh ready work while a continuation is pending. Workspace "' + ws.name + '".');
    return;
  }

  if (!ready.length) {
    out(agent
      ? 'No ready specs in the "' + agent + '" lane (agent: ' + agent + ' or any). Nothing to run for this agent.'
      : 'The ready/ queue is empty — nothing to run. Stop and say so.');
    hr();
    return;
  }

  // If a spec is named, that's the batch (just it).
  let batch, held = [];
  if (named) {
    // match by slug exactly — `foo`, `specs/foo`, `specs/foo/` all name the same
    // spec; no substring match (which would let `foo` also hit `foo-bar`).
    const want = specSlug(named);
    const hit = ready.find(s => specSlug(s.path) === want);
    if (!hit) fail(`Named spec "${named}" not found in ready/. Ready: ${ready.map(s => s.path).join(', ')}`);
    // Even a named run refuses a spec whose write scope collides with active
    // work — no override flag exists yet, so a conflict is a hard stop.
    if (!isReadOnly(hit)) {
      const files = filesToTouch(hit);
      if (!files.length && active.codeActive) {
        fail(`Named spec "${named}" has undeclared scope and code work is already active — declare its Files to touch or wait. Refusing to claim.`);
      }
      const clash = files.find(f => active.files.has(f));
      if (clash) fail(`Named spec "${named}" conflicts with ${active.files.get(clash)} on ${clash}. Refusing to claim (no override).`);
    }
    batch = [hit];
    held = ready.filter(s => s !== hit).map(s => ({ ...s, holdReason: 'not the named spec' }));
  } else {
    ({ batch, held } = selectBatch(ready, doneSlugs, { active }));
  }
  held = held.concat(otherLane);  // specs in another agent's lane wait for that agent

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

// ---------- tl recall ----------

// The intents/ corpus — human objectives, searched by recall.
function readIntents(dir) {
  const out = [];
  const intentsDir = path.join(dir, 'intents');
  if (!isDir(intentsDir)) return out;
  for (const f of fs.readdirSync(intentsDir).sort()) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const file = path.join(intentsDir, f);
    const { meta, body } = parseFrontmatter(safeRead(file) || '');
    out.push({ path: 'intents/' + f, title: meta.title || f, meta, body, mtime: mtime(file) });
  }
  return out;
}

// The done/*/outcome/ corpus — FEEDBACK.md + ALIGNMENT.md, where completed work
// recorded what actually happened. One record per outcome file found.
function readOutcomes(dir) {
  const out = [];
  const doneDir = path.join(dir, 'done');
  if (!isDir(doneDir)) return out;
  for (const slug of fs.readdirSync(doneDir).sort()) {
    if (slug.startsWith('.')) continue;
    const outcomeDir = path.join(doneDir, slug, 'outcome');
    if (!isDir(outcomeDir)) continue;
    for (const f of fs.readdirSync(outcomeDir).sort()) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue;
      const file = path.join(outcomeDir, f);
      const { meta, body } = parseFrontmatter(safeRead(file) || '');
      out.push({
        path: 'done/' + slug + '/outcome/' + f,
        title: meta.title || (slug + ' — ' + f.replace(/\.md$/, '')),
        meta, body, mtime: mtime(file),
      });
    }
  }
  return out;
}

// Score a corpus item against the query terms. Title/frontmatter hits weigh more
// than body hits; a query term must appear somewhere or the item is dropped.
// Returns { score, snippet } or null when nothing matches. Transparent and
// case-insensitive — no fuzzy matching, no index.
function scoreMatch(item, terms) {
  const title = String(item.title || '').toLowerCase();
  const front = JSON.stringify(item.meta || {}).toLowerCase();
  const body = String(item.body || '').toLowerCase();
  const head = title + '\n' + front;

  let score = 0;
  for (const t of terms) {
    if (head.includes(t)) score += 3;      // title/frontmatter hit — highest signal
    else if (body.includes(t)) score += 1; // body hit
    else return null;                       // a term with no home anywhere → not a match
  }
  return { score, snippet: firstMatchSnippet(item.body, terms) };
}

// The first body line that contains any query term, trimmed to one line of
// context — enough to answer without re-opening the file.
function firstMatchSnippet(body, terms) {
  for (const raw of String(body).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const low = line.toLowerCase();
    if (terms.some(t => low.includes(t))) {
      return line.length > 160 ? line.slice(0, 157) + '…' : line;
    }
  }
  return '';
}

// The kind bucket a match belongs to — decision / open thread / active spec /
// done outcome / recommendation — best-effort from frontmatter + stage.
function recallKind(item) {
  const type = String(item.meta.type || '').toLowerCase();
  const status = String(item.meta.status || '').toLowerCase();
  if (item.path.startsWith('intents/')) return 'intent';
  if (item.path.startsWith('done/') && item.path.includes('/outcome/')) return 'done outcome';
  if (item.path.startsWith('threads/')) {
    if (type === 'decision') return 'decision';
    if (status === 'open' || status === 'parked' || type === 'question' || type === 'risk') return 'open thread';
    return 'thread';
  }
  // a spec at some stage
  if (item.stage === 'done') return type === 'research' ? 'recommendation' : 'done outcome';
  if (type === 'research') return 'recommendation';
  return 'ready / active spec';
}

function cmdRecall(args) {
  const ws = resolveWorkspace(args[0]);
  const query = args.slice(1).join(' ').trim();
  printSkill('recall');

  if (!query) {
    out('\n===== RECALL: ' + ws.name + ' =====\n');
    out('No query given. Usage: tl recall ' + ws.name + ' <query>');
    hr();
    return;
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  // assemble the full corpus: intents, all spec stages, threads, done outcomes
  const corpus = [];
  for (const s of readAllSpecs(ws.dir)) corpus.push(s);
  for (const t of readThreads(ws.dir)) corpus.push(t);
  for (const i of readIntents(ws.dir)) corpus.push(i);
  for (const o of readOutcomes(ws.dir)) corpus.push(o);

  const hits = [];
  for (const item of corpus) {
    const m = scoreMatch(item, terms);
    if (m) hits.push({ item, score: m.score, snippet: m.snippet, kind: recallKind(item) });
  }
  // rank: score first, then recency (newer wins ties)
  hits.sort((a, b) => b.score - a.score || (b.item.mtime || 0) - (a.item.mtime || 0));

  out('\n===== RECALL: ' + ws.name + ' — "' + query + '" =====\n');
  if (!hits.length) {
    out('No prior discussion found across intents, specs, threads, or done outcomes.');
    hr();
    out('recall found no prior art for "' + query + '" in workspace "' + ws.name + '". Answer: no — proceed, this looks new.');
    return;
  }

  // group by kind, preserving the ranked order within each group
  const order = ['decision', 'recommendation', 'done outcome', 'ready / active spec', 'open thread', 'intent', 'thread'];
  const byKind = {};
  for (const h of hits) (byKind[h.kind] = byKind[h.kind] || []).push(h);
  const kinds = Object.keys(byKind).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  out('## Matches (' + hits.length + ', grouped by kind)');
  for (const kind of kinds) {
    out('\n### ' + kind);
    for (const h of byKind[kind]) {
      out('- ' + h.item.title + ' (' + h.item.path + ') [score ' + h.score + ']');
      if (h.snippet) out('    ↳ ' + h.snippet);
    }
  }

  hr();
  out('The matches above are the deterministic read across the workspace corpus. Now follow the recall SKILL: lead with have-we-discussed-this (yes / partially / no), summarize the prior discussion grouped by kind, and recommend the next action. Workspace "' + ws.name + '".');
}

// ---------- tl sync-rules ----------

// The per-agent instruction files (AGENTS.md, .cursor/rules/tl.mdc, GEMINI.md)
// are GENERATED from the skills' SKILL.md frontmatter plus the core file-model
// rules below. SKILL.md stays the single source of truth for the verbs; this
// command re-derives the rules files in place so they never drift.

// Read every skills/<name>/SKILL.md and pull its name + description from the
// frontmatter. Sorted by name for a stable, diff-friendly output.
function readSkills() {
  if (!isDir(SKILLS)) return [];
  const out = [];
  for (const name of fs.readdirSync(SKILLS).sort()) {
    if (name.startsWith('.')) continue;
    const file = path.join(SKILLS, name, 'SKILL.md');
    const text = safeRead(file);
    if (text === null) continue;
    const { meta } = parseFrontmatter(text);
    const desc = String(meta.description || '').trim();
    out.push({ name: String(meta.name || name).trim(), description: desc });
  }
  return out;
}

// A description's first sentence is the verb's one-liner; the rest is triggering
// guidance meant for skill routing, which the rules files don't need.
function firstSentence(s) {
  const t = String(s).trim();
  const m = t.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : t).trim();
}

// The core file-model rules — the invariants an agent must not get wrong.
// Shared verbatim across all three generated files (each formats them to suit).
const CORE_RULES = [
  ['Status IS the folder', 'A spec\'s lifecycle stage is its directory. To change the stage, move the folder: specs/ (ready) → in-progress/ → tests/ → in-review/ → done/. If a status: field and the folder disagree, the folder wins.'],
  ['Claim by moving', 'To start a spec, move specs/<slug>/ → in-progress/<slug>/ and set status: in-progress. The move is the claim — once it leaves specs/, no other agent can pick it up.'],
  ['Stop at in-review — never done', 'When work is complete and verification is green, write outcome/FEEDBACK.md and move the spec to in-review/ (status: in-review). An agent never signs off its own work; only a human accepts it to done/. This gate is what makes parallel fan-out safe.'],
  ['Honor scope and NOTES', 'Do the work only within the spec\'s Files to touch; treat Do not touch as a hard boundary. If a spec has NOTES.md, it is as binding as the acceptance criteria.'],
  ['Capture threads', 'Anything worth not losing but out of scope — a decision, follow-up, risk, or discovery — becomes a file in threads/ (see the capture verb). An undocumented discovery is a leak; it does not justify widening the current spec.'],
  ['Files only', 'Every change is a markdown/JSONL edit plus a folder move. No hidden state, no separate queue — specs/ is the queue, the folders are the status.'],
];

const GEN_MARKER = '<!-- generated by `tl sync-rules` from skills/*/SKILL.md — do not edit by hand -->';

// Shared prose blocks so all three files tell the same story.
function whatIsTl() {
  return 'Throughline (tl) is markdown-native project management for agent-driven work. Human **intents** (why) decompose into agent-ready **specs** (what to do now); **threads** capture what not to lose. There is no database and no server-of-record: the markdown files are the database, git is the history, and a spec\'s folder is its status.';
}

function layoutBlock() {
  return [
    'The tool lives in this repo. Actual work lives in **workspaces** under `projects/<name>/` (gitignored). One workspace per project:',
    '',
    '```',
    'projects/<name>/',
    '├── TRIAGE.yml       # goals (weighted), allocation targets, priority rules',
    '├── PRIORITIES.md    # generated ranked backlog (by triage)',
    '├── intents/         # human objectives, outcome language',
    '├── specs/           # agent-ready, not started  ← the READY QUEUE',
    '├── in-progress/     # being worked',
    '├── tests/           # code complete, at the test/verification gate',
    '├── in-review/       # tests green, awaiting human sign-off (has outcome/FEEDBACK.md)',
    '├── done/            # reviewed and accepted (human only)',
    '└── threads/         # parked ideas, decisions, open questions, risks',
    '```',
    '',
    'Each spec is a self-contained folder: `SPEC.md` (Objective, Acceptance criteria, Scope), optional `context/`, `outcome/FEEDBACK.md` (written when work completes), and optional `NOTES.md` (human mid-flight feedback — binding). The frontmatter contract lives in `_templates/SCHEMA.md`; enums are lowercase, dates are ISO.',
  ].join('\n');
}

function quickstartSteps() {
  return [
    '1. **Pick the workspace.** If `projects/` holds exactly one workspace, use it; otherwise the human names it.',
    '2. **Pick a spec.** Look in `projects/<name>/specs/` (the ready queue). Prefer the highest priority per `PRIORITIES.md`; ties broken by oldest. Pick one whose `depends_on` are all in `done/`.',
    '3. **Claim it.** `git mv projects/<name>/specs/<slug> projects/<name>/in-progress/<slug>` and set `status: in-progress`.',
    '4. **Assemble the brief.** Read the spec\'s Objective, Acceptance criteria, Scope, any `NOTES.md`, its `context/`, the parent intent\'s Outcome, and the goal it ladders to (`TRIAGE.yml`).',
    '5. **Do the work** in the spec\'s repo, strictly within `Files to touch`. Out-of-scope find → write a `threads/` file, keep going.',
    '6. **Test gate.** Move to `tests/` (`status: tests`) and run the acceptance checks. If red, leave it in `tests/` as `status: blocked` with what broke, and stop.',
    '7. **Hand to review.** On green, write `outcome/FEEDBACK.md`, move `tests/<slug> → in-review/<slug>`, set `status: in-review`. **Stop here — do not move it to `done/`.**',
    '8. **Report** the final state, any threads captured, and that it now waits in `in-review/` for a human to accept.',
  ].join('\n');
}

// The verb list, rendered as markdown bullets: `verb` — one-liner.
function verbsBlock(skills) {
  return skills.map(s => `- \`tl ${s.name}\` — ${firstSentence(s.description)}`).join('\n');
}

// ----- AGENTS.md (repo root; Codex/Claude and the generic default) -----
function genAgents(skills) {
  const rules = CORE_RULES.map((r, i) => `${i + 1}. **${r[0]}.** ${r[1]}`).join('\n');
  return [
    '# AGENTS.md',
    '',
    GEN_MARKER,
    '',
    'Standing instructions for **any** coding agent (Codex, Cursor, Gemini, Claude, …) working in this repo. This file plus the skills it points to are enough to drive a spec correctly with zero new tooling.',
    '',
    '> **Cross-agent PoC.** A non-Claude agent, given only this AGENTS.md, can pick up one ready spec and carry it to `in-review/` — no `tl`-specific tools, just files and git. If you are that agent: follow the quickstart below.',
    '',
    '## What tl is',
    '',
    whatIsTl(),
    '',
    '## Workspace layout',
    '',
    layoutBlock(),
    '',
    '## The verbs — source of truth is the skills',
    '',
    'Each verb is one `skills/<name>/SKILL.md` — the algorithm. Don\'t re-derive the procedures; read and follow them. Start with **`skills/run/SKILL.md`** (work the queue), **`skills/resume/SKILL.md`** (orient), and **`skills/review/SKILL.md`** (human sign-off).',
    '',
    verbsBlock(skills),
    '',
    '## Critical rules — do not get these wrong',
    '',
    rules,
    '',
    '## Quickstart: work one spec',
    '',
    'You can follow this literally. (`skills/run/SKILL.md` is the full version — read it too.)',
    '',
    quickstartSteps(),
    '',
  ].join('\n');
}

// ----- .cursor/rules/tl.mdc (Cursor project rules; MDC frontmatter) -----
function genCursor(skills) {
  const rules = CORE_RULES.map(r => `- **${r[0]}.** ${r[1]}`).join('\n');
  return [
    '---',
    'description: Throughline (tl) — markdown-native project management. How to work a spec.',
    'alwaysApply: true',
    '---',
    '',
    GEN_MARKER,
    '',
    '# Working in a Throughline (tl) repo',
    '',
    whatIsTl(),
    '',
    '## Layout',
    '',
    layoutBlock(),
    '',
    '## Verbs (each is `skills/<name>/SKILL.md` — read the skill, follow it)',
    '',
    verbsBlock(skills),
    '',
    '## Rules — do not get these wrong',
    '',
    rules,
    '',
    '## Work one spec',
    '',
    quickstartSteps(),
    '',
  ].join('\n');
}

// ----- GEMINI.md (Gemini context file) -----
function genGemini(skills) {
  const rules = CORE_RULES.map((r, i) => `${i + 1}. **${r[0]}.** ${r[1]}`).join('\n');
  return [
    '# GEMINI.md',
    '',
    GEN_MARKER,
    '',
    'Context for Gemini working in this Throughline (tl) repo. This file plus the `skills/*/SKILL.md` it names are enough to drive a spec with zero new tooling.',
    '',
    '## What tl is',
    '',
    whatIsTl(),
    '',
    '## Workspace layout',
    '',
    layoutBlock(),
    '',
    '## The verbs',
    '',
    'Each verb is one `skills/<name>/SKILL.md` — read the skill and follow its steps rather than re-deriving. Core loop: `run` (work the queue), `resume` (orient), `review` (human sign-off).',
    '',
    verbsBlock(skills),
    '',
    '## Critical rules',
    '',
    rules,
    '',
    '## Quickstart: work one spec',
    '',
    quickstartSteps(),
    '',
  ].join('\n');
}

function cmdSyncRules() {
  const skills = readSkills();
  if (!skills.length) fail('No skills found under skills/*/SKILL.md — nothing to generate from.');

  const targets = [
    { path: path.join(ROOT, 'AGENTS.md'), content: genAgents(skills) },
    { path: path.join(ROOT, '.cursor', 'rules', 'tl.mdc'), content: genCursor(skills) },
    { path: path.join(ROOT, 'GEMINI.md'), content: genGemini(skills) },
  ];

  out('===== tl sync-rules =====');
  out(`Source: ${skills.length} skill${skills.length === 1 ? '' : 's'} under skills/*/SKILL.md`);
  out('');
  for (const t of targets) {
    const rel = path.relative(ROOT, t.path);
    const before = safeRead(t.path);
    const status = before === null ? 'created' : (before === t.content ? 'unchanged' : 'updated');
    if (status !== 'unchanged') {
      fs.mkdirSync(path.dirname(t.path), { recursive: true });
      fs.writeFileSync(t.path, t.content);
    }
    out(`  ${status.padEnd(9)} ${rel}`);
  }
  out('');
  out('SKILL.md frontmatter is the single source of truth — re-run `tl sync-rules` after editing skills to refresh these.');
}

// ---------- tl experiment ----------

function cmdExperiment(args) {
  const [subcmd, ...rest] = args;
  if (subcmd !== 'fixture') {
    fail('Usage: tl experiment fixture [workspace]');
  }
  const ws = resolveWorkspace(rest[0]);
  const result = runFixtureExperiment(ws.dir);
  out('===== tl experiment fixture =====');
  out(`workspace: ${ws.name}`);
  out(`experiment: _experiments/${result.experimentId}/`);
  out(`winner: ${result.winner}`);
}

// ---------- usage ----------

function usage(stream) {
  const w = s => (stream || process.stdout).write(s + '\n');
  w('tl — the throughline CLI');
  w('');
  w('Deterministic file work, then prints the matching SKILL as a prompt for the agent.');
  w('');
  w('Usage:');
  w('  tl resume [workspace]           Reconstruct context — stage counts, ready top, open loops');
  w('  tl run    [workspace] [spec]    Work the ready queue — pick the conflict-free batch (or a named spec)');
  w('              [--agent <name>]    Only claim specs in this agent\'s lane (agent: <name> or any) — heterogeneous fan-out');
  w('  tl review [workspace]           Sign off in-review work — criteria + feedback');
  w('  tl recall [workspace] <query>   Search intents/specs/threads/outcomes — "did we discuss this?"');
  w('  tl experiment fixture [workspace]');
  w('                                  Create a deterministic fixture experiment proof');
  w('  tl sync-rules                   Regenerate the per-agent rules files from skills/*/SKILL.md');
  w('');
  w('Workspace: an argument names a workspace under projects/; if exactly one exists it is used;');
  w('otherwise the available workspaces are listed.');
  const all = listWorkspaces();
  w('');
  w('Workspaces: ' + (all.map(w2 => w2.name).join(', ') || '(none under projects/)'));
}

// ---------- dispatch ----------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'resume': return cmdResume(rest);
    case 'run': return cmdRun(rest);
    case 'review': return cmdReview(rest);
    case 'recall': return cmdRecall(rest);
    case 'experiment': return cmdExperiment(rest);
    case 'sync-rules': return cmdSyncRules();
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return usage();
    default:
      // an unknown command is an error — exit non-zero so automation and shell
      // pipelines don't read a typo as success. Usage goes to stderr here.
      process.stderr.write('tl: unknown command "' + cmd + '"\n\n');
      usage(process.stderr);
      process.exit(2);
  }
}

main();

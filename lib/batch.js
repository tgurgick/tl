// lib/batch.js — spec-body reading + the conflict-free batch selection.
//
// The rules that decide what `/tl run` can work together: which specs are
// read-only (never conflict), what each code spec's declared file scope is, how
// dependencies are matched by slug, and how the largest non-colliding batch is
// picked. Pure functions over already-parsed spec objects — no fs, no http (the
// repo-preflight existence check is injected, never performed here) — so
// they're unit-testable and shared by the CLI. Zero dependencies.

'use strict';

const path = require('path');
const os = require('os');

// Pull one markdown section by heading (## Foo … up to the next same-or-higher
// heading). Empty string if the heading is absent OR present-but-empty.
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

// Does the body contain this heading at all? Distinct from section() returning
// content — a heading with no bullets under it still means the author declared
// the section (so an empty "Files to touch" marks a *code* spec, not read-only).
function hasSection(body, heading) {
  const norm = heading.toLowerCase();
  for (const line of String(body).split('\n')) {
    const m = line.match(/^(#{2,6})\s+(.*)$/);
    if (m && m[2].trim().toLowerCase().replace(/[:]+$/, '') === norm) return true;
  }
  return false;
}

// The declared write scope of a code spec — the `- \`path\`` bullets under
// "### Files to touch". A bullet may list several comma-separated paths.
function filesToTouch(spec) {
  const scope = section(spec.body, 'Files to touch');
  const files = [];
  for (const line of scope.split('\n')) {
    const m = line.match(/^\s*[-*]\s+`([^`]+)`/);
    if (!m) continue;
    for (const part of m[1].split(',')) {
      const f = part.trim();
      if (f) files.push(f);
    }
  }
  return files;
}

// A spec is read-only (never conflicts) only if it's research OR declares no
// write scope at all. A spec that *has* a "Files to touch" section is a code
// spec even when its bullets don't parse into backtick paths — otherwise a
// malformed scope silently gets treated as safe-to-parallelize.
function isReadOnly(spec) {
  const type = String(spec.meta.type || '').toLowerCase();
  if (type === 'research') return true;
  if (hasSection(spec.body, 'Files to touch')) return false;
  return filesToTouch(spec).length === 0;
}

function priorityRank(p) {
  const m = String(p || '').toLowerCase().match(/^p([0-3])$/);
  return m ? Number(m[1]) : 9; // no priority sorts last
}

// Reduce a spec path/dependency to its identity slug, independent of stage:
// `specs/foo/`, `done/foo/`, `in-progress/foo/SPEC.md`, and `foo` all → `foo`.
// This is what lets a dependency written as `specs/foo/` be satisfied once foo
// has moved to `done/foo/`.
function specSlug(p) {
  let s = String(p || '').trim().replace(/\/+$/, '');
  s = s.replace(/\/SPEC\.md$/i, '');
  const parts = s.split('/').filter(Boolean);
  s = parts[parts.length - 1] || '';
  return s.replace(/\.md$/i, '');
}

// A dependency is satisfied when a spec with the same slug is done — matched by
// slug, not literal path, so the stage folder doesn't matter.
function dependencySatisfied(dep, doneSlugs) {
  return doneSlugs.has(specSlug(dep));
}

function depsOf(spec) {
  const d = spec.meta.depends_on;
  return Array.isArray(d) ? d : (d ? [d] : []);
}

// The set of files already locked by work that is active but not yet accepted:
// specs in in-progress/, tests/, and in-review/ (their Files to touch), plus any
// dirty git paths passed in. Returns a Map file -> source label (e.g.
// `in-progress/foo` or `dirty git`) so a held-back ready spec can name exactly
// what it collides with. Also reports whether any *code* work is active at all —
// used to keep undeclared-scope ready specs conservative even when no specific
// file collides. Pure over already-parsed spec objects; `dirtyPaths` is an
// array of repo-relative paths (empty when git status is unavailable).
function activeConflicts(activeSpecs, dirtyPaths = []) {
  const files = new Map();      // file -> source label (first writer wins the label)
  let codeActive = false;
  for (const s of activeSpecs || []) {
    if (isReadOnly(s)) continue;   // read-only active work locks nothing
    codeActive = true;
    const label = specSlug(s.path) ? (String(s.stage || '') + '/' + specSlug(s.path)).replace(/^\//, '') : String(s.path);
    for (const f of filesToTouch(s)) {
      if (!files.has(f)) files.set(f, label);
    }
  }
  for (const p of dirtyPaths || []) {
    const f = String(p).trim();
    if (!f) continue;
    codeActive = true;
    if (!files.has(f)) files.set(f, 'dirty git');
  }
  return { files, codeActive };
}

// ---------- claim-time asset preflight (repo readiness) ----------
//
// The bench-incident guard: a spec whose `repo:` doesn't resolve to a usable
// checkout is HELD in specs/ with a concrete reason, never claimed — and a
// code spec with no project repo at all never defaults into the tl checkout
// (the cwd fallback is how project code ends up committed to the public tl
// repo). Pure: the existence check is injected (`preflight.isRepo`), never a
// shell-out or an fs call from here.

// A `repo:` that names a URL (https://…, git@host:…) has no local path to
// check — the resolve check treats it as unset.
function isRepoUrl(ref) {
  const r = String(ref || '').trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(r) || /^[^/\s]+@[^\s]+:/.test(r);
}

// Expand `~` / `~/…` with the (injectable) homedir and resolve to an absolute
// path. null when the ref is unset or a URL — nothing local to check.
function localRepoPath(ref, homedir) {
  let r = String(ref || '').trim();
  if (!r || isRepoUrl(r)) return null;
  const home = homedir || os.homedir();
  if (r === '~') r = home;
  else if (r.startsWith('~/')) r = path.join(home, r.slice(2));
  return path.resolve(r);
}

// Is `child` the same directory as `parent`, or nested anywhere inside it?
function insideOrEqual(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

// Exact path identity for repo-matching (dirty-git guard + containment
// exemption). NEVER basename: a sibling checkout named `throughline` must not
// match this checkout. `opts.resolvePath` defaults to `path.resolve`; inject
// `fs.realpathSync` (or a test double) when symlink-canonical identity matters.
function sameResolvedPath(a, b, opts = {}) {
  if (a == null || b == null || a === '' || b === '') return false;
  const resolve = typeof opts.resolvePath === 'function' ? opts.resolvePath : (p) => path.resolve(String(p));
  try {
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
}

// Does `repoRef` (~-expanded via localRepoPath) name the same directory as
// `rootAbs`? Shared by dirty-git "is this checkout?" and the tl-workspace
// containment exemption — one rule, no basename fallback.
function sameLocalRepo(repoRef, rootAbs, homedir, opts = {}) {
  const resolved = localRepoPath(repoRef, homedir);
  if (!resolved || !rootAbs) return false;
  return sameResolvedPath(resolved, rootAbs, opts);
}

// The preflight verdict for one spec. `preflight` (all injectable):
//   isRepo(absPath)  -> bool — the path is an existing directory containing
//                       `.git`. Required; without it the preflight is off
//                       (back-compat for callers that don't wire it).
//   tlRoot           -> absolute path of the tl checkout (containment guard).
//   workspaceRepo    -> the workspace's own PROJECT.md `repo:` — when it
//                       points at the tl root, this is the tl-developing-tl
//                       workspace, the one legitimate tl-checkout target.
//   homedir          -> `~` expansion base (defaults to os.homedir()).
// Returns a short literal hold reason, or null when the spec may be claimed.
function repoHoldReason(spec, preflight) {
  if (!preflight || typeof preflight.isRepo !== 'function') return null;
  const home = preflight.homedir;
  const ref = spec.meta && spec.meta.repo;
  const repoPath = localRepoPath(ref, home);
  // 1. A declared local repo must exist and be a checkout (dir containing .git).
  if (repoPath && !preflight.isRepo(repoPath)) return 'repo not found: ' + String(ref).trim();
  // 2. Containment: a code spec with no usable project repo — unset (or URL-only),
  // or pointing at/inside the tl checkout — must never default into cwd.
  if (isReadOnly(spec)) return null;   // read-only work lands no code anywhere
  const tlRoot = preflight.tlRoot ? path.resolve(String(preflight.tlRoot)) : null;
  if (!tlRoot) return null;
  // Exact resolved path only (`sameLocalRepo`) — never basename. A
  // workspace whose PROJECT.md `repo:` shares only the leaf name with the
  // tl checkout is NOT the tl-developing-tl exemption.
  if (sameLocalRepo(preflight.workspaceRepo, tlRoot, home, preflight)) return null;
  if (!repoPath || insideOrEqual(repoPath, tlRoot)) {
    return 'no project repo — refusing to work in the tl checkout';
  }
  return null;
}

// The configured calm cap for a run batch — how wide a single `/tl run` may
// fan out. Read from the workspace's parsed TRIAGE.yml (`run: { cap: N }`) so
// the width is a per-workspace dial, not a magic number; anything missing or
// non-sensical (zero, negative, non-numeric) falls back to the default 4.
// Calm over swarm: the cap exists to bound parallelism, so it is never 0.
function calmCap(triageConfig, fallback = 4) {
  const r = (triageConfig && triageConfig.run) || null;
  const n = r ? Number(r.cap) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Largest conflict-free batch: read-only specs never conflict; a code spec is
// eligible only if its Files to touch are disjoint from every spec already in
// the batch AND every depends_on is done (by slug). Prefer higher priority,
// then oldest. Cap at ~4 — calm over swarm. `doneSlugs` is a Set of done slugs.
//
// `opts.active` (from activeConflicts) additionally holds ready specs back when
// their write scope overlaps work already underway in in-progress/tests/in-review
// or the dirty git tree — so a fresh run won't claim a spec that collides with
// what another agent is mid-flight on. Read-only ready specs still never conflict;
// undeclared-scope code specs stay conservative if any code work is active.
//
// `opts.preflight` (see repoHoldReason) additionally holds any spec whose
// `repo:` is a void — checked here, before the claim, not after.
function selectBatch(ready, doneSlugs, opts = {}) {
  const cap = opts.cap || 4;
  const active = opts.active || { files: new Map(), codeActive: false };
  const activeFiles = active.files || new Map();

  const sorted = ready.slice().sort((a, b) =>
    priorityRank(a.meta.priority) - priorityRank(b.meta.priority) || a.mtime - b.mtime);

  const batch = [];
  const claimed = new Map();   // file -> slug of the batch spec that claimed it
  const held = [];

  for (const s of sorted) {
    if (batch.length >= cap) { held.push({ ...s, holdReason: 'batch capped at ' + cap }); continue; }

    const unmet = depsOf(s).filter(d => d && !dependencySatisfied(d, doneSlugs));
    if (unmet.length) { held.push({ ...s, holdReason: 'blocked on ' + unmet.join(', ') }); continue; }

    const repoHold = repoHoldReason(s, opts.preflight);
    if (repoHold) { held.push({ ...s, holdReason: repoHold }); continue; }

    if (isReadOnly(s)) { batch.push(s); continue; }

    const files = filesToTouch(s);
    if (!files.length) {
      // undeclared scope — can't prove disjoint; conflicts with all code specs,
      // including active code work already underway elsewhere.
      if (active.codeActive) { held.push({ ...s, holdReason: 'undeclared scope — conflicts with active code work' }); continue; }
      if (batch.some(b => !isReadOnly(b))) { held.push({ ...s, holdReason: 'undeclared scope — conflicts with code specs' }); continue; }
      batch.push(s); continue;
    }
    // active-work conflict: a file locked by in-progress/tests/in-review or dirty git.
    const activeHit = files.find(f => activeFiles.has(f));
    if (activeHit) { held.push({ ...s, holdReason: 'conflicts with ' + activeFiles.get(activeHit) + ' on ' + activeHit }); continue; }
    // within-batch conflict: a file another selected code spec already claimed.
    // The reason names the winner, not just the file — a held spec should read
    // as "wait for X", not send the human diffing scopes by hand.
    const collision = files.find(f => claimed.has(f));
    if (collision) { held.push({ ...s, holdReason: 'file conflict on ' + collision + ' with ' + claimed.get(collision) }); continue; }
    batch.push(s); files.forEach(f => { if (!claimed.has(f)) claimed.set(f, specSlug(s.path)); });
  }
  return { batch, held };
}

// The resume half of fan-out: which pending continuation dispatches can be
// worked *together* this run. Same shape of decision as selectBatch, but over
// `{ file, dispatch, spec }` entries (readContinuations' live list) and only
// against each other — the continuation specs ARE the active work, so the
// active-conflict guard doesn't apply, and dependencies were settled when the
// spec was first claimed. Order is the dispatch ordering contract: spec
// priority first, then the dispatch's `created` date (oldest kickback resumes
// first), then filename for determinism. Overflow past the calm cap and
// overlapping declared scopes are held with a concrete reason — two resumed
// specs must never touch the same file any more than two fresh claims may.
function selectContinuations(live, opts = {}) {
  const cap = opts.cap || 4;
  const sorted = (live || []).slice().sort((a, b) =>
    priorityRank(a.spec.meta.priority) - priorityRank(b.spec.meta.priority) ||
    String(a.dispatch.created || '9999').localeCompare(String(b.dispatch.created || '9999')) ||
    String(a.file).localeCompare(String(b.file)));

  const batch = [];
  const claimed = new Map();   // file -> slug of the continuation that claimed it
  const held = [];

  for (const c of sorted) {
    if (batch.length >= cap) { held.push({ ...c, holdReason: 'batch capped at ' + cap }); continue; }

    // A continuation resumes into the same repo the spec was claimed against —
    // if that repo has since become a void, the resume is held too, with the
    // same concrete reason as a fresh claim. The dispatch stays pending.
    const repoHold = repoHoldReason(c.spec, opts.preflight);
    if (repoHold) { held.push({ ...c, holdReason: repoHold }); continue; }

    if (isReadOnly(c.spec)) { batch.push(c); continue; }

    const files = filesToTouch(c.spec);
    if (!files.length) {
      // undeclared scope — can't prove disjoint from the other resumed code work.
      if (batch.some(b => !isReadOnly(b.spec))) { held.push({ ...c, holdReason: 'undeclared scope — conflicts with other resumed code work' }); continue; }
      batch.push(c); continue;
    }
    const collision = files.find(f => claimed.has(f));
    if (collision) { held.push({ ...c, holdReason: 'file conflict on ' + collision + ' with ' + claimed.get(collision) }); continue; }
    batch.push(c); files.forEach(f => { if (!claimed.has(f)) claimed.set(f, specSlug(c.spec.path)); });
  }
  return { batch, held };
}

module.exports = {
  section, hasSection, filesToTouch, isReadOnly,
  priorityRank, specSlug, dependencySatisfied, depsOf, activeConflicts, selectBatch,
  calmCap, selectContinuations,
  isRepoUrl, localRepoPath, repoHoldReason,
  sameResolvedPath, sameLocalRepo,
};

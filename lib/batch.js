// lib/batch.js — spec-body reading + the conflict-free batch selection.
//
// The rules that decide what `/tl run` can work together: which specs are
// read-only (never conflict), what each code spec's declared file scope is, how
// dependencies are matched by slug, and how the largest non-colliding batch is
// picked. Pure functions over already-parsed spec objects — no fs, no http — so
// they're unit-testable and shared by the CLI. Zero dependencies.

'use strict';

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
function selectBatch(ready, doneSlugs, opts = {}) {
  const cap = opts.cap || 4;
  const active = opts.active || { files: new Map(), codeActive: false };
  const activeFiles = active.files || new Map();

  const sorted = ready.slice().sort((a, b) =>
    priorityRank(a.meta.priority) - priorityRank(b.meta.priority) || a.mtime - b.mtime);

  const batch = [];
  const claimed = new Set();   // files claimed by code specs in the batch
  const held = [];

  for (const s of sorted) {
    if (batch.length >= cap) { held.push({ ...s, holdReason: 'batch capped at ' + cap }); continue; }

    const unmet = depsOf(s).filter(d => d && !dependencySatisfied(d, doneSlugs));
    if (unmet.length) { held.push({ ...s, holdReason: 'blocked on ' + unmet.join(', ') }); continue; }

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
    const collision = files.find(f => claimed.has(f));
    if (collision) { held.push({ ...s, holdReason: 'file conflict on ' + collision }); continue; }
    batch.push(s); files.forEach(f => claimed.add(f));
  }
  return { batch, held };
}

module.exports = {
  section, hasSection, filesToTouch, isReadOnly,
  priorityRank, specSlug, dependencySatisfied, depsOf, activeConflicts, selectBatch,
};

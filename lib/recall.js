// lib/recall.js — shared /tl recall corpus, scoring, and grouping.
//
// One implementation for both surfaces: `tl recall` (bin/tl.js) and the
// cockpit's read-only GET /api/recall (ui/server.js) both call recallSearch(),
// so corpus assembly, the scorer, and the kind buckets cannot drift — the
// parity the tl-recall-skill outcome asked for. Plain, transparent text search
// over the workspace markdown: no index, no embeddings, no network, and this
// module never writes a file.

'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./parse');
const { safeRead, isDir, mtime } = require('./workspace');

// stage -> folder ladder (mirrors bin/tl.js STAGES / _templates/SCHEMA.md)
const STAGES = [
  ['triage', 'triage'],
  ['ready', 'specs'],
  ['in-progress', 'in-progress'],
  ['tests', 'tests'],
  ['in-review', 'in-review'],
  ['done', 'done'],
];

// Stable display order for the kind groups — the same buckets the recall
// SKILL names: decision first ("already decided"), fallback stage buckets last.
const KIND_ORDER = [
  'decision', 'recommendation', 'done outcome',
  'ready / active spec', 'open thread', 'intent', 'thread',
];

// ---------- corpus readers (minimal shape: stage?, path, title, meta, body, mtime) ----------

// Every spec at every stage — SPEC.md is the record searched.
function readSpecs(wsDir) {
  const out = [];
  for (const [stage, folder] of STAGES) {
    const stageDir = path.join(wsDir, folder);
    if (!isDir(stageDir)) continue;
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
      out.push({
        stage, path: folder + '/' + entry + (isFolder ? '/' : ''),
        title: meta.title || entry.replace(/\.md$/, ''),
        meta, body, mtime: mtime(file),
      });
    }
  }
  return out;
}

// threads/ — parked ideas, decisions, open questions, risks, follow-ups.
function readThreads(wsDir) {
  const out = [];
  const threadsDir = path.join(wsDir, 'threads');
  if (!isDir(threadsDir)) return out;
  for (const f of fs.readdirSync(threadsDir).sort()) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const file = path.join(threadsDir, f);
    const { meta, body } = parseFrontmatter(safeRead(file) || '');
    out.push({ path: 'threads/' + f, title: meta.title || f, meta, body, mtime: mtime(file) });
  }
  return out;
}

// intents/ — the human objectives.
function readIntents(wsDir) {
  const out = [];
  const intentsDir = path.join(wsDir, 'intents');
  if (!isDir(intentsDir)) return out;
  for (const f of fs.readdirSync(intentsDir).sort()) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const file = path.join(intentsDir, f);
    const { meta, body } = parseFrontmatter(safeRead(file) || '');
    out.push({ path: 'intents/' + f, title: meta.title || f, meta, body, mtime: mtime(file) });
  }
  return out;
}

// done/*/outcome/ — FEEDBACK.md + ALIGNMENT.md, where completed work recorded
// what actually happened. One record per outcome file found.
function readOutcomes(wsDir) {
  const out = [];
  const doneDir = path.join(wsDir, 'done');
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

// The full corpus: intents, all spec stages, threads, done outcomes.
function buildCorpus(wsDir) {
  return [...readSpecs(wsDir), ...readThreads(wsDir), ...readIntents(wsDir), ...readOutcomes(wsDir)];
}

// ---------- scoring ----------

// Split a query into lowercase terms — the unit the scorer works in.
function recallTerms(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// Score a corpus item against the query terms. Title/frontmatter hits weigh
// more than body hits; a query term must appear somewhere or the item is
// dropped. Returns { score, snippet } or null when nothing matches.
// Transparent and case-insensitive — no fuzzy matching, no index.
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

// ---------- grouping ----------

// The kind bucket a match belongs to — decision / open thread / active spec /
// done outcome / recommendation — best-effort from frontmatter + stage.
function recallKind(item) {
  const type = String((item.meta || {}).type || '').toLowerCase();
  const status = String((item.meta || {}).status || '').toLowerCase();
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

// Group ranked hits by kind, preserving the ranked order within each group and
// presenting the groups in KIND_ORDER (unknown kinds trail in first-hit order).
function groupHits(hits) {
  const byKind = new Map();
  for (const h of hits) {
    if (!byKind.has(h.kind)) byKind.set(h.kind, []);
    byKind.get(h.kind).push(h);
  }
  return [...byKind.entries()]
    .sort((a, b) => {
      const ia = KIND_ORDER.indexOf(a[0]), ib = KIND_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(([kind, group]) => ({ kind, hits: group }));
}

// ---------- the one entry point both surfaces call ----------

// Search a workspace's whole memory for prior discussion of `query`.
// Rank: score first, then recency (newer wins ties). `cap` (0 = uncapped)
// truncates the ranked list before grouping — the UI keeps results capped;
// the CLI prints everything. Hits are plain serializable records (no meta/body)
// so the result can go straight over the wire.
function recallSearch(wsDir, query, { cap = 0 } = {}) {
  const terms = recallTerms(query);
  const result = { query: String(query || '').trim(), terms, total: 0, capped: false, hits: [], groups: [] };
  if (!terms.length) return result;

  const hits = [];
  for (const item of buildCorpus(wsDir)) {
    const m = scoreMatch(item, terms);
    if (m) {
      hits.push({
        title: item.title, path: item.path, stage: item.stage || null,
        kind: recallKind(item), score: m.score, snippet: m.snippet, mtime: item.mtime || 0,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || (b.mtime || 0) - (a.mtime || 0));

  result.total = hits.length;
  const kept = cap > 0 && hits.length > cap ? hits.slice(0, cap) : hits;
  result.capped = kept.length < hits.length;
  result.hits = kept;
  result.groups = groupHits(kept);
  return result;
}

module.exports = {
  KIND_ORDER,
  readSpecs, readThreads, readIntents, readOutcomes, buildCorpus,
  recallTerms, scoreMatch, firstMatchSnippet, recallKind, groupHits,
  recallSearch,
};

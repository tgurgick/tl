// lib/sync-map.js — the /tl sync issue-type classification contract.
//
// JIRA Cloud sites carry site-specific issue types (Spike, Sub-task, Incident,
// Improvement, …) beyond the four the original sync spec fixed. This module is
// the one place that turns a JIRA issue-type name plus the workspace's
// `sync.jira.map` into a routing decision: create an intent, create a spec
// (with an optional TL `type`/`tags` hint), explicitly ignore, or hold as
// unmapped with a concrete configuration hint. Unmapped is a first-class
// visible outcome — never a silent drop, never a misfile into a default bucket.
// Prose contract: skills/sync/SKILL.md; config schema: _templates/SCHEMA.md.
// Node stdlib only; zero dependencies.

'use strict';

// Valid TL spec `type` values (SCHEMA.md spec frontmatter). A map entry may
// hint one of these for `to: spec` — nothing else. Lifecycle words (`done`,
// `triage`, stage names) are not types and are rejected loudly.
const SPEC_TYPES = ['feature', 'bug', 'tech_debt', 'research'];

// The routing targets a map value may name.
const MAP_TARGETS = ['intent', 'spec', 'ignore'];

// The shipped defaults — present whether or not the workspace lists them.
// A workspace `map` entry with the same key overrides the default; every
// other key extends it. Absent/empty map = exactly this behavior (backward
// compatible with the original fixed four-type contract).
const DEFAULT_TYPE_MAP = Object.freeze({
  epic: Object.freeze({ to: 'intent' }),
  story: Object.freeze({ to: 'spec', type: 'feature' }),
  task: Object.freeze({ to: 'spec', type: 'feature' }),
  bug: Object.freeze({ to: 'spec', type: 'bug' }),
});

// Canonical key for a JIRA issue-type name: lowercase, trimmed, internal
// whitespace collapsed to a single `-`. This is how "Sub-task", "sub task",
// and `sub-task:` in TRIAGE.yml all meet: the tl YAML parser's keys cannot
// contain spaces, so multi-word JIRA names are written hyphenated.
function normalizeTypeKey(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, '-');
}

// Normalize one raw map value (scalar or block map) for `key`.
// Returns { entry } or { error }. Scalar `spec` inherits the default TL type
// for that key when one exists (so `bug: spec` stays `type: bug`), else
// `feature`.
function normalizeEntry(key, raw) {
  const fallbackType = (DEFAULT_TYPE_MAP[key] && DEFAULT_TYPE_MAP[key].type) || 'feature';
  if (typeof raw === 'string') {
    const to = raw.trim().toLowerCase();
    if (!MAP_TARGETS.includes(to)) {
      return { error: `sync.jira.map.${key}: "${raw}" is not a valid target — use one of: ${MAP_TARGETS.join(', ')}` };
    }
    if (to === 'spec') return { entry: { to: 'spec', type: fallbackType, tags: [] } };
    return { entry: { to } };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const to = typeof raw.to === 'string' ? raw.to.trim().toLowerCase() : '';
    if (!MAP_TARGETS.includes(to)) {
      return { error: `sync.jira.map.${key}: block form needs "to" set to one of: ${MAP_TARGETS.join(', ')}` };
    }
    const hasType = raw.type !== undefined && raw.type !== null;
    const hasTags = raw.tags !== undefined && raw.tags !== null;
    if (to !== 'spec' && (hasType || hasTags)) {
      return { error: `sync.jira.map.${key}: "type"/"tags" hints only apply to "to: spec" (got "to: ${to}")` };
    }
    if (to !== 'spec') return { entry: { to } };
    let type = fallbackType;
    if (hasType) {
      type = String(raw.type).trim().toLowerCase();
      if (!SPEC_TYPES.includes(type)) {
        return { error: `sync.jira.map.${key}: type "${raw.type}" is not a TL spec type — use one of: ${SPEC_TYPES.join(', ')}` };
      }
    }
    let tags = [];
    if (hasTags) {
      if (!Array.isArray(raw.tags)) {
        return { error: `sync.jira.map.${key}: "tags" must be a list` };
      }
      tags = raw.tags.map((t) => String(t).trim()).filter(Boolean);
    }
    return { entry: { to: 'spec', type, tags } };
  }
  return { error: `sync.jira.map.${key}: unrecognized value — use intent | spec | ignore, or a block with "to:"` };
}

// Build the effective type map from the workspace's raw `sync.jira.map`.
// Returns { map, errors }: `map` is defaults merged with every valid workspace
// entry (workspace wins on key collision); `errors` lists every invalid entry
// as a human-readable line. Errors are a config problem — sync's precondition
// step stops and prints them rather than running with a partial map. An
// absent, null, or empty raw map is valid and yields exactly the defaults.
function normalizeTypeMap(rawMap) {
  const map = {};
  for (const [k, v] of Object.entries(DEFAULT_TYPE_MAP)) {
    map[k] = { ...v, ...(v.to === 'spec' ? { tags: [] } : {}) };
  }
  const errors = [];
  if (rawMap == null) return { map, errors };
  if (typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return { map, errors: ['sync.jira.map: must be a mapping of issue type → target'] };
  }
  for (const [rawKey, rawValue] of Object.entries(rawMap)) {
    const key = normalizeTypeKey(rawKey);
    if (!key) { errors.push('sync.jira.map: empty issue-type key'); continue; }
    const { entry, error } = normalizeEntry(key, rawValue);
    if (error) { errors.push(error); continue; }
    map[key] = entry;
  }
  return { map, errors };
}

// The concrete "what to add" line for an unmapped type, shown in the log
// detail and the report. Keeps the exact YAML the user would paste.
function configHint(issueTypeName) {
  const key = normalizeTypeKey(issueTypeName) || '<type>';
  return `unmapped JIRA issue type "${String(issueTypeName == null ? '' : issueTypeName).trim() || '(blank)'}" — held, not imported. ` +
    `Map it in TRIAGE.yml under sync.jira.map, e.g. \`${key}: spec\` (or \`${key}: ignore\` to drop it explicitly).`;
}

// Classify one JIRA issue-type name against a normalized map.
// Returns one of:
//   { action: 'intent' }
//   { action: 'spec', type: <SPEC_TYPES>, tags: [...] }
//   { action: 'ignore' }
//   { action: 'unmapped', hint: <configHint line> }
// Matching is case- and whitespace-insensitive via normalizeTypeKey.
function classifyIssueType(issueTypeName, normalizedMap) {
  const map = normalizedMap || normalizeTypeMap(null).map;
  const key = normalizeTypeKey(issueTypeName);
  const entry = key ? map[key] : undefined;
  if (!entry) return { action: 'unmapped', hint: configHint(issueTypeName) };
  if (entry.to === 'intent') return { action: 'intent' };
  if (entry.to === 'ignore') return { action: 'ignore' };
  return { action: 'spec', type: entry.type || 'feature', tags: entry.tags || [] };
}

module.exports = {
  SPEC_TYPES,
  MAP_TARGETS,
  DEFAULT_TYPE_MAP,
  normalizeTypeKey,
  normalizeTypeMap,
  classifyIssueType,
  configHint,
};

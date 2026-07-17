// lib/frontmatter.js — safe frontmatter field writes.
//
// The UI server mutates spec/thread frontmatter in response to browser actions
// (status changes, priority overrides). Doing that with `includes`/`replace` on
// the whole file is fragile — a duplicate substring in the body, or a newline /
// stray `---` in user text, can corrupt the record. These helpers keep edits
// scoped to the leading frontmatter block and sanitize values to a single safe
// line. Node stdlib only.

'use strict';

const fs = require('fs');
const path = require('path');

// Sanitize an arbitrary string to sit safely inside a double-quoted, single-line
// YAML scalar as parsed by lib/parse.js: no newlines (which would break the
// record open) and no unescaped double quotes (which would end the string early).
// Matches the tool's existing convention of folding `"` to `'`.
function fmValue(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
}

// These fields are booleans in the TL schema. Keep the set deliberately small:
// a non-boolean field whose text happens to be "true" must remain a string.
const BOOLEAN_FIELDS = Object.freeze(['awaiting_verifier', 'auto_reviewed']);

// Replace-or-insert a single frontmatter field, scoped to the leading
// `--- … ---` block so a matching line in the body is never touched. The value
// is written as a sanitized double-quoted scalar, except schema boolean fields
// which are emitted as bare YAML booleans. If the text has no frontmatter
// block, it's returned unchanged.
//
// Release contract (SCHEMA.md `hold_reason`): `status: ready` only ever means
// "released to the specs/ run queue", and a released spec must not carry a
// shaping hold. So setting `status` to `ready` also strips any `hold_reason`
// line — this is how the cockpit release path (`ui/server.js` `setSpecStatus`)
// clears the hold without the endpoint knowing about the field.
function setFrontmatterField(text, key, value) {
  const src = String(text);
  const m = src.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
  if (!m) return src;
  const boolField = BOOLEAN_FIELDS.includes(key);
  const boolValue = value === true || value === 'true' ? true
    : value === false || value === 'false' ? false : null;
  const line = boolField && boolValue !== null
    ? `${key}: ${boolValue}`
    : `${key}: "${fmValue(value)}"`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  let block = re.test(m[2]) ? m[2].replace(re, line) : (line + '\n' + m[2]);
  if (key === 'status' && fmValue(value) === 'ready') {
    block = block.split('\n').filter(l => !/^hold_reason:/.test(l)).join('\n');
  }
  return m[1] + block + m[3] + src.slice(m[0].length);
}

// Append one value to a frontmatter list. Malformed scalar fields are refused;
// edits stay inside the leading frontmatter block and suppress duplicates.
function appendToFrontmatterList(text, key, value) {
  const src = String(text);
  const m = src.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
  if (!m) return src;
  const val = fmValue(value);
  const unq = s => s.trim().replace(/^["']|["']$/g, '');
  const lines = m[2].split('\n');
  const keyRe = new RegExp(`^${key}:(.*)$`);
  const ki = lines.findIndex(l => keyRe.test(l));
  const item = `  - "${val}"`;
  if (ki < 0) lines.unshift(`${key}:`, item);
  else {
    const rest = lines[ki].match(keyRe)[1].replace(/\s#.*$/, '').trim();
    const inline = rest.match(/^\[(.*)\]$/);
    if (inline && inline[1].trim()) {
      const entries = inline[1].split(',').map(unq);
      if (entries.includes(val)) return src;
      lines[ki] = `${key}: [${entries.map(e => `"${e}"`).concat(`"${val}"`).join(', ')}]`;
    } else if (inline || !rest) {
      let j = ki + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j])) {
        if (unq(lines[j].replace(/^\s+-\s*/, '')) === val) return src;
        j++;
      }
      lines[ki] = `${key}:`;
      lines.splice(j, 0, item);
    } else return src;
  }
  return m[1] + lines.join('\n') + m[3] + src.slice(m[0].length);
}

// Replace a frontmatter list with one flow-style list, absorbing old block
// items while leaving body text and neighboring fields byte-stable.
function setFrontmatterList(text, key, values) {
  const src = String(text);
  const m = src.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
  if (!m) return src;
  const line = `${key}: [${values.map(fmValue).join(', ')}]`;
  const lines = m[2].split('\n');
  const ki = lines.findIndex(l => new RegExp(`^${key}:`).test(l));
  if (ki < 0) lines.unshift(line);
  else {
    let j = ki + 1;
    while (j < lines.length && /^\s+-\s/.test(lines[j])) j++;
    lines.splice(ki, j - ki, line);
  }
  return m[1] + lines.join('\n') + m[3] + src.slice(m[0].length);
}

// Fields a ranking/grooming pass must never write. Stage and claim state
// belong to the builder holding the spec and to the folder itself — a triage
// or groom pass that touches these from an inventory snapshot can resurrect
// pre-claim state and clobber live work (the 2026-07-14 stale-snapshot
// incidents: claimed in-progress specs bulk re-serialized back to
// specs/ + status: ready mid-run).
const PROTECTED_FIELDS = Object.freeze([
  'status',
  'claimed_by',
  'claimed_at',
  'awaiting_verifier',
  'requested_at',
  'verified_by',
  'verification_type',
]);

// Guarded, targeted frontmatter stamp for bulk passes (triage/groom).
//
// - Targeted-field-edit rule: each field is written via setFrontmatterField —
//   only that field's line changes; the block is never re-serialized, so
//   quoting, ordering, and fields the pass never asked about survive.
// - Protected-field rule: refuses to write lifecycle/claim fields at all
//   ({ ok: false, reason: 'protected-fields' }).
// - Staleness guard: re-stats the spec's inventoried path at write time. If
//   the SPEC.md is no longer there, the spec moved stages since the pass took
//   its snapshot — that is someone's live work, so the write is skipped and
//   reported ({ ok: false, reason: 'moved' }) instead of recreating the old
//   path or restoring snapshot state.
function stampSpecFields(specDir, fields, opts = {}) {
  const entries = Object.entries(fields || {});
  const protectedHits = entries.map(([k]) => k).filter(k => PROTECTED_FIELDS.includes(k));
  if (protectedHits.length) {
    return { ok: false, skipped: true, reason: 'protected-fields', fields: protectedHits };
  }
  const file = path.join(specDir, opts.file || 'SPEC.md');
  let st = null;
  try { st = fs.statSync(file); } catch { /* moved or gone */ }
  if (!st || !st.isFile()) return { ok: false, skipped: true, reason: 'moved', file };
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of entries) text = setFrontmatterField(text, k, v);
  fs.writeFileSync(file, text);
  return { ok: true, written: entries.map(([k]) => k) };
}

module.exports = {
  fmValue, setFrontmatterField, appendToFrontmatterList, setFrontmatterList,
  stampSpecFields, PROTECTED_FIELDS, BOOLEAN_FIELDS,
};

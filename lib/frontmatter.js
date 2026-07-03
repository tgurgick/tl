// lib/frontmatter.js — safe frontmatter field writes.
//
// The UI server mutates spec/thread frontmatter in response to browser actions
// (status changes, priority overrides). Doing that with `includes`/`replace` on
// the whole file is fragile — a duplicate substring in the body, or a newline /
// stray `---` in user text, can corrupt the record. These helpers keep edits
// scoped to the leading frontmatter block and sanitize values to a single safe
// line. Node stdlib only.

'use strict';

// Sanitize an arbitrary string to sit safely inside a double-quoted, single-line
// YAML scalar as parsed by lib/parse.js: no newlines (which would break the
// record open) and no unescaped double quotes (which would end the string early).
// Matches the tool's existing convention of folding `"` to `'`.
function fmValue(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
}

// Replace-or-insert a single frontmatter field, scoped to the leading
// `--- … ---` block so a matching line in the body is never touched. The value
// is written as a sanitized double-quoted scalar. If the text has no
// frontmatter block, it's returned unchanged.
function setFrontmatterField(text, key, value) {
  const src = String(text);
  const m = src.match(/^(---\n)([\s\S]*?)(\n---\n?)/);
  if (!m) return src;
  const line = `${key}: "${fmValue(value)}"`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const block = re.test(m[2]) ? m[2].replace(re, line) : (line + '\n' + m[2]);
  return m[1] + block + m[3] + src.slice(m[0].length);
}

module.exports = { fmValue, setFrontmatterField };

// lib/workspace.js — tiny filesystem helpers + the path-traversal guard.
//
// Shared by the CLI and the UI server. `safePath` is the one security-critical
// piece: every write/read of a caller-supplied relative path goes through it so
// nothing can escape the workspace/repo root via `../`.

'use strict';

const fs = require('fs');
const path = require('path');

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readFirst(...paths) { for (const p of paths) { const t = safeRead(p); if (t !== null) return t; } return null; }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

// Resolve `rel` under `baseDir`, refusing anything that escapes the base.
// Returns the absolute path, or null if `rel` would resolve outside baseDir
// (e.g. `../../etc/passwd`). The base itself resolves to the base.
function safePath(baseDir, rel) {
  const base = path.resolve(baseDir);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;

  // Lexical containment does not stop `base/link -> /outside`. Resolve the
  // nearest existing ancestor so both existing reads and not-yet-created write
  // targets are rejected when any ancestor escapes through a symlink.
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { return null; }
  let ancestor = full;
  while (ancestor !== base) {
    try { fs.lstatSync(ancestor); break; } catch { ancestor = path.dirname(ancestor); }
  }
  let realAncestor;
  try { realAncestor = fs.realpathSync(ancestor); } catch { return null; }
  if (realAncestor !== realBase && !realAncestor.startsWith(realBase + path.sep)) return null;
  return full;
}

module.exports = { safeRead, readFirst, isDir, mtime, safePath };

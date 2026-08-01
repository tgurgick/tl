'use strict';
// test/ui-horizon-hide-done.test.js — Horizon hide-completed toggle contract
// (ui/index.html). A calm show/hide-done control whose state is apparent
// (label + aria-pressed), hides only stage 'done', persists across SSE
// re-renders via the module-level resumeOpen pattern (session-local UI state),
// and never touches lifecycle data — the toggle writes no workspace files.
// Behavior was verified by driving a scratch server (see FEEDBACK.md); this
// locks the markup/wiring so it cannot silently regress.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const UI_HTML = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');

test('control: calm toggle with the current state apparent', () => {
  assert.match(UI_HTML, /hz-toggle/);
  assert.match(UI_HTML, /aria-pressed/);
  // both labels exist and carry the hidden/shown count
  assert.match(UI_HTML, /`show done \(\$\{doneTotal\}\)`/);
  assert.match(UI_HTML, /`hide done \(\$\{doneTotal\}\)`/);
  // the control only appears when there is completed work to hide
  assert.match(UI_HTML, /if \(doneTotal\)/);
});

test('filter: hiding removes only completed items', () => {
  // stage-based filter — ready/in-progress/tests/in-review/blocked/shaping
  // never match stage 'done', so they all stay
  assert.match(UI_HTML, /hideDone \? l\.specs\.filter\(s => s\.stage !== 'done'\) : l\.specs/);
  // all-done lanes stay legible instead of vanishing
  assert.match(UI_HTML, /hz-alldone/);
  assert.match(UI_HTML, /all \$\{doneN\} done · hidden/);
});

test('persistence: resumeOpen pattern — survives SSE re-renders, defaults off', () => {
  // session-local key in the same store the rest of Resume uses
  assert.match(UI_HTML, /const resumeOpen = \{ [\s\S]*?hzHideDone: \{\} \};/);
  // read per-workspace with a falsy default (existing users see no change)
  assert.match(UI_HTML, /const hideDone = !!resumeOpen\.hzHideDone\[ws\.name\]/);
  // toggle flips the store and rebuilds just the horizon section
  assert.match(UI_HTML, /resumeOpen\.hzHideDone\[ws\.name\] = !hideDone; builders\.hz\(\)/);
});

test('read-only: the toggle never writes workspace data', () => {
  // lifecycle semantics and done records stay untouched — the whole hide-done
  // block performs no POST; it only flips local state and re-renders
  const hz = UI_HTML.match(/hz: \(\) => \{[\s\S]*?\n {6}\},\n {6}bl:/);
  assert.ok(hz, 'horizon builder not found');
  assert.doesNotMatch(hz[0], /postJSON|fetch\(/);
});

'use strict';
// test/ui-scroll.test.js — agent-pane scroll containment contract (ui/index.html).
//
// Every bounded pane list in the Run/Review surfaces scrolls inside its own
// bounds: the flex chain carries explicit `min-height: 0` (no content-height
// floors), each list body owns `overflow(-y): auto`, `overscroll-behavior:
// contain` stops a finished list from scrolling an ancestor, and scrollbars
// are `thin` (visible affordance) — never `none`, which made overflowing
// lanes read as "cut off" (threads/2026-07-14-make-all-the-agent-windows-
// scrollable…). Markup/style regression in the repo's established UI-contract
// style; the flex/overflow semantics themselves were verified by driving a
// scratch server (see the spec's FEEDBACK.md).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const UI_HTML = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');

// one CSS rule body for a selector (first match)
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = UI_HTML.match(new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, `missing CSS rule for "${selector}"`);
  return m[1];
}

test('lane lists: bounded, independently scrollable, visible affordance', () => {
  const lane = rule('.lane');
  assert.match(lane, /min-height:\s*0/, '.lane needs min-height: 0');
  const body = rule('.lane-body');
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /overscroll-behavior:\s*contain/);
  assert.match(body, /scrollbar-width:\s*thin/);
});

test('deck panes (files / activity / viewer): same containment discipline', () => {
  assert.match(rule('.deck'), /min-height:\s*0/);
  for (const sel of ['.fpane .body', '.apane .body']) {
    const r = rule(sel);
    assert.match(r, /min-height:\s*0/, sel);
    assert.match(r, /overflow-y:\s*auto/, sel);
    assert.match(r, /overscroll-behavior:\s*contain/, sel);
    assert.match(r, /scrollbar-width:\s*thin/, sel);
  }
  const v = rule('.vpane .body');
  assert.match(v, /min-height:\s*0/);
  assert.match(v, /overflow:\s*auto/);
  assert.match(v, /overscroll-behavior:\s*contain/);
});

test('review deck (queue list / detail): scroll containment', () => {
  assert.match(rule('.exp-deck'), /min-height:\s*0/);
  for (const sel of ['.exp-queue .body', '.exp-detail .body']) {
    const r = rule(sel);
    assert.match(r, /min-height:\s*0/, sel);
    assert.match(r, /overflow-y:\s*auto/, sel);
    assert.match(r, /overscroll-behavior:\s*contain/, sel);
  }
});

test('no pane list hides its scrollbar entirely', () => {
  // `scrollbar-width: none` is what made overflowing lists look clipped —
  // it must not come back on any pane body.
  assert.doesNotMatch(UI_HTML, /scrollbar-width:\s*none/);
});

test('lane headers stay pinned while bodies scroll', () => {
  assert.match(rule('.lane-head'), /flex:\s*none/);
  assert.match(rule('.panel-head'), /flex:\s*none/);
});

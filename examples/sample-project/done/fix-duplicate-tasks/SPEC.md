---
title: "Fix duplicate tasks on double-tap of save"
created: 2026-05-20
project: "todo-app"
repo: "~/code/todo-app"
intent: ""
type: "bug"
status: "done"
priority: "p0"
size: "small"
depends_on: []
blocks: []
tags: [data-integrity]
---

# Fix duplicate tasks on double-tap of save

## Objective

Tapping save twice on the new-task screen creates exactly one task.

## Context

Beta testers (12 affected users) reported duplicate tasks. The save button stays enabled while the async write is in flight, so a double-tap commits twice. See `context/repro-notes.md`.

## Acceptance criteria

- [x] Save button disables on first tap until the write resolves
- [x] Regression test: `npm test -- TaskCreate` covers the double-tap case
- [x] No duplicates in a 50-tap stress test

## Scope

### Files to touch

- `src/screens/TaskCreate.tsx` — disable-while-saving state

### Do not touch

- `src/store/TaskStore.ts` — the store is correct; the bug is in the screen

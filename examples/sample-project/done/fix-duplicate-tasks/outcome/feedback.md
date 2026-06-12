---
spec: "done/fix-duplicate-tasks/"
completed: 2026-05-22
agent_model: "claude-fable-5"
scores:
  correctness: 5
  completeness: 5
  scope_discipline: 5
priority_was_right: true
---

# Feedback: fix duplicate tasks on double-tap of save

## Asked vs. delivered

The spec asked for exactly one task per save regardless of tap speed; the agent delivered a disable-while-saving state on the save button plus a regression test. Verified in beta build 0.9.4 — no duplicate reports since.

## What went well

- The "do not touch TaskStore" boundary kept the fix small; the agent went straight to the screen-level state.

## What went wrong

- Nothing notable.

## Captured threads

- none — the fix surfaced no out-of-scope discoveries

## Pattern candidates

Any async submit button should disable while in flight — added to `_patterns/PATTERNS.md` as "guard async submits".

## Carry-forward

The new-task screen now has a `saving` state other screens could reuse.

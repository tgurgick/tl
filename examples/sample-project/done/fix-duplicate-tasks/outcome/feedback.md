# Feedback

**Completed:** 2026-05-22
**Result:** Fix verified in beta build 0.9.4 — no duplicate reports since.

What worked: the spec's "do not touch TaskStore" boundary kept the fix small; the agent went straight to the screen-level state.

Pattern worth keeping: any async submit button should disable while in flight. Added to `_patterns/PATTERNS.md` as "guard async submits".

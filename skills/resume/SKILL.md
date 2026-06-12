---
name: resume
description: Reconstruct context for a tl workspace after time away — last activity, open loops, recent decisions, and the recommended next action. Use when the user asks where did I leave off, what changed, what's the status, catch me up, or starts a session on a project after a gap.
---

# /tl resume

Answers "where am I?" before "what exists." Read-only; needs no network.

## Resolve the workspace

Same as `/tl triage`: argument or context names a workspace under `projects/`; exactly one workspace → use it; otherwise ask.

## Steps

Read specs (all stages), `threads/`, `PRIORITIES.md`, `TRIAGE.yml`, and `_metrics/*.jsonl` (last lines). Then report exactly these sections, in this order — they mirror the UI's Resume tab, so CLI and UI never drift:

**1. Focus** — the top-weighted goal from `TRIAGE.yml`, one line.

**2. Last activity** — the most recent meaningful events: latest completed spec (from `done/` mtimes or `cycle-log.jsonl`), latest spec moved to in-progress, latest triage run and whether it detected overrides. Two or three lines, newest first.

**3. Open loops** — threads where `type` is `question`, `decision`, or `risk` AND `status: open`, plus blocked specs with what blocks them, plus done specs missing `outcome/FEEDBACK.md`. These are the unresolved items a human forgets; surface them before anything else.

**4. Recent decisions** — the last few `type: decision` threads (any status), title + one-line why.

**5. Parked** — one line: "N parked threads (M ideas, K followups…)" — visibility without noise.

**6. Recommended next** — one concrete action with a reason. Default: the top item of `PRIORITIES.md` Next up. Override the default when something upstream matters more: an open `question` thread blocking the top spec, a goal with zero active specs, or work in `in-progress/` that's been idle longest. Say which rule fired.

## Guardrails

- Read-only — never move, edit, or create anything (capture suggestions go through `/tl capture`).
- Six sections, tight lines. Resume is a glance, not a report. If a section is empty, say so in three words.

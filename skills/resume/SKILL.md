---
name: resume
description: Reconstruct context for a tl workspace after time away — last activity, open loops, recent decisions, and the recommended next action. Use when the user asks where did I leave off, what changed, what's the status, catch me up, or starts a session on a project after a gap.
---

# /tl resume

Answers "where am I?" before "what exists." Read-only; needs no network.

## Resolve the workspace

Same as `/tl triage`: argument or context names a workspace under `projects/`; exactly one workspace → use it; otherwise ask.

## Steps

Read specs (all stages), `threads/`, `PRIORITIES.md`, `TRIAGE.yml`, and `_metrics/*.jsonl` (last lines). Then report exactly these sections, in this order — they mirror the UI's Resume tab top to bottom, so CLI and UI never drift:

**1. Status** — what changed while away: completed specs (count + the most recent, from `done/` mtimes or `cycle-log.jsonl`) and anything in-progress. One or two lines.

**2. Goal in focus** — the top-weighted goal from `TRIAGE.yml`, one line, with its weight and key-result count.

**3. In focus** — the single thing that needs a human, with the reason:
   - a top-ranked `ready` spec to delegate, or
   - an open `question` thread to answer (upstream of new work), or
   - if neither and specs are in-progress: "all clear — agents working, nothing needs you," point at Live Look, or
   - if nothing at all: "queue empty — decompose the next slice of an intent."
   Say which case fired. This is the page's one hero; keep it to the recommendation plus one line of why.

**4. Open loops** — threads where `type` is `question`, `risk`, or `decision` AND `status: open`, plus blocked specs, plus done specs missing `outcome/FEEDBACK.md` — sharpest first (risk > question > blocked > feedback). The unresolved items a human forgets.

**5. Backlog · decisions · parked** — counts, with detail only if asked: the ranked `ready`+`triage` backlog, recent `decision` threads, and the parked-thread count by type. These are reference, not headline.

## Guardrails

- Read-only — never move, edit, or create anything (capture suggestions go through `/tl capture`).
- Six sections, tight lines. Resume is a glance, not a report. If a section is empty, say so in three words.

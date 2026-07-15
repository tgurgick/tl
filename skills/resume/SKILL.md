---
name: resume
description: Reconstruct context for a tl workspace after time away — last activity, open loops, recent decisions, and the recommended next action. Use when the user asks where did I leave off, what changed, catch me up, or starts a session on a project after a gap (learn — where am I).
---

# /tl resume

Answers "where am I?" before "what exists." Read-only; needs no network.

## Resolve the workspace

Same as `/tl triage`: argument or context names a workspace under `projects/`; exactly one workspace → use it; otherwise ask.

## Steps

Read specs (all stages), `threads/`, `PRIORITIES.md`, `TRIAGE.yml`, and `_metrics/*.jsonl` (last lines). Then report exactly these sections, in this order — they mirror the UI's Resume tab top to bottom, so CLI and UI never drift:

**1. Status** — what changed while away: completed specs (count + the most recent, from `done/` mtimes or `cycle-log.jsonl`) and anything in-progress. For each `in-progress/` spec, **read `NOTES.md` if present** and surface it here — especially `— kicked back` notes from `/tl review`; those are binding corrections the next worker must honor before re-reading `FEEDBACK.md`. One or two lines plus any kickback note verbatim.

**2. Goal in focus** — the top-weighted goal from `TRIAGE.yml`, one line, with its weight and key-result count.

**3. In focus** — the single thing that needs a human. Pick with this **priority order** (highest first — same rules the cockpit Resume tab uses via `lib/resume-recommended.js`):

   1. an open `question` / `risk` / `decision` thread whose `linked_spec` blocks the **top ready** spec — outranks generic backlog
   2. the top-weighted goal with **zero active** specs (`ready` / `in-progress` / `tests` / `in-review`) — a decompose / goal-health ask; **do not** flag the goal (or its intents) as starving when every linked spec is already `done`
   3. the longest-idle `in-progress` spec that has **`NOTES.md`** (kickback / mid-flight) — surfaces ahead of ordinary ready work
   4. a top-ranked `ready` spec to delegate
   5. any open `question` thread (upstream of new work)
   6. if none of the above and specs are in-progress: "all clear — agents working, nothing needs you," point at Live Look
   7. if nothing at all: "queue empty — decompose the next slice of an intent"

   Say which case fired. This is the page's one hero; keep it to the recommendation plus one line of why.

**4. Open loops — the decay inbox (capped).** Resume is the place a project gets *cleaned*, not just read — but it must never overwhelm. Detect every kind of decay:
   - open `question` / `risk` / `decision` threads
   - blocked specs (with what blocks them)
   - done specs missing `outcome/FEEDBACK.md`
   - `in-progress` specs with **`NOTES.md`** (kickback / mid-flight feedback — rank these **above** stalled-idle; read the note, not just the folder)
   - `in-progress` specs idle too long without notes (stalled?)
   - `triage` items aging (promote or kill?)
   - a goal with **zero active specs** — it's starving; an intent needs decomposing or the goal needs dropping (this is the priorities-back-to-intent check). Never when all linked specs are `done`.
   - completed `research` specs whose recommendation is awaiting a human decision
   - parked threads piling up (cleanup review)

   Then **surface at most 3 as "needs you now,"** ranked by impact: (1) anything blocking the in-focus item, (2) anything starving the top-weighted goal, (3) NOTES/kickback before plain idle, then the oldest unresolved item. Everything else is a single line — "+N more loose ends" — visible but never demanded. The cap is the point: a restart should ask for a few decisions, not confront a wall.

**5. Backlog · decisions · parked** — counts, with detail only if asked: the ranked `ready`+`triage` backlog, recent `decision` threads, and the parked-thread count by type. These are reference, not headline.

## Responding to an ask

When you surface a loop and the human engages, three responses are always available — and "I'm not ready to decide" is a first-class one:

- **Resolve** — answer it now; set the thread `status: closed` (or write the missing FEEDBACK, unblock the spec). The loop clears.
- **Park** — good, not now; `status: parked`. It leaves the inbox, stays in memory.
- **Research it** — the release valve for "don't make me commit yet." Dispatch a `type: research` spec (`specs/research-<slug>/`, from `_templates/spec/`): objective is *investigate the question and recommend a direction — do not implement*; link it to the source thread and flip that thread to `status: promoted`. An agent picks it up like any spec; when it completes, its recommendation re-enters resume as a now-*informed* decision. This is how the system explores areas the human isn't ready to commit to, without either forcing a premature choice or losing the question.

## Guardrails

- The report is read-only — surfacing and ranking only. Acting on an ask (resolve / park / research) is the human's explicit choice, then carried out by the matching skill (`/tl capture`, a thread-status edit, or a research-spec dispatch).
- Honor the cap. Three asks at most; the rest stays counted, not listed. Resume is a glance and a short to-do, never a report.
- If a section is empty, say so in three words.
- Recommended-next selection is shared with the UI — do not invent a different order; follow the numbered priority above (and the same pure helper when present: `lib/resume-recommended.js`).

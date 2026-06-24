---
name: promote
description: Turn a parked thread into a draft intent through a short Q&A — read the thread, interview for the outcome, the goal it ladders to, and success metrics, then propose an intent and, on approval, write it and flip the thread to promoted. Use when the user wants to promote a thread, turn an idea or question into an intent, commit to a parked thought, or act on a "promote or kill?" decay-inbox nudge.
---

# /tl promote

The commit path for a parked thought. Where the research valve (`/tl resume`'s "research it") says *"explore, don't commit yet,"* `promote` is the opposite: it graduates a thread you're ready to act on into a first-class **intent** — the why — without a hand-edit. It **proposes**; it writes only on your approval; the result is one diffable file plus a linked thread.

## Resolve the workspace

Same as `/tl triage`: the argument's workspace name under `projects/` or a path; with exactly one workspace, use it; otherwise ask.

## Pick the thread

The argument may also name a thread (path or slug). With none, list the `open` and `parked` threads (newest first, with type and origin) and ask which to promote — or take the one a *"promote or kill?"* decay nudge pointed at. Read it fully: title, body, `type`, `origin`, any `linked_intent` / `linked_spec`.

## The interview — draft the intent

The thread is the **seed**, not the intent: an intent is an outcome with a measure. One question group at a time; offer drafts pulled from the thread so a fast user can just accept.

1. **Outcome** — restate the thread as a *result* in human language ("the judgment steps are quick interviews, not hand-edits"), never implementation. Draft it from the thread; let them sharpen.
2. **The goal it ladders to** — which `TRIAGE.yml` goal does this serve? This is the top rung. An intent with no goal is a break (`/tl map` flags it), so if nothing fits, **stop and suggest `/tl goal` first** — never write a goal-less intent.
3. **Success metrics (1–2, observable) and scope (in / out)** — draft, push back gently on vague ("better" → "what would you see?").

## Propose, then write

1. **Show the drafted intent** — frontmatter (`goals`, `priority`, `tags`) plus Outcome, metrics, and scope.
2. **Get explicit approval.** On "no", take the change and re-propose. Never write unprompted.
3. **Write** `intents/YYYY-MM-DD-<slug>.md` from `_templates/intent.md` (schema: `_templates/SCHEMA.md`), `status: approved`.
4. **Link both ways** so the lineage is auditable: set the source thread's `status: promoted` and its `linked_intent` to the new intent's path.

## After

Point at the next rung, don't take it: a freshly promoted intent has no specs yet, so `/tl map` will flag it as the next break. Offer to **decompose it into a first spec** (`/tl decompose` when it exists, otherwise from `_templates/spec/`), and note that `/tl triage` should re-run so the new work enters the ranking.

## Guardrails

- **Promote, don't research.** This *commits* to an intent; the research valve is for "not ready to commit." Don't conflate the two paths.
- **Never write a goal-less intent.** No matching goal → run `/tl goal` first.
- Never invent an outcome the thread doesn't support — the thread is the seed; the human shapes it. Defaults are for structure, not substance.
- Propose → approve → write. No silent writes, ever.
- Don't delete or rewrite the thread — flip it to `promoted` and link it, so the idea's lineage survives.
- One thread → one intent.

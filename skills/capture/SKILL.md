---
name: capture
description: Save a thought as a tl thread — a parked idea, open question, decision, risk, or follow-up that shouldn't be lost but isn't active work. Use when the user says capture this, park this, don't lose this, note for later, or an agent surfaces an out-of-scope discovery worth keeping.
---

# /tl capture

Zero ceremony: one thought in, one thread file out. Never an interview.

## Resolve the workspace

Same as `/tl triage`: argument or context names a workspace under `projects/`; exactly one workspace → use it; otherwise ask. If `threads/` doesn't exist, create it.

## Steps

1. **Take the thought as given** — from the user's words or the discovery being captured. Don't expand it; a thread is a bookmark, not an essay.
2. **Infer the frontmatter** (template: `../../_templates/thread.md`, schema: `../../_templates/SCHEMA.md`):
   - `type`: a choice made → `decision` (status `closed`); something unresolved that blocks or nags → `question`; could break us later → `risk`; debt/tidying → `cleanup`; work implied by finished work → `followup`; otherwise → `idea`
   - `status`: `closed` for recorded decisions, `open` for questions/risks needing resolution, `parked` for the rest
   - `origin`: the spec, conversation, or person it came from — always fill this
   - `linked_intent` / `linked_spec` when obvious
3. **Write** `threads/YYYY-MM-DD-<slug>.md` — title + a one-to-three-sentence body (decisions include the why).
4. **Confirm in one line**: the path and type. Nothing else.

## When other skills capture

At spec completion, list discoveries under "Captured threads" in `outcome/FEEDBACK.md` and write each as a thread via these rules. A completed spec with undocumented discoveries is a leak.

## Guardrails

- Never create a spec, edit priorities, or expand the thought's scope.
- One thought = one thread. A braindump becomes several small threads, not one long one.

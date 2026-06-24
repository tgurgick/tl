---
name: goal
description: Add or rebalance the goals in a tl workspace's TRIAGE.yml through a short Q&A — interview for a new goal's description, observable key results, and relative importance, then propose weights renormalized to 1.0 and write the change on approval. Use when the user wants to add a goal, change priorities or weights, or rebalance what a project is optimizing for.
---

# /tl goal

Conversational editing of the one human-owned config — the `goals` in `TRIAGE.yml`. Replaces hand-editing with a short interview that always leaves weights summing to exactly 1.0. It **proposes**; it writes only on your approval; the result is one diffable change you can read.

## Resolve the workspace

Same as `/tl triage`: the argument is a workspace name under `projects/` or a path; with exactly one workspace, use it; otherwise ask. Read its `TRIAGE.yml` (schema: `_templates/SCHEMA.md`); if it has no `goals` block, say so — adding the first goals is `/tl new`'s job.

## Modes

- **add** (default) — add a new goal and rebalance.
- **rebalance** — change weights across existing goals without adding one.
- **edit** — change one existing goal's description or key results (no weight change).

## add — the interview

One question group at a time; always offer a concrete default so a fast user can just accept.

1. **Name + one-line description** — in outcome language ("Continuously cleaning the backlog"), not implementation. The `id` is the kebab-case slug of the name.
2. **Key results (2–4)** — observable. Push back gently on vague ones ("better hygiene" → "what would you *see* when it's true?"). Offer drafts; let them refine.
3. **Relative importance** — the priority signal that drives the math. Ask it the easy way: "more or less important than which existing goals?", or "what weight feels right (0–1)?". Convert a ranking into a target weight that sits sensibly among the others.

## Rebalance to 1.0

The invariant: after any write, the weights sum to exactly 1.00.

- **add:** place the new goal at its target weight `w`; scale every existing goal by `(1 − w)` so their proportions are preserved and the total returns to 1.0.
- **rebalance:** apply the user's intent (e.g. "make continuity dominant"), then renormalize all weights to sum to 1.0.
- Round to 2 decimals; if rounding leaves the sum at 0.99 or 1.01, absorb the ±0.01 on the largest goal so the printed sum is exactly 1.00.

## Propose, then write

1. **Show before → after** for every goal — old weight → new weight, the new goal marked `(new)`, and the `sum = 1.00` line. Include the drafted description and key results.
2. **Get explicit approval.** On "no", take the adjustment and re-propose. Never write unprompted.
3. **Write `TRIAGE.yml`.** Append the new goal block (`id`, `description`, `weight`, `key_results`) in the same shape as the existing ones, and update each changed `weight` in place. Preserve everything else — comments, field order, allocation, rules, error_tracking — byte-for-byte except the lines that changed.
4. **Log the rationale** (so `/tl reflect` can learn from weight decisions): append to `_metrics/goal-log.jsonl`:
   `{"date": "...", "action": "add", "goal": "<id>", "weight": 0.15, "rebalanced": {"<id>": [0.60, 0.51], ...}, "reason": "<the importance answer in the user's words>"}`

## After

Point at the next rung, don't take it: a goal with nothing laddering to it is a *starving goal* (`/tl map` will flag it). Offer to draft an **intent** under the new goal (`/tl promote` from a parked thread, or a fresh intent), then a spec. Note that `/tl triage` should re-run so the new weight actually affects ranking.

## Guardrails

- Never invent a goal, description, or key result the user didn't express — defaults are for *structure* (the weight split, the question shape), not substance.
- Weights always sum to exactly 1.00. Never write a set that doesn't.
- Touch only the `goals` block. Never edit specs, intents, priorities, allocation, or rules here.
- Propose → approve → write. No silent writes, ever.
- Preserve human-added comments and all non-goal config in `TRIAGE.yml`.

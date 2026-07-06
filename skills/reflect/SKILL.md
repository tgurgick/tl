---
name: reflect
description: Learn from a tl workspace's history — read the override reasons and outcome feedback, propose evidence-backed changes to TRIAGE.yml (weights and rules), and scan the dependency graph for work that can run in parallel. Use when the user wants to tune prioritization, improve triage, find parallelizable work, or asks "what should we change about how we prioritize?". Proposes; never auto-applies.
---

# /tl reflect

The meta-level of triage. Where `/tl triage` applies the policy in `TRIAGE.yml`, `reflect` reads what actually happened and proposes how the policy should change — then looks at the roadmap for work that could advance in parallel. It proposes with evidence; the human owns the config and approves before anything is written.

Run occasionally (weekly, or after a batch of work), not daily.

## Resolve the workspace

Same as `/tl triage`: argument is a workspace name under `projects/` or a path; no argument + exactly one workspace → use it; otherwise ask.

## Preconditions

`reflect` learns from accumulated signal. Count the override entries (`_metrics/override-log.jsonl`) plus completed specs with scored `FEEDBACK.md`. If together they're fewer than ~5, stop and say there isn't enough history yet — name what's needed (more cycles, or overrides with reasons). Never infer policy from one or two data points.

## Steps

**1. Gather signals.**
- `_metrics/override-log.jsonl` — human priority overrides, each with `from`, `to`, and (when present) a `reason`. This is the contrast memory: "this, not that."
- `_metrics/goal-log.jsonl` — goal weight shifts from `/tl goal`, each with `action`, `goal`, `weight`, `rebalanced`, and (when present) a `reason` and optional `epoch`.
- `done/*/outcome/FEEDBACK.md` — `scores` (correctness / completeness / scope_discipline) and `priority_was_right`.
- `_metrics/triage-log.jsonl`, `_metrics/cycle-log.jsonl` — ranking history and durations.
- `TRIAGE.yml` — the current goals, weights, allocation, rules, and optional `focus` (the active epoch label).
- Every spec's frontmatter and body — for the dependency and file-scope scan in step 4.

**1b. Narrate priority epochs.** When `goal-log.jsonl` or `override-log.jsonl` lines carry an `epoch` label (or when `TRIAGE.yml` `focus` is set), group related lines by that label and narrate the span in the reflect proposal:
- For each distinct `epoch`, find the earliest `goal-log.jsonl` line with that label — that date and weight shift is the epoch start.
- For each `override-log.jsonl` line with the same label, narrate the priority change in context: *"specs/foo moved P3→P1 on 2026-06-26 (partner-launch epoch, started 2026-06-24 when dispatch-work weight went 0.15→0.30)."*
- Lines without an `epoch` are grouped by date proximity to the nearest labeled rebalance, or listed without epoch context.
- Include an **Epochs** section in the proposal when any labeled lines exist; skip it when none do. Reflect may *propose* naming an unlabeled cluster ("name this epoch?") but never writes `focus:` or log lines — that stays human-owned via `/tl goal`.

**2. Learn from overrides.** Group overrides by direction and reason. A pattern worth acting on is a *repeated* human correction in the same direction sharing a common thread — same `type`, `tag`, parent intent, or a recurring word in the reasons ("compliance", "deadline", "partner"). For each real pattern:
- If the reason names a factor the rules don't capture, propose a new priority rule that would have predicted those overrides.
- If one goal's specs are repeatedly bumped up (or down), propose a weight change for that goal.
Quote the specific override lines as evidence. No repeated pattern → no proposal.

**3. Learn from outcomes.** Cross-reference `priority_was_right` and `scores` against the priority each spec carried:
- High-priority specs that finished `priority_was_right: false` → the policy over-valued them; find their common goal/type and propose lowering that weight or tightening a rule.
- Low-priority specs that scored high value and `priority_was_right: true` → under-valued; propose the inverse.
Cite the FEEDBACK files behind each proposal.

**4. Scan the roadmap for parallel tracks.** Build the dependency graph from `depends_on` / `blocks` across `ready` + `in-progress` specs, and read each spec's file scope (the "Files to touch" / scope section of its SPEC). Then:
- **Parallel tracks** — find sets of ready specs that are mutually independent (no dependency path links them) *and* touch disjoint files. Group them so each track is a serial chain (dependencies respected within it) and the tracks are independent of one another — these can run concurrently, one agent each, without collision. Prefer tracks that advance *different* intents or goals, so parallelism buys real outcome throughput, not just file safety.
- **Serialize (collisions)** — ready specs that touch overlapping files, or sit on the same dependency chain, must not run at once; flag each conflict and which file or dependency forces the order.

**5. Write the proposal** to `_metrics/reflect-{date}.md`:
- **Observed** — each pattern found, with its evidence (the override lines / FEEDBACK files).
- **Epochs** — when labeled lines exist, the epoch-span narratives from step 1b (priority changes read back against their weight-shift context).
- **Proposed `TRIAGE.yml` changes** — concrete before → after for weights, rules, or allocation. Nothing vague.
- **Parallel tracks** — the independent chains that can run at once, and which goal each advances.
- **Serialize** — the collisions to avoid.
Append one line to `_metrics/reflect-log.jsonl`: `{"date": "...", "overrides_read": N, "outcomes_read": N, "proposals": N, "parallel_tracks": N}`.

**6. Propose, then apply only on confirmation.** Show the proposed `TRIAGE.yml` diff to the user and explain the evidence in one or two lines each. Apply it **only** if they explicitly approve. If applied, run the `/tl triage` algorithm (`../triage/SKILL.md`) so the backlog re-ranks under the new policy, and note that the parallel tracks reflect the new ranking.

## Guardrails

- **Never auto-apply `TRIAGE.yml` changes.** The config is the product leader; the human owns it. Propose with evidence, apply on an explicit yes.
- **Every proposal cites its evidence** — the overrides or outcomes that justify it. No evidence, no proposal.
- **Respect the minimum-data threshold** — silence is the right output when there isn't enough history.
- Parallel-track suggestions are **advisory** — `reflect` never moves, reorders, or edits specs; it informs how the human dispatches agents.
- Never invent goals, and never rewrite existing JSONL lines — append only.

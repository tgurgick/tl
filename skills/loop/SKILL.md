---
name: loop
description: Run a tl workspace's specs in a loop toward a goal — triage, run the conflict-free batch to in-review, check the goal's key results, and iterate until they're met, the queue is empty, or a safety cap trips. Use when the user wants to run toward a goal, loop until done, keep building, or drive an autonomous cycle. The human gate stays — loop never auto-accepts to done.
---

# /tl loop

The orchestrator that runs the cycle a human runs by hand — triage, run, check progress, repeat — pointed at **one goal** and stopped by explicit conditions. It is **not** a new execution engine: it reuses `/tl triage` to rank, `/tl run` to work the conflict-free batch, and reads the goal's `key_results` from `TRIAGE.yml` to decide whether to keep going.

The loop drives work to `in-review`, never to `done`. `/tl run` already stops at the human gate, and `loop` keeps it there: it either **pauses each cycle for `/tl review`**, or, where auto-review config allows a spec type, continues — but a human still signs off before anything lands in `done`. Calm over swarm: one capped batch per iteration, not a swarm. Propose the plan, then loop; stop and say why the moment a condition trips.

Run this only in a session you trust — each iteration edits the repo through `/tl run`.

## Resolve the workspace

Same as `/tl triage`: the argument is a workspace name under `projects/` or a path; one workspace → use it; else ask. The **first** argument (or a `--goal` flag) names the **goal id** in `TRIAGE.yml` to drive toward — if it's missing or names no goal, stop and list the goals; never invent one. If `_metrics/` doesn't exist, create it.

## 1. Read the goal and its key results

Parse `TRIAGE.yml` (schema: `_templates/SCHEMA.md`). Load the named goal's `description`, `weight`, and `key_results`. Establish the starting line: for each key result, judge **met / unmet** by reading `done/*/SPEC.md` — a key result is met when a completed spec's intent ladders to this goal (`intent → goals`) and its title/criteria map to that key result. This is an LLM judgment, not a string match; state your reasoning per key result. Report `M/N key results met` before the first iteration.

## 2. The loop — one iteration

Repeat until a stop condition (step 3) trips:

- **a. Triage.** Run the `/tl triage` algorithm (`../triage/SKILL.md`) so the backlog reflects current state and newly-unblocked specs flip to `ready`. (Skip on iteration 1 only if `PRIORITIES.md` is fresh.)
- **b. Select toward the goal.** From `ready/`, prefer specs that advance an **unmet** key result of this goal (via triage's goal score) — highest priority first. This is the batch input for run.
- **c. Run.** Invoke `/tl run` (`../run/SKILL.md`) on that selection. It claims the largest **conflict-free** batch (capped ~4), works each within its file scope, and lands each in `in-review` (**never `done`**). Loop adds no parallelism of its own — the conflict rules are run's.
- **d. Handle the review gate.** The batch is now in `in-review`. For each spec, consult the auto-review config (`auto-review-config`, per `depends_on`):
  - **auto-reviewable type** → the loop may continue to the next iteration; a human still accepts to `done` later.
  - **not auto-reviewable** → **pause**: "N specs in `in-review` need your sign-off before I can continue — run `/tl review`." Resume only after the human clears them (or explicitly says continue). Never accept to `done` yourself.
- **e. Re-check progress.** Re-run step 1's key-result judgment against the now-larger `done/` (plus, if auto-review continued, the freshly-accepted specs). Record `M/N` for the log.
- **f. Log the iteration.** Append one line to `_metrics/loop-log.jsonl`:
  `{"goal": "...", "iteration": N, "specs_run": N, "specs_auto_reviewed": N, "specs_awaiting_review": N, "key_results_met": N, "key_results_total": N}`

## 3. Stop conditions — be explicit

Stop and report the reason the moment any of these holds:

- **Done** — all key results met. The goal is satisfied; say so.
- **Queue exhausted** — no `ready` specs advance an unmet key result and none remain to run, but key results are still unmet. Flag it: *"goal `X` is M/N done but no more specs exist — decompose another intent? (`/tl decompose`)"*. The loop never creates work.
- **Stuck** — every remaining spec is `blocked` (unmet `depends_on`) or failed. Report what's blocking and on what.
- **Paused for review** — a non-auto-reviewable batch is in `in-review` (step 2d). Not a terminal stop; it resumes after `/tl review`.
- **Safety cap** — a hard ceiling trips first: `--max-iterations` (default **5**), or no net progress for **2** consecutive iterations (`key_results_met` unchanged and no specs landed), or a `--budget` if given. Stop and hand back to the human; never spin.

## 4. Report — the ledger

The trajectory: starting `M/N` → ending `M/N`, iterations run, specs carried to `in-review` (and which auto-continued vs. awaited review), what's now blocked or exhausted, and which stop condition fired. If paused or capped, name the single next human action (`/tl review`, `/tl decompose`, or raise `--max-iterations`). Nothing happened silently — every iteration is a `loop-log.jsonl` line.

## Guardrails

- **The human gate stays.** `loop` drives work to `in-review` only — it **never** moves a spec to `done`. `/tl review` (or the cockpit's accept button) is the only path to done, even under auto-review config.
- **It orchestrates; it doesn't reimplement.** Ranking is `/tl triage`, execution and all conflict/parallel rules are `/tl run`, sign-off is `/tl review`. `loop` only reads state, sequences the verbs, and checks exit conditions.
- **Never creates specs or intents.** If the queue empties before the goal is met, it flags for `/tl decompose` — decomposition is the human's job (or a future skill).
- **Always bounded.** A safety cap (max iterations, no-progress, or budget) must be able to stop it; a loop that can't stop is a bug. Default cap is 5 iterations.
- **Calm over swarm.** One capped batch per iteration; defer overflow to the next. Announce the plan before looping and the reason on every stop.
- **Append-only logs; one workspace, one goal per run.** Never rewrite `loop-log.jsonl` lines; never drive two goals or two workspaces at once.

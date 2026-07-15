---
name: groom
description: Batch-groom a tl workspace's parked threads — propose a disposition for each (promote, spec, research, merge, close, keep), auto-execute the high-confidence ones, ask only on the ambiguous, and move the rest into the backlog. Use when parked threads have piled up and the user wants to clear or work through loose ends in bulk (steer). The batch counterpart to /tl promote.
---

# /tl groom

The batch counterpart to `/tl promote`. Where `promote` graduates one thread, `groom` works through **all** the parked threads at once — deciding what each should become, clearing the obvious ones automatically, and surfacing only the judgment calls. It turns a pile of parked thoughts into a ranked backlog without a wall of one-by-one questions.

`/tl resume` *nudges* this (its decay inbox flags "parked threads piling up"); `groom` *does* it. It is an **orchestrator** — it reuses `promote`, the research valve, and `reflect`'s parallel-track detection rather than inventing new mechanics.

## Resolve the workspace

Same as `/tl triage`. Read all `threads/` (focus: `status: parked`, plus stale `open`), all specs and intents, and `TRIAGE.yml` goals — you need the goals to route promotes.

## 1. Classify each parked thread

For every parked (and stale-open) thread, decide a **disposition** and a **confidence**:

| Disposition | When | Becomes |
|---|---|---|
| **promote** | a clear outcome | a draft intent (pick the goal it ladders to) |
| **spec** | concrete enough already, fits an existing intent | a `ready` spec (skip the intent ceremony) |
| **research** | uncertain — needs investigation before committing | a `type: research` spec (the research valve) |
| **merge** | duplicate of / subsumed by another thread or a spec | folded into the keeper |
| **close** | stale, superseded, or already delivered | resolved |
| **keep** | genuinely good-not-now | stays parked, with a one-line why |

Judge confidence honestly, and weigh reversibility: `close` / `merge` / `research` / `keep` are low-risk; `promote` / `spec` add committed work.

## 2. Split: auto vs ask

- **Auto-execute the high-confidence dispositions** — any type, but only ones clearly right and reversible.
- **Send to "needs your call"** anything that is: low-confidence, ambiguous between two dispositions, conflicting (two threads want the same intent), or commits significant work toward a non-obvious goal.
- Keep the ask list short — if more than ~5 are ambiguous, lead with the most impactful and group the rest.

## 3. Execute the auto set

Carry out each high-confidence disposition with the existing rules:
- **promote** → write the intent (`/tl promote` rules: `_templates/intent.md`, `status: approved`, `goals` set); flip the thread to `promoted` + `linked_intent`.
- **spec** → scaffold from `_templates/spec/` under the named intent, `status: ready`, `priority` blank.
- **research** → create `specs/research-<slug>/` (the valve); flip the source thread to `promoted`.
- **merge** → append the loser's content to the keeper, set the loser `status: closed` with a pointer.
- **close** → `status: closed`.
- **keep** → no-op.

Every action is a file change — legible and reversible.

## 4. Raise the open decisions

Present the "needs your call" subset compactly: each thread → the two plausible dispositions → your recommendation → one-line why. Take the human's calls, then execute those the same way.

## 5. Hand off the parallel work — don't fan out

Grooming produces new `ready` specs (research especially). Run the parallel-track half of `/tl reflect` (`../reflect/SKILL.md`): report which new specs are **independent** (disjoint files) and safe to dispatch concurrently — research specs are read-only and the most parallelizable, so call those out. **Do not dispatch them.** Dispatching stays the human's deliberate step (cockpit → `/tl run`).

## 6. Report — the ledger

One block: a table of every thread and what happened to it (auto-done vs your-call), the new backlog items grouped by stage, the parallel set, and a closing line — *"run `/tl triage` to rank the new specs."* The ledger is the audit trail: nothing happened silently.

## Guardrails

- Auto-execute only high-confidence, reversible dispositions; when unsure, ask. The ledger must list everything auto-done — never a silent change.
- Never write a goal-less intent (the `promote` rule); if no goal fits, that thread is a "needs your call."
- Don't dispatch or run work — `groom` fills the backlog and flags the parallel set; dispatching is the human's deliberate step.
- Never delete a thread — `close` / `merge` via status + a pointer, so lineage survives.
- Respect `/tl triage`'s ownership: create specs with `priority` blank; triage ranks them.
- Same write discipline as `/tl triage` (see its "Write discipline" section): every frontmatter change is a targeted single-field edit (`lib/frontmatter.js` `setFrontmatterField` / `stampSpecFields` semantics) — never parse-and-re-dump a whole frontmatter block or rewrite a file wholesale. Re-stat before each write: a thread or spec that moved since you read it is skipped and reported, not restored. Never touch an existing spec's `status`, `claimed_by`, `claimed_at`, `awaiting_verifier`, or verifier fields, and never move or edit a claimed spec — grooming creates and closes; it does not sweep the board.
- One workspace per run.

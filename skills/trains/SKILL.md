---
name: trains
description: Run the dispatch queue in parallel — evaluate the pending dispatches for conflicts (read-only research is unlimited-parallel; code specs parallelize only on disjoint file scope), then claim and work the largest conflict-free batch as concurrent subagents, each landing in in-review. Use when the user wants to run the queue in parallel, fan out, clear the dispatch backlog concurrently, or "run the trains".
---

# /tl trains

The parallel counterpart to `/tl run`. Where `run` works one dispatched spec, `trains` works the largest **conflict-free set** at once — one subagent per spec, concurrently — and lands every one in `in-review/`. It drains a queue without N sequential invocations.

`trains` runs work via subagents that edit the repo. Run it only in a session you trust. Every train still stops at the gate: `in-review`, never `done`.

## Resolve the workspace

Same as `/tl run`: argument names a workspace under `projects/` or a path; one workspace → use it; else ask. One workspace per run.

## 1. Read the queue and evaluate conflicts

Read every pending `_dispatch/*.json`. For each, read its spec's `type`, `depends_on`, and **Files to touch**. Partition the pending set into a **conflict-free batch** to run now:

- **Read-only specs** (`type: research`, or no `Files to touch`-that-write) → never conflict; all eligible.
- **Code specs** → eligible only if their `Files to touch` are **disjoint** from every spec already in the batch, *and* every `depends_on` is already in `done/`. Two specs that touch the same file **conflict** — at most one runs this round.
- **Undeclared scope** (a code spec with no `Files to touch`) → cannot be proven disjoint, so treat it as conflicting with all other code specs. This is a missing-scope smell — name it in the report (the fix is to declare the scope, or batch these into one spec via `/tl groom`).

**Report the evaluation before running:** the batch (what goes parallel) and the held-back (what conflicts or is blocked, and why).

## 2. Cap the width

Default cap **~4 concurrent** — calm over swarm. If the conflict-free set is larger, run the top-priority N now and leave the rest for the next `trains` run. Say what you deferred and why.

## 3. Claim the whole batch first

For every spec in the batch: set its dispatch `status: claimed` (`claimed_by`, `claimed_at`) and move the spec `ready → in-progress`. Do this for **all** before spawning any agent, so two runs can't double-claim.

## 4. Run them in parallel

Spawn one subagent per batched spec, **concurrently** (a single set of Task calls). Each subagent runs the `/tl run` procedure for *its* spec only (`../run/SKILL.md`): assemble the brief fresh, work within `Files to touch`, pass the tests gate, capture threads, write `FEEDBACK.md`, and land the spec in **`in-review/`**. Code agents touching disjoint files may use worktree isolation to avoid stepping on each other. A subagent **never** moves its spec to `done`.

## 5. Collect and close

As each returns, confirm it reached `in-review` (or failed). Set each dispatch `status: done` (worker complete) or `failed`. A failure doesn't sink the batch — the others still land.

## 6. Report — the ledger

A table: each spec → parallel or held → final state (in-review / failed) → threads captured. Then: what now waits in `in-review/` for `/tl review`, and what's still queued for the next `trains` run.

## Guardrails

- Every train lands in `in-review` — **never `done`**. The human gate (`/tl review`) is the only path to done; `trains` never signs off its own work. This is exactly what makes fan-out safe.
- Batch only provably-conflict-free specs. Never run two agents at the same file — same-file specs serialize across runs (or get batched into one spec via `/tl groom`). When scope is undeclared, assume conflict.
- Cap the width — calm over swarm. Defer the overflow and say so.
- Don't dispatch (that's the cockpit); `trains` consumes pending dispatches, like `run`.
- One workspace per run; never claim across workspaces.

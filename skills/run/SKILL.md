---
name: run
description: Work the ready queue — claim the largest conflict-free batch of ready specs and carry each to in-review. Read-only research runs unlimited-parallel; code specs parallelize only on disjoint file scope; a single safe spec runs inline. Use when asked to run, work, pick up, claim, or drain ready/queued work, or to run the queue in parallel.
---

# /tl run

The runner. The **`ready/` stage is the queue** — `/tl run` drains it, in this session, under your control, and carries each spec to **`in-review`** (never `done`; the human gate is `/tl review` or the cockpit's accept button).

It works **as many ready specs as are safe to run together**: one when that's all that's conflict-free, many in parallel when they don't collide. "Run the next one" and "fan out the queue" are the same verb — the conflict evaluation decides the width.

This runs work and edits the repo — directly for a single spec, via concurrent subagents when fanning out. Run it only in a session you trust.

## Resolve the workspace

Same as `/tl triage`: the argument is a workspace name under `projects/` or a path; one workspace → use it; else ask. One workspace per run; never claim across workspaces.

## 1. Select the batch

The **`ready/` stage is the queue** — every spec there is authorized and priority-ranked. If the argument names a spec, that's the batch (just it). Otherwise read the ready specs and evaluate conflicts to find the largest set safe to run **together**:

- **Read-only specs** (`type: research`, or no writing `Files to touch`) → never conflict; all eligible.
- **Code specs** → eligible only if their `Files to touch` are **disjoint** from every spec already in the batch *and* every `depends_on` is in `done/`. Same-file specs conflict — at most one this round.
- **Undeclared scope** (a code spec with no `Files to touch`) → can't be proven disjoint, so it conflicts with all other code specs. A missing-scope smell — name it (fix: declare the scope, or batch these into one spec via `/tl groom`).

**Agent routing (heterogeneous fan-out).** A spec may carry an optional `agent:` lane (`any | claude | codex | cursor | gemini`, default `any`). When you're running as a specific agent (`tl run --agent <name>`), consider only specs whose `agent` is `<name>` or `any` — specs in another agent's lane are held for that agent. Because the claim is a folder move (`specs/ → in-progress/`), Claude, Codex, and Cursor can each drain their own lane **concurrently** over one throughline with no central orchestrator — whoever moves the folder first owns the spec. The file-conflict rules above still apply within and across lanes: never two units at the same file.

Among eligible specs prefer higher priority (p0 > p3); break ties by oldest. **Cap the batch at ~4** — calm over swarm; defer the rest to the next run and say so. If nothing is ready, say so and stop. (To hold a ranked spec back from runs, it belongs in `triage/`, not `ready/` — the folder is the gate.)

Report the batch — and what was held back and why — before working.

## 2. Claim the whole batch first

Move every spec in the batch `ready → in-progress` (set `status: in-progress`) before any work begins. The folder move is the claim — two runs can't pick up the same spec because it's no longer in `ready/`.

## 3. Work each spec — the per-spec procedure

Apply this to every spec in the batch. With **one** spec, do it inline in this session. With **several**, spawn one subagent per spec, **concurrently**, each running this same procedure for *its* spec only (disjoint-file code agents may use worktree isolation). Never let two units touch the same file.

For a spec:
- **a. Assemble the brief — fresh.** Read it now: the spec's Objective, Acceptance criteria, Scope (`Files to touch` / `Do not touch`), and any **`NOTES.md`** (human feedback left in the cockpit — treat it as binding as the criteria); the parent intent's Outcome; the goal it ladders to.
- **b. Do the work** in the spec's `repo`, within `Files to touch`; treat `Do not touch` as a hard boundary. An out-of-scope discovery → capture a thread (c); if it blocks you, fail *this* spec (g) — don't sink the batch.
- **c. Capture threads** for anything worth not losing — decision, follow-up, risk, discovery (`../capture/SKILL.md`). Undocumented discoveries are a leak.
- **d. The tests gate.** Move the spec `in-progress → tests` (`status: tests`), run the acceptance-criteria tests / verification, **and run the review gates** (`_patterns/review-gates.md` — the security + code-standard checklist). Until a cross-model verifier exists (`alt-model-alignment-check`), self-check against the gates here. Anything red — a failed test or a gate concern — fails this spec (g): leave it in `tests/` as `status: blocked` with what broke.
- **e. Hand to review.** On green: write `outcome/FEEDBACK.md` (template: `../../_templates/FEEDBACK.md`), move the spec `tests → in-review` (`status: in-review`). **Never move it to `done/`** — an agent doesn't sign off its own work; the human accepts it (`/tl review`, or the cockpit's accept button).
- **g. On failure** — leave the spec where it stopped (`status: blocked` if genuinely blocked); explain what stopped you and what would unblock it.

## 4. Report — the ledger

Per spec: solo or parallel, final state (in-review / failed), threads captured. Then: what now waits in `in-review/` for `/tl review`, and what's still queued for the next run.

## Guardrails

- Every spec lands in `in-review` — **never `done`**. `/tl review` (or the cockpit's accept button) is the only path to done; the gate is what makes parallel fan-out safe.
- Run only provably-conflict-free specs together; never two units at the same file (same-file specs serialize across runs, or get batched into one spec via `/tl groom`). Undeclared scope → assume conflict.
- Cap the width — calm over swarm. Defer the overflow and say so.
- `run` consumes the `ready/` queue; it never authorizes work. A spec you're not ready to run belongs in `triage/`, not `ready/`.
- A completed spec must have `outcome/FEEDBACK.md` before it moves to `in-review/`.
- Read a spec's `NOTES.md` if present — cockpit feedback left mid-flight — and honor it like the acceptance criteria.

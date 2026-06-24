---
name: run
description: Claim a dispatched spec from the cockpit's queue and work it end to end — move it ready → in-progress → done, follow its acceptance criteria, and capture threads. Use when asked to run, work, pick up, or claim dispatched/queued work, or to run the dispatch queue.
---

# /tl run

The consumer side of dispatch. The cockpit (`POST /api/dispatch`) only ever *writes* a queue file; `/tl run` is what actually does the work — in this session, under your control. It claims one pending dispatch, works the spec it points at, and closes the loop the cockpit started.

This skill runs work. It edits the target repo. Run it only in a session whose permissions you trust.

## Resolve the workspace

Same as `/tl triage`: the argument is a workspace name under `projects/` or a path; with exactly one workspace, use it; otherwise ask. Everything below is relative to that workspace root. Never claim across workspaces in one invocation.

## Steps

**1. Read the queue.** Parse every `_dispatch/*.json` (contract: `_templates/SCHEMA.md`). Consider only `status: pending`. If none are pending, say so and stop — nothing to do.

**2. Pick one.** Among pending dispatches, claim the one whose spec has the highest priority (p0 > p1 > p2 > p3); break ties by oldest `created`. One spec per invocation — never fan out.

**3. Claim it — before doing any work.** In the dispatch file set `status: "claimed"`, `claimed_by` (e.g. `"claude (tl run)"`), and `claimed_at` (ISO timestamp); write it back immediately. This is what stops a second `/tl run` from double-claiming. Transition the file — never delete it.

**4. Move the spec to in-progress.** `git mv` (or move) the spec folder from `specs/<slug>/` to `in-progress/<slug>/`, and set its frontmatter `status: in-progress`. The folder is the source of truth; the cockpit's IN FOCUS lights up on its own from this move.

**5. Assemble the brief — fresh.** Don't trust a stale prompt; read the current files now:
- the spec's **Objective**, **Acceptance criteria**, and **Scope** (`Files to touch` / `Do not touch`)
- the parent **intent**'s Outcome (from the dispatch's `intent`)
- the **goal** it ladders to (the dispatch's `goal`) — so the work serves the why, not just the letter

**6. Do the work.** Implement against the acceptance criteria, in the repo named by the spec's `repo`. Stay within `Files to touch`; treat `Do not touch` as a hard boundary. If you discover you must go outside that scope, stop and surface it rather than silently expanding — note it as a thread (step 7) or, if it blocks you, fail the dispatch (step 9).

**7. Capture threads.** For anything worth not losing that surfaces mid-work — a decision, a follow-up, a risk, an out-of-scope discovery — write a thread via the `/tl capture` rules (`../capture/SKILL.md`). Undocumented discoveries are a leak.

**8. The tests gate.** When the work is written, move the spec `in-progress/<slug>/` → `tests/<slug>/` (`status: tests`) and run the spec's acceptance-criteria tests / verification. If they fail, that's a failure (step 10): leave it in `tests/` as `status: blocked` with what broke.

**9. Hand to review — success.** When the criteria are met *and* tests pass:
- Write `outcome/FEEDBACK.md` (template: `../../_templates/FEEDBACK.md`) — what shipped, what went well, what to watch, and a "Captured threads" list.
- Move the spec `tests/<slug>/` → `in-review/<slug>/` and set `status: in-review`. **Do not move it to `done/`** — an agent never signs off its own work; `done` is a human's call (`/tl review`).
- In the dispatch file set `status: "done"` and stamp `finished_at` — the worker's job is complete; the spec now waits for sign-off.

**10. Finish — failure or blocked.** If the work can't complete (blocked, out-of-scope, criteria unmet, tests red):
- Set the dispatch `status: "failed"` and stamp `finished_at`.
- Leave the spec where it stopped (`in-progress/` or `tests/`), set `status: blocked` if genuinely blocked — don't silently revert it to `specs/`.
- Explain plainly what stopped you and what would unblock it.

**11. Report.** One block: which spec you claimed, what you did, the threads you captured, and the final state (in-review / failed) — plus what's next in the queue, if anything.

## Guardrails

- One spec per invocation. Fan-out across parallel tracks is a separate, later capability — don't build it in here.
- Never delete a dispatch file. Status transitions only, so the queue stays an auditable, git-tracked record.
- Never dispatch (that's the cockpit / `POST /api/dispatch`); `/tl run` only consumes.
- Honor the spec's `Do not touch` absolutely. When in doubt about scope, capture a thread or fail the dispatch — never quietly broaden it.
- Never claim across workspaces in one run.
- A completed spec must have `outcome/FEEDBACK.md` before it moves to `in-review/`.
- **Never move a spec to `done/`** — an agent stops at `in-review/`; `done` is the human's sign-off (`/tl review`). This gate is what makes parallel fan-out safe.

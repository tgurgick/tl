---
name: review
description: Sign off the work waiting in a tl workspace's in-review stage — show what each spec changed against its acceptance criteria, then accept it to done or kick it back to in-progress with notes. Use when the user wants to review, sign off, accept, or approve finished work, or clear the review queue. The human gate /tl run stops short of.
---

# /tl review

The human gate. `/tl run` carries work to `in-review/` but never to `done/` — an agent doesn't sign off its own work. `/tl review` is where a person (or `/code-review`) makes the call: accept to `done`, or kick back to `in-progress`. This gate is what makes parallel fan-out safe — many agents pool their output in `in-review/`, and you clear it in a batch.

## Resolve the workspace

Same as `/tl triage`. Read the `in-review/` stage; if it's empty, say so and stop — nothing to sign off.

## Steps

**1. List the sign-off queue.** Every spec in `in-review/`, oldest first. Report the count up front — this is a batch.

**2. For each (or one named) spec, assemble the evidence:**
- the spec's **Acceptance criteria** — the contract to check against
- `outcome/FEEDBACK.md` — what the worker says it did, and what to watch
- the actual change — the diff in the spec's `repo` (git diff), so claims are checked against reality, not taken on faith
- if the work is code and the stakes warrant it, run `/code-review` on the diff and fold its findings in

**3. Make the call** — present each spec with a recommendation, and let the human choose:
- **Accept** → move `in-review/<slug>/` → `done/<slug>/`, set `status: done`. The throughline is complete.
- **Kick back** → move `in-review/<slug>/` → `in-progress/<slug>/`, set `status: in-progress`, and **capture a thread** (`../capture/SKILL.md`) with the specific reason and what "done" needs — so the next `/tl run` (or the same agent) has the correction in hand. Never kick back without a written reason.

**4. Report — the ledger.** What you accepted, what you kicked back (with the reason), and what's left in the queue.

## Guardrails

- Read-only until the human decides. `review` surfaces evidence and recommends; accepting or kicking back is the human's explicit call.
- Check the diff, not just the FEEDBACK — a worker's self-report is a claim to verify, not a fact.
- Accept moves to `done/` only — never edits the code itself. If a fix is needed, kick it back; don't patch it inside review.
- A kick-back must carry a reason (a thread); silent rejection loses the why.
- One workspace per run.

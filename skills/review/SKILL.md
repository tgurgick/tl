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

**2. For each (or one named) spec, assemble the evidence — verification status leads:**
- **Verification first.** From `outcome/ALIGNMENT.md` (`verification_type` + builder/verifier) say up front which of these this spec is: **Independent check** (built by X, verified by Y — corroborated), **Self-check only** (builder verified itself — flag it prominently; *you* are the second set of eyes, read the diff hardest here), or **No ALIGNMENT** (pre-gate spec, grandfathered — same treatment as self-check). Never present the three as visually equal.
- the spec's **Acceptance criteria** — the contract to check against
- `outcome/FEEDBACK.md` — what the worker says it did, and what to watch
- the actual change — the diff in the spec's `repo` (git diff), so claims are checked against reality, not taken on faith
- the **review gates** (`_patterns/review-gates.md`) — the same security + code-standard checklist the tests gate ran; confirm they hold
- `outcome/ALIGNMENT.md` if present — the cross-model verifier's verdict. **Surface it:** who verified (must differ from the builder), how many rounds, and the verdict. If `verdict: residual-concerns`, lead with the `residual_concerns` — those are the items the bounded loop couldn't resolve, handed to you on purpose; weigh them before accepting. A clean `pass` means a different model already vetted the diff against the criteria and gates — corroborating evidence, not a substitute for your call
- if the work is code and the stakes warrant it, run `/code-review` on the diff and fold its findings in

**3. Make the call** — present each spec with a recommendation, and let the human choose:
- **Accept** → move `in-review/<slug>/` → `done/<slug>/`, set `status: done`. The throughline is complete.
- **Kick back** → move `in-review/<slug>/` → `in-progress/<slug>/`, set `status: in-progress`, append the reason to the spec's **`NOTES.md`** (`## YYYY-MM-DD — kicked back`), **write a continuation dispatch** `_dispatch/<slug>.json` (`mode: "continuation"`, `stage: "in-progress"`, `notes_path: "<slug>/NOTES.md"`, `status: "pending"` — contract in `_templates/SCHEMA.md`; re-writing an existing pending file is fine), and **capture a thread** (`../capture/SKILL.md`) with the same reason — so the next `/tl resume` or `/tl run` picks it up programmatically, no human context re-assembly. Never kick back without a written reason on the spec itself.

**3b. Leave the audit trail** — every decision, both directions, same contract as the cockpit (`_templates/SCHEMA.md`, "Reviewer provenance"):
- **Stamp the spec's frontmatter.** Accept: `accepted_by: "human-cli"`, `accepted_at: "<full ISO timestamp>"`. Kick back: `kicked_back_by: "human-cli"`, `kicked_back_at: "<full ISO timestamp>"`. Either way also stamp `gate:` with the verification status you assembled in step 2 — `"verified"` when `canAdvanceToReview` (`lib/verification-gate.js`) passes for the spec as it sits on disk, `"unverified"` when it fails (e.g. no `outcome/ALIGNMENT.md` under `require_independent_verifier`).
- **Append one row to `_metrics/review-log.jsonl`** — same shape the cockpit writes, `via: "cli"`: `{"date": "<full ISO timestamp>", "spec": "in-review/<slug>/", "action": "accepted" | "kicked-back", "via": "cli", "gate": "verified" | "unverified"}`. Append-only: never edit or reorder existing lines.
- `gate: "unverified"` is a **visible flag, not a block** — the human's accept still stands (their call outranks the gate); the row and stamp just make the gap readable off the artifact later. Historical `done/` specs without stamps remain valid — never retro-stamp them.

**4. Report — the ledger.** What you accepted, what you kicked back (with the reason), and what's left in the queue.

## Guardrails

- Read-only until the human decides. `review` surfaces evidence and recommends; accepting or kicking back is the human's explicit call.
- Check the diff, not just the FEEDBACK — a worker's self-report is a claim to verify, not a fact.
- Accept moves to `done/` only — never edits the code itself. If a fix is needed, kick it back; don't patch it inside review.
- A kick-back must carry a reason (a thread); silent rejection loses the why.
- One workspace per run.

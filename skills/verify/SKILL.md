---
name: verify
description: Independently verify specs waiting at the TESTS gate — a non-builder agent reviews the diff against the acceptance criteria and review gates, remediates with the builder (bounded), writes the ALIGNMENT record, and advances the spec to in-review. Use when asked to verify, cross-check, or second-eye completed work, or when tl run stopped a spec at tests/ awaiting an independent verifier.
---

# /tl verify

The independent half of the cross-model loop. `/tl run` builds; `/tl verify` is a **different agent** checking that work before the human sees it. A builder never verifies its own spec — that is the whole point (`done/allocation-actionable-prompt` is the incident that made this a gate instead of a convention).

## Resolve the workspace

Same as `/tl triage`. `tl verify [workspace] [spec] [--agent <name>]` prints this procedure plus the queue: every spec in `tests/` (or `in-progress/`) with `awaiting_verifier: true`, excluding specs built by `--agent`'s own lane.

## The verifier rule

You may verify a spec only if you are **not** its builder: your identity ≠ the spec's `claimed_by` (falling back to its `agent:` lane when unstamped). If everything awaiting verification is your own work, say so and stop — another agent (or the human at `/tl review`) must take it. Never downgrade to self-check silently; self-check is valid only when the workspace's `TRIAGE.yml` `verification.allow_self_check_for` lists the spec's `type`.

## Procedure — per spec

1. **Assemble the evidence fresh:** the spec's Objective, Acceptance criteria, Scope; its `VERIFY.md` request (who built it, what they flagged); the builder's `outcome/FEEDBACK.md` (a claim, not a fact); `outcome/BUILDER.diff` when present (the frozen pre-verification tree — prefer it over a live `git diff` that may already include your edits); the actual **diff** in the spec's `repo`; the parent intent's Outcome; `_patterns/review-gates.md`.
2. **Verify.** Run the review gates against the diff. Each acceptance criterion: actually satisfied, checked against behavior (run the tests / the app), not "looks done." Verdict: **pass** or **concerns-with-specifics** (file, line, why).
3. **Remediate — bounded.** On concerns, hand the specifics back to the builder (its lane's continuation path, or fix-forward yourself only if trivial and in scope), then re-verify. Cap at ~2 rounds.
4. **Record.** Capture authorship of any fix-forward before closing the record: write `outcome/REMEDIATION.diff` as the delta **since** `outcome/BUILDER.diff` (empty file when the tree still matches that snapshot — you changed nothing). Derive `remediation_files` (paths touched by that delta; `[]` when empty) and `remediation_lines` (added + removed line count from the delta; `0` when empty). Write or extend `outcome/ALIGNMENT.md` (schema: `../../_templates/SCHEMA.md`): `builder`, `verifier` (you), `verification_type: independent`, `rounds`, `verdict` (`pass` | `residual-concerns`), `residual_concerns`, `remediation_files`, `remediation_lines`, one section per round. Then stamp the spec's frontmatter via targeted single-field edits (`lib/frontmatter.js` `setFrontmatterField`): `verified_by: <you>`, `verification_type: independent`, `awaiting_verifier: false` — the cockpit badge reads these.
5. **Advance.** On `pass` or `residual-concerns`, **finish every write while the spec is still in `tests/`** — the folder move is the last step, because `in-review/` is a live human-visible gate and a cockpit accept can fire the instant the spec lands there (incident: `threads/2026-07-12-ui-accept-races-agent-handoff.md`). **Order is strict:**
   1. **Finalize `outcome/ALIGNMENT.md`** from step 4.
   2. **Update `outcome/FEEDBACK.md`** if present — set its `spec:` path to the **destination** (`in-review/<slug>/SPEC.md`), not the current `tests/` path.
   3. **Stamp frontmatter** on `SPEC.md` via `setFrontmatterField`: `status: in-review`, plus the verifier stamps from step 4.
   4. **Move the folder last:** `tests/<slug>/ → in-review/<slug>/`. **Nothing is edited after this move** — no frontmatter, no `FEEDBACK.md`, no `ALIGNMENT.md`.
   Residual concerns are the human's to weigh at `/tl review` — never silently dropped. If the verdict is a hard fail, leave it in `tests/` (`status: blocked`) with the specifics in ALIGNMENT and a `NOTES.md` line; the builder's continuation path picks it up.

## Guardrails

- Verifier ≠ builder, always. No availability exception here — unavailability is the *builder's* stop condition (`/tl run` leaves the spec awaiting), not a license to self-verify.
- Check the diff, not the FEEDBACK. The builder's self-report is the thing under test.
- Bounded remediation (~2 rounds); converged-or-capped, then advance with the record honest.
- `in-review` is the ceiling — the human gate is untouched. `verify` never moves anything to `done/`.
- Every verification leaves `outcome/ALIGNMENT.md` (including `remediation_files` / `remediation_lines`), `outcome/REMEDIATION.diff` (empty when no fix-forward), and the frontmatter stamps finalized **before** the folder move — stamps + outcome writes first, folder move last, nothing edited after the move. An unverifiable verification is no verification.

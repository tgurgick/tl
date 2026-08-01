---
name: verify
description: Independently verify specs waiting at the TESTS gate — a non-builder agent leases the spec, reviews the diff against the acceptance criteria and review gates read-only, records the ALIGNMENT record and an immutable result, and advances a clean pass to in-review; any desired change is a proposal for a human, never an edit. Use when asked to verify, cross-check, or second-eye completed work, or when tl run stopped a spec at tests/ awaiting an independent verifier.
---

# /tl verify

The independent half of the cross-model loop. `/tl run` builds; `/tl verify` is a **different agent** checking that work before the human sees it. A builder never verifies its own spec — that is the whole point (`done/allocation-actionable-prompt` is the incident that made this a gate instead of a convention). And the verifier is **read-only**: a requested mutation is a review finding, not permission to edit (`done/isolated-verifier-runner`).

Prefer **one scheduled** verify drain (`automation.verify: true` → `tl-worker --mode verify`) as the primary path after `tl up`. Interactive `/tl verify` / `tl verify --execute` are **supported recovery launchers** with the **same** lease, read-only, and ALIGNMENT contract — not a second product. Cockpit verify-request files are routing hints only. Canonical story: `docs/canonical-e2e-path.md`.

## Resolve the workspace

Same as `/tl triage`. `tl verify [workspace] [spec] [--agent <name>]` prints this procedure plus the queue, excluding specs built by `--agent`'s own lane.

## The queue — what is verifiable

- **Canonical:** a spec folder in `tests/` with a **valid handoff manifest** (`outcome/HANDOFF.json`, `lib/handoff.js` `validateHandoff`). The manifest is the builder's completion proof — it content-binds `SPEC.md`, `outcome/FEEDBACK.md`, `outcome/BUILDER.diff` to digests.
- **Legacy (migration):** `awaiting_verifier: true` without a manifest remains eligible — pre-manifest handoffs are grandfathered, never retro-stamped.
- **Not verifiable:** an **invalid** manifest (digest mismatch, tampered artifacts) or an interrupted write (`HANDOFF.json.tmp` orphan) is a refusal — surface it as a finding, don't verify around it. A spec already `human-decision-required` waits for the human, not another round.

`lib/verifier-worker.js` `verifierQueue` / `selectVerifierWork` compute exactly this.

## The verifier rule

You may verify a spec only if you are **not** its builder: your identity ≠ the spec's `claimed_by` (falling back to its `agent:` lane when unstamped). If everything awaiting verification is your own work, say so and stop — another agent (or the human at `/tl review`) must take it. Never downgrade to self-check silently; self-check is valid only when the workspace's `TRIAGE.yml` `verification.allow_self_check_for` lists the spec's `type`. The lease layer enforces this too — `acquireVerifierLease` refuses `builder-exclusion` — but the refusal is a backstop, not the procedure.

## The lease — one verifier per spec

Before touching a spec, take its exclusive expiring lease at `_metrics/verify-locks/<slug>.lock` (`lib/verifier-worker.js` `acquireVerifierLease` — the same file the scheduled verify tick locks, so interactive and headless never double-check one spec):

- **Held by someone else** → skip it; that spec has a verifier. Pick the next eligible spec instead — distinct specs verify in parallel, capped by `verification.verifier_concurrency` (default **2** — calm over swarm).
- **Stale** (older than its TTL, default 60m) → takeover is legitimate; the result records `taken_over_from`.
- **Long verification** → heartbeat (`heartbeatVerifierLease`) between phases so the lease doesn't expire under you. A lost lease means someone took over — stop, don't record.
- **Always release** (`releaseVerifierLease`) after recording, whatever the verdict.

## Procedure — per spec

1. **Assemble the evidence fresh:** the spec's Objective, Acceptance criteria, Scope; its `VERIFY.md` request (who built it, what they flagged); the builder's `outcome/FEEDBACK.md` (a claim, not a fact); `outcome/BUILDER.diff` (the frozen pre-verification tree — prefer it over a live `git diff`); the manifest verdict (`validateHandoff` — a canonical spec whose digests no longer match is a finding, stop); the actual **diff** in the spec's `repo`; the parent intent's Outcome; `_patterns/review-gates.md`.
2. **Verify — read-only.** Run the review gates against the diff. Each acceptance criterion: actually satisfied, checked against behavior (run the tests / the app), not "looks done." You may run checks and read anything; you edit **nothing** — not source, not the builder's outcome artifacts, not lifecycle state beyond your own stamps below. Verdict: **pass** or **concerns-with-specifics** (file, line, why).
3. **Concerns become proposals, never edits.** There is no fix-forward, trivial or otherwise. Every change you want — a null guard, a rename, a one-character typo — is recorded as a proposed mutation (file, reason) with the verdict `human-decision-required`. The spec stays in `tests/` (`status: blocked`), the proposals land in `outcome/ALIGNMENT.md` (`verdict: "human-decision-required"`, each proposal under `residual_concerns`) **and** a `NOTES.md` section stating no mutation was applied and the two continuations open to the human. `recordVerificationOutcome` writes exactly this shape.
4. **Record.** Every verification — pass, concerns, or proposal — leaves:
   - `outcome/ALIGNMENT.md` (schema: `../../_templates/SCHEMA.md`): `builder`, `verifier` (you), `verification_type: independent`, `rounds`, `verdict` (`pass` | `residual-concerns` | `human-decision-required`), `residual_concerns`, `remediation_files: []`, `remediation_lines: 0`.
   - `outcome/REMEDIATION.diff` — **always empty** under the read-only contract: it is the parity proof that the tree still matches `BUILDER.diff`. A non-empty REMEDIATION.diff is itself a finding now, not a practice.
   - One appended row in `outcome/VERIFICATIONS.jsonl` (`appendVerifierResult`) — the immutable result log; rows are never rewritten, later rounds append.
   - Frontmatter stamps via targeted single-field edits (`lib/frontmatter.js` `setFrontmatterField`): `verified_by: <you>`, `verification_type: independent`, `awaiting_verifier: false` — the cockpit badge reads these.
5. **Advance — pass only.** On `pass`, **finish every write while the spec is still in `tests/`** — the folder move is the last step, because `in-review/` is a live human-visible gate and a cockpit accept can fire the instant the spec lands there (incident: `threads/2026-07-12-ui-accept-races-agent-handoff.md`). **Order is strict:**
   1. **Finalize `outcome/ALIGNMENT.md`** from step 4.
   2. **Update `outcome/FEEDBACK.md`** if present — set its `spec:` path to the **destination** (`in-review/<slug>/SPEC.md`), not the current `tests/` path. (Legacy specs only — a manifest-bound FEEDBACK must not be rewritten; its digests are the handoff. Leave it and let the manifest stay valid.)
   3. **Stamp frontmatter** on `SPEC.md`: `status: in-review`, plus the verifier stamps from step 4.
   4. **Move the folder last, through the guarded edge:** `tests/<slug>/ → in-review/<slug>/` via the stage CAS (`lib/stage.js` `moveSpec`, role `verifier` — the role's only edge; a refusal means the board moved, stop and report). **Nothing is edited after this move.**
   Then release the lease. If the verdict is `residual-concerns`, same order — the open items are the human's to weigh at `/tl review`, never silently dropped. If the verdict is a hard fail or `human-decision-required`, leave it in `tests/` (`status: blocked`) with the specifics in ALIGNMENT and NOTES; release the lease and stop.

## The human decision

Your proposals are inputs to an explicit human choice (`tl verify` decision path / cockpit — `applyVerifyHumanDecision`): **authorize fix-forward** (a **separate agent** continuation implements it) or **kick back** to the builder. Neither path applies your patch silently, and you never pre-implement "so it's ready." Mutation proposals always require human authorization; the verifier never edits source.

## Guardrails

- Verifier ≠ builder, always. No availability exception here — unavailability is the *builder's* stop condition (`/tl run` leaves the spec awaiting), not a license to self-verify.
- Check the diff, not the FEEDBACK. The builder's self-report is the thing under test.
- Read-only, always: interactive and headless verification carry the same contract — no source changes, no builder-artifact edits; wanted mutations are `human-decision-required` proposals in ALIGNMENT + NOTES.
- One verifier per spec (the lease); distinct specs in parallel up to the calm cap; heartbeat long runs; release when done.
- `in-review` is the ceiling — the human gate is untouched. `verify` never moves anything to `done/`, and the guarded verifier edge structurally cannot.
- Every verification leaves `outcome/ALIGNMENT.md`, an empty `outcome/REMEDIATION.diff`, one immutable `outcome/VERIFICATIONS.jsonl` row, and the frontmatter stamps finalized **before** the folder move — stamps + outcome writes first, guarded folder move last, nothing edited after the move. An unverifiable verification is no verification.

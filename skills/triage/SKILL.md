---
name: triage
description: Rank a tl workspace's backlog — score specs against the goals, allocation targets, and rules in its TRIAGE.yml, detect human priority overrides, and rewrite PRIORITIES.md via targeted priority-field edits — never whole-frontmatter rewrites, never stage folders or claim fields, and re-stat before every write (a spec that moved since inventory is skipped, not restored). Use when asked to triage, prioritize, rank, or re-sort a project's backlog (run), or on a scheduled daily tick.
---

# /tl triage

Prioritizes one workspace. Reads files, reasons, writes files. Needs no network.

## Resolve the workspace

The argument is a workspace name (a folder under `projects/`) or a path. If no argument: when `projects/` contains exactly one workspace, use it; otherwise list the workspaces and ask which one. Everything below is relative to that workspace root. If `_metrics/` doesn't exist there, create it.

## Steps

**0. Acquire the advisory writer lock.** Run `node bin/tl.js triage-lock acquire <workspace> --lane <agent>` before inventorying. If it exits with `triage already running (age Nm)`, stop without writing — the current pass owns the board. A stale lock (mtime older than 15 minutes) is taken over and reported. Touch the lease with `node bin/tl.js triage-lock touch <workspace>` immediately before steps 4b, 5, 7, and 8; release it with `node bin/tl.js triage-lock release <workspace>` after step 8, including when exiting early after acquisition. This is advisory coordination; the write-discipline guards below remain mandatory.

**1. Read config.** Parse `TRIAGE.yml` (schema: `_templates/SCHEMA.md`). If it's missing or has no goals, stop and tell the user — never invent goals.

**2. Inventory.** Parse frontmatter from every `triage/*/SPEC.md`, `specs/*/SPEC.md`, and `in-progress/*/SPEC.md`. Tolerate missing optional fields; report (don't crash on) malformed frontmatter. If a spec's `status` disagrees with its folder, fix the field to match the folder **it is in at the moment of the write** — re-stat the path first, and derive the status from that current folder, never from this inventory snapshot (`triage/` → `status: triage`, `specs/` → `status: ready` or `blocked`, `in-progress/` → `status: in-progress`). A spec that moved between inventory and write is someone's live work: skip it and report it; never write it back at its old path and never "restore" the snapshot's status or stage.

`triage/` is the shaping hold pen: specs there wait on a human action before they may run. Do not include them in `/tl run`'s ready queue. A shaped spec becomes runnable when a human releases it — move `triage/<slug>/ → specs/<slug>/`, set `status: ready`, and **remove `hold_reason`** from frontmatter (the cockpit release button performs the move; clear `hold_reason` on any manual release too). Specs that `/tl triage` *can* authorize stay in `specs/` — triage never adds an extra approval gate for runnable work.

**3. Detect human overrides.** Read the last line of `_metrics/triage-log.jsonl` (if any) and its `priorities` map. For each spec whose current `priority` differs from that map while `priority_set_by` is still `triage`, a human changed it by hand:
- Set `priority_set_by: human` in the spec's frontmatter.
- Append to `_metrics/override-log.jsonl`:
  `{"date": "...", "spec": "specs/..." | "triage/...", "from": "p2", "to": "p1"}`

This log is the training signal for future auto-triage tuning. Never skip this step.

**4. Apply rules.** From `TRIAGE.yml` `rules`, first match wins per spec. Standard actions: `set priority pN`, `boost priority by 1 level`, `flag for review`. Rules (and only rules) may change a `priority_set_by: human` spec — when one does, note it in the summary. Mark a rule-set priority as `priority_set_by: triage`.

Also: any released spec in `specs/` whose `depends_on` entries are all in `done/` gets `status: ready`. Any held spec in `triage/` stays `status: triage` even when its dependencies are satisfied; note it as "ready to release" rather than moving it into the run queue.

**4b. Route unauthorized specs to `triage/` (the sole writer).** After rules, for each spec under `specs/` evaluate whether it is authorized to run. Re-stat first: the spec must still be in `specs/` at the moment of the move, and must have no `claimed_by` — a claimed or moved spec is live work, never routed (skip and report). If unauthorized, move `specs/<slug>/ → triage/<slug>/`, set `status: triage`, and write `hold_reason: "<short literal>"` — one reason per spec, first match wins:

| Condition | `hold_reason` literal |
|-----------|----------------------|
| A `flag for review` rule matched this run | the rule's `reason` (or `"flagged for review"` if empty) |
| Code spec with undeclared scope — has a `### Files to touch` section but no parseable file bullets, or `type` is `feature`/`bug`/`tech_debt` with no declared write scope | `"undeclared Files to touch"` |
| Unmet research dependency — any `depends_on` entry points at a spec with `type: research` not yet in `done/` | `"waiting on research: <slug>"` (the blocking dependency slug) |
| Failed asset preflight — same checks as `/tl run` claim preflight (`lib/batch.js` `repoHoldReason`): missing/unusable `repo:`, tl-checkout containment, etc. | the preflight literal (`repo not found: …`, `no project repo — refusing to work in the tl checkout`, …) |

Do **not** move authorizable specs to `triage/` — scoring and priority assignment proceed in place. Do **not** auto-release specs from `triage/` when the reason clears; note "ready to release" in the summary and `PRIORITIES.md` instead. When re-routing a spec already in `triage/`, update `hold_reason` if the reason changed; leave legacy items without `hold_reason` alone (the cockpit renders a generic chip). Releasing always clears `hold_reason` on the move back to `specs/`.

**5. Score.** For each spec not covered by a rule and not `priority_set_by: human`:
- For each goal: does this spec advance a key result, or is it a prerequisite to one that does? Judge 0–1, multiply by the goal's weight, sum across goals.
- Top quartile of scores → p1, middle half → p2, bottom quartile → p3.
- Write `priority` and `priority_set_by: triage` to the spec's frontmatter.

**6. Allocation check.** Count specs by `type` across `triage/` + `specs/` + `in-progress/`, compare fractions to `allocation` targets. This check is advisory only: it never boosts, demotes, or otherwise changes a spec's score/priority. If any drift exceeds `drift_threshold`, include a concrete call-to-action in both `PRIORITIES.md` Notes and the human summary:
- **Starved and empty** (actual is 0, target is above threshold): name the missing type and suggest the human create supply — promote a parked thread, decompose an intent, retype an existing spec if it is mislabeled, or retarget/drop the allocation if the goal no longer matters.
- **Starved but present** (actual is below target, but at least one matching spec exists): name the matching specs and suggest a policy lever — add/adjust a priority rule, explicitly override one matching spec's priority, or reconsider whether allocation should remain advisory.
- **Overrepresented** (actual is above target by more than threshold): name the type and say it is crowding the mix; suggest holding more of that type in `triage/` for shaping unless it directly serves the top goal.

Always label allocation output as a prompt for human judgment, not an automatic scoring input. The priority stack remains goal/rule driven.

**7. Rewrite `PRIORITIES.md`** at the workspace root:

```markdown
---
updated: YYYY-MM-DD
generated_by: triage
---

# Priority stack

## Active            <- everything in in-progress/
## Next up           <- ready specs in specs/, sorted by priority then goal score
## Held for shaping  <- triage/ specs, sorted the same way, each with hold_reason
## Blocked           <- status: blocked, with what blocks them
## Flagged           <- rule-flagged items still in specs/ (not yet routed), with the rule's reason
## Icebox            <- p3 and unscored leftovers
## Notes             <- allocation prompts and other advisory context
```

List entries as `path — title (pN)` with a one-line reason. `Next up` lists only authorized specs under `specs/`; `Held for shaping` lists specs under `triage/` with each `hold_reason` (or "needs shaping" for legacy items) and whether each one is still blocked or ready to release. Preserve any human-added notes section at the bottom if one exists, and append/update generated allocation prompts separately so they are easy to review and remove.

**8. Write outputs.**
- `_metrics/triage-YYYY-MM-DD.md` — human summary: priority changes, detected overrides, newly unblocked specs, allocation check, stale flags, one line of goal progress.
- Append to `_metrics/triage-log.jsonl`:
  `{"date":"...","total":N,"by_priority":{"p0":N,...},"by_type":{...},"allocation_actual":{...},"overrides_detected":N,"routed_to_triage":N,"priorities":{"specs/foo/":"p1",...}}`

Append exactly one compact JSON line per pass with `fs.appendFileSync(file, JSON.stringify(record) + '\n')`; Python writers must use `json.dumps(record, separators=(',', ':'))`. Keep the documented key order (`date`, `total`, `by_priority`, `by_type`, `allocation_actual`, `overrides_detected`, `routed_to_triage`, `priorities`). The file is append-only: never rewrite it and never double-append a pass.

The `priorities` map is what step 3 diffs against next run — it must list every ranked spec in `triage/` and `specs/`.

**9. Report.** End by telling the user the top 3 next-up specs and anything that needs a human decision.

## Write discipline — how every frontmatter write happens

The 2026-07-14 clobber incidents (claimed `in-progress/` specs bulk re-serialized back to `specs/` `status: ready` by a stale-snapshot pass) are why these are hard rules:

- **Targeted single-field edits only.** Replace or insert exactly the field's line inside the leading `--- … ---` block, like `lib/frontmatter.js` `setFrontmatterField` / `stampSpecFields` do (use them via `node -e` when convenient). Never parse-and-re-dump a frontmatter block, never rewrite a `SPEC.md` wholesale — a full re-serialization writes your stale snapshot over concurrent claims and silently reorders, requotes, or drops fields.
- **Triage writes exactly these fields:** `priority`, `priority_set_by`, `hold_reason`, and `status` (status only as a folder-match fix derived from the folder at write time — step 2). Never write `claimed_by`, `claimed_at`, `awaiting_verifier`, `requested_at`, `verified_by`, or `verification_type` — those belong to builders, verifiers, and the run machinery.
- **Staleness guard — re-stat before every write.** Immediately before each write or move, check the spec still exists at the path you inventoried it at. Moved (or gone) → skip it and list it in the report; it is someone's live work. Never recreate the old path, never move it back, never demote a claimed spec.
- **Never move a claimed spec's folder.** Any spec with `claimed_by` set, or under `in-progress/`, `tests/`, or `in-review/`, keeps its stage no matter what the snapshot said. The only folder move triage may make is the unclaimed `specs/ → triage/` routing in step 4b.

## Guardrails

- Never create, edit the body of, execute, or delete a spec — except folder moves and frontmatter fields (`status`, `priority`, `priority_set_by`, `hold_reason`) required by this algorithm, written under the Write discipline above.
- Never demote or promote a `priority_set_by: human` spec by scoring — only an explicit rule can.
- Never edit `TRIAGE.yml`. If the goals look stale, say so in the report instead.
- Never rewrite history in JSONL logs — append only.

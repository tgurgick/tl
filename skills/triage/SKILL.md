---
name: triage
description: Rank a tl workspace's backlog — score specs against the goals, allocation targets, and rules in its TRIAGE.yml, detect human priority overrides, and rewrite PRIORITIES.md. Use when asked to triage, prioritize, rank, or re-sort a project's backlog, or as a scheduled daily run.
---

# /tl triage

Prioritizes one workspace. Reads files, reasons, writes files. Needs no network.

## Resolve the workspace

The argument is a workspace name (a folder under `projects/`) or a path. If no argument: when `projects/` contains exactly one workspace, use it; otherwise list the workspaces and ask which one. Everything below is relative to that workspace root. If `_metrics/` doesn't exist there, create it.

## Steps

**1. Read config.** Parse `TRIAGE.yml` (schema: `_templates/SCHEMA.md`). If it's missing or has no goals, stop and tell the user — never invent goals.

**2. Inventory.** Parse frontmatter from every `specs/*/SPEC.md` and `in-progress/*/SPEC.md`. Tolerate missing optional fields; report (don't crash on) malformed frontmatter. If a spec's `status` disagrees with its folder, fix the field to match the folder.

**3. Detect human overrides.** Read the last line of `_metrics/triage-log.jsonl` (if any) and its `priorities` map. For each spec whose current `priority` differs from that map while `priority_set_by` is still `triage`, a human changed it by hand:
- Set `priority_set_by: human` in the spec's frontmatter.
- Append to `_metrics/override-log.jsonl`:
  `{"date": "...", "spec": "specs/...", "from": "p2", "to": "p1"}`

This log is the training signal for future auto-triage tuning. Never skip this step.

**4. Apply rules.** From `TRIAGE.yml` `rules`, first match wins per spec. Standard actions: `set priority pN`, `boost priority by 1 level`, `flag for review`. Rules (and only rules) may change a `priority_set_by: human` spec — when one does, note it in the summary. Mark a rule-set priority as `priority_set_by: triage`.

Also: any spec whose `depends_on` entries are all in `done/` gets `status: ready`.

**5. Score.** For each spec not covered by a rule and not `priority_set_by: human`:
- For each goal: does this spec advance a key result, or is it a prerequisite to one that does? Judge 0–1, multiply by the goal's weight, sum across goals.
- Top quartile of scores → p1, middle half → p2, bottom quartile → p3.
- Write `priority` and `priority_set_by: triage` to the spec's frontmatter.

**6. Allocation check.** Count specs by `type` across `specs/` + `in-progress/`, compare fractions to `allocation` targets. If any drift exceeds `drift_threshold`, include a warning with a concrete suggestion in the summary.

**7. Rewrite `PRIORITIES.md`** at the workspace root:

```markdown
---
updated: YYYY-MM-DD
generated_by: triage
---

# Priority stack

## Active            <- everything in in-progress/
## Next up           <- ready specs, sorted by priority then goal score
## Blocked           <- status: blocked, with what blocks them
## Flagged           <- rule-flagged items, with the rule's reason
## Icebox            <- p3 and unscored leftovers
```

List entries as `path — title (pN)` with a one-line reason. Preserve any human-added notes section at the bottom if one exists.

**8. Write outputs.**
- `_metrics/triage-YYYY-MM-DD.md` — human summary: priority changes, detected overrides, newly unblocked specs, allocation check, stale flags, one line of goal progress.
- Append to `_metrics/triage-log.jsonl`:
  `{"date": "...", "total": N, "by_priority": {"p0": N, ...}, "by_type": {...}, "allocation_actual": {...}, "overrides_detected": N, "priorities": {"specs/foo/": "p1", ...}}`

The `priorities` map is what step 3 diffs against next run — it must list every spec.

**9. Report.** End by telling the user the top 3 next-up specs and anything that needs a human decision.

## Guardrails

- Never create, edit the body of, execute, or delete a spec.
- Never demote or promote a `priority_set_by: human` spec by scoring — only an explicit rule can.
- Never edit `TRIAGE.yml`. If the goals look stale, say so in the report instead.
- Never rewrite history in JSONL logs — append only.

---
name: dedup
description: Clean a tl workspace's bug specs — auto-close bugs resolved in the error tracker, merge duplicates, flag stale ones. Use when asked to dedup, clean up, or sweep the bug backlog, or as a scheduled daily run before triage.
---

# /tl dedup

Sweeps one workspace's bug specs so triage isn't ranking noise. Run it before `/tl triage`. Works fully offline; the provider checks are an extra pass that only runs when error tracking is connected.

## Resolve the workspace

Same as `/tl triage`: argument is a workspace name under `projects/` or a path; no argument + exactly one workspace → use it; otherwise ask.

## Steps

**1. Inventory.** Parse frontmatter from every `type: bug` spec in `specs/` and `in-progress/` (schema: `_templates/SCHEMA.md`).

**2. Provider pass** — only if `TRIAGE.yml` has `error_tracking.enabled: true` and the provider's MCP tools are available; otherwise skip silently. For each bug spec with a `source_id`:
- Query the provider for the issue's current status.
- **Resolved** there, with no recurrence in 72 hours: move the spec folder to `done/`, set `status: done`, and write `outcome/FEEDBACK.md` noting auto-resolution (`scores` omitted — nobody executed it).
- **Merged** in the provider: find the spec for the merge target by `source_id`, append this spec's unique context into the target's `context/`, then delete the duplicate folder. If no target spec exists, just note the merge in the spec body — don't delete.

**3. Manual duplicate pass** — for all open bug specs (with or without `source_id`), pairwise compare likely-file lists and error descriptions:
- More than half the files overlap, or the error signatures clearly match → add a line to BOTH spec bodies: `> Possible duplicate of {other path}` (skip if already present). Never auto-merge manual candidates.

**4. Stale pass.** Any bug older than 14 days that isn't `p0`: append `stale` to its `tags` if not present.

**5. Log.** Append to `_metrics/dedup-log.jsonl`:
`{"date": "...", "merged": N, "auto_closed": N, "flagged_dupes": N, "flagged_stale": N, "total_open_bugs": N}`

**6. Report.** Tell the user what was closed, merged, and flagged — and anything that needs a human call (e.g. a flagged duplicate pair).

## Guardrails

- Auto-merge and auto-close ONLY on the provider's authority (step 2). Heuristic matches (step 3) flag, never act.
- Never touch non-bug specs.
- Never delete a spec folder except a provider-confirmed duplicate whose context has been copied to the target.
- Append-only logs.

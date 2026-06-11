---
name: bug-capture
description: Poll the error tracker (Sentry/Datadog/Bugsnag) for new crashes and turn each into an agent-ready bug spec in a tl workspace. Use when asked to capture bugs, pull crashes, or sync the error tracker, or as a scheduled run every 15 minutes.
---

# /tl bug-capture

Turns tracker issues into spec folders an agent can pick up cold. This is the one tl skill that requires network: the provider's MCP tools must be available.

## Resolve the workspace

Same as `/tl triage`: argument is a workspace name under `projects/` or a path; no argument + exactly one workspace → use it; otherwise ask.

## Preconditions

Read `triage.yml` `error_tracking` (schema: `_templates/SCHEMA.md`). If the block is missing, `enabled: false`, or the provider's MCP tools aren't connected: stop and tell the user what's missing — don't fake data.

## Steps

**1. Find the watermark.** Read the last line of `_metrics/capture-log.jsonl` for the most recent `timestamp`. First run: look back 7 days.

**2. Query.** Fetch issues for `error_tracking.project_slug` newer than the watermark.

**3. Deduplicate.** Skip any issue whose ID already appears as a `source_id` in any spec across `specs/`, `in-progress/`, and `done/`.

**4. Create a spec folder per new issue** — `specs/bug-{slug}-{YYYY-MM-DD}/`, from `_templates/bug.md`:
- `SPEC.md` — title from the issue; frontmatter `source`, `source_id`, `source_url`, `affected_users`, `first_seen` filled in; `priority` left blank (triage owns it); repro steps reconstructed from breadcrumbs; abridged stack trace (top frames only).
- `context/crash-report.md` — the full error report: complete stack trace, breadcrumbs, device/OS breakdown, first/last seen, counts.
- `context/affected-code.md` — source excerpts for the stack-trace frames, read from the project repo (the spec's `repo` path). If the repo isn't available locally, note that in the file instead.

**5. Log one line per captured bug** to `_metrics/capture-log.jsonl`:
`{"timestamp": "...", "source": "sentry", "issue_id": "...", "spec": "specs/bug-...", "affected_users": N}`

**6. Report.** List the specs created with affected-user counts, and call out anything that looks P0-worthy (widespread or a regression) so the user doesn't wait for the next triage run.

## Guardrails

- Never set `priority` — that's triage's job. Exception: nothing. Mention urgency in the report instead.
- Never modify existing specs; this skill only creates.
- One spec per provider issue — the `source_id` check is mandatory.
- Append-only logs.

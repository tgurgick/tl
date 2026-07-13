---
name: sync
description: Sync a tl workspace with JIRA — import assigned issues as specs and epics as intents, push TL status and human priority changes back. Use when asked to sync JIRA, import JIRA issues or the sprint, push status back to the tracker, or as a scheduled run.
---

# /tl sync

The JIRA shadow layer. JIRA stays the system of record for the team; the workspace is the execution layer for the individual. Import turns JIRA issues into files agents can work; export pushes the two signals the team cares about — done, and priority — back to JIRA. Like `/tl bug-capture`, this skill needs network; unlike everything else in tl, it talks to an API directly.

The bridge is `jira_key` in frontmatter (schema: `../../_templates/SCHEMA.md`): a spec or intent that mirrors a JIRA issue carries the issue key, and every sync decision — create vs. update, push vs. skip — starts from that field.

## Resolve the workspace

Same as `/tl triage`: argument names a workspace under `projects/`; exactly one workspace → use it; otherwise ask.

## Preconditions

**1. Config.** Read the `sync` section of `TRIAGE.yml`:

```yaml
sync:
  jira:
    url: ""             # the JIRA Cloud site, e.g. https://acme.atlassian.net
    project: ""         # JIRA project key, e.g. PROJ
    import_filter: ""   # JQL; default "assignee = currentUser() AND statusCategory != Done"
    map:                # issue type → tl primitive
      epic: intent
      story: spec
      task: spec
      bug: spec
```

Missing section → stop and tell the user what to add; don't fake a config. This skill targets **JIRA Cloud REST API v3** only (not Server/DC).

**2. Credentials.** API-token basic auth: the header is `Authorization: Basic <base64 of email:api_token>` (tokens are created at https://id.atlassian.com/manage/api-tokens). Read the pair from the environment — `JIRA_EMAIL` and `JIRA_API_TOKEN` — or from a credentials file **outside the repo** (e.g. `~/.config/tl/jira.env`). **The token is never in `TRIAGE.yml`, never in any file under the repo or a workspace, never in a log line.** Missing credentials → stop and say which variable is unset; never prompt the user to paste a token into the conversation.

**3. Reachability.** One cheap call (`GET {url}/rest/api/3/myself`). If JIRA is unreachable — offline, auth failure, site down — log one `{"action": "offline"}` line to `_metrics/sync-log.jsonl`, tell the user, and stop cleanly. **TL works fully offline**; nothing in any other skill waits on sync. The next successful run catches up on its own, because sync derives everything from current file state plus the log — it replays no missed events.

## The mapping

| JIRA | tl | Notes |
|------|----|-------|
| Epic | `intents/<slug>.md` | outcome language; children link back via `intent:` |
| Story / Task | spec folder, `type: feature` | execution language, enriched locally with `context/` |
| Bug | spec folder, `type: bug` | |
| status category To Do | `triage/` or `specs/` | wherever the spec sits pre-claim |
| status category Done | `done/` — **push only** | import never moves a spec to done; it flags |
| Highest / High / Medium / Low / Lowest | `p0` / `p1` / `p2` / `p3` / `p3` | export reverses: p0→Highest, p1→High, p2→Medium, p3→Low |

Priority imported from JIRA is written with `priority_set_by: human` — the team's call in JIRA *is* a human call, and triage must not re-score over it.

## Import (JIRA → TL)

**1. Watermark.** Read the last successful run's timestamp from `_metrics/sync-log.jsonl` (the newest `run_started` line whose run completed). First run: no watermark, import everything the filter matches.

**2. Query.** `GET {url}/rest/api/3/search/jql?jql=<import_filter>&fields=summary,description,issuetype,status,priority,assignee,parent,updated` — with `project = <project>` AND'd into the JQL, plus `updated >= <watermark>` when a watermark exists. Paginate with `nextPageToken` / `maxResults` until `isLast` (the legacy `/rest/api/3/search` endpoint is removed — do not use it). Cap at 20 pages defensively and report if the cap hits.

**3. Per issue, dedup first.** Search all stage folders (and `intents/`) for a matching `jira_key`. This check is mandatory — a `jira_key` that already exists is **never recreated**, only updated:

- **Priority changed in JIRA** and the spec's priority wasn't also changed locally since the last sync (check `_metrics/sync-log.jsonl` and `override-log.jsonl`) → update `priority` + `priority_set_by: human`, log it. Both sides changed → **JIRA wins**, log a `conflict` line, and say so in the report — the human re-overrides locally if they disagree.
- **Status went Done in JIRA** while the TL spec isn't in `done/` → never move the folder (only humans move work to `done/`); flag it in the report for `/tl review`.
- **Reassigned away from the user** while the spec is unclaimed (`triage/` or `specs/`) → flag in the report; suggest removal but don't delete.
- Claimed specs (`in-progress/`, `tests/`, `in-review/`) never move on import, whatever JIRA says — report mismatches instead.

**4. New epic → intent.** Write `intents/<slug>.md` from `../../_templates/intent.md`: title from the summary, `status: draft`, `jira_key`, Outcome drafted from the epic description (JIRA v3 returns descriptions as Atlassian Document Format JSON — render it to prose best-effort). Leave `goals` empty and say so in the report: linking an imported intent into the throughline is the human's call, and `/tl map` will flag it until they do.

**5. New story/task/bug → spec.** Create `triage/<key-lower>-<slug>/` from `../../_templates/spec/`:

- `SPEC.md` — title from the summary; `jira_key`, `jira_url` (`{url}/browse/{key}`); `type` per the mapping; `status: triage`; priority mapped per the table with `priority_set_by: human`; `repo` from the workspace's `PROJECT.md`; `intent` pointing at the parent epic's intent file when one exists (and add the spec path to that intent's `specs:` list).
- `context/jira-issue.md` — the full imported record: rendered description, issue type, status, reporter, labels, links.

Imported specs land in `triage/`, not `specs/`: a JIRA story is a request, not yet an agent-ready spec. The human release gate (`triage/ → specs/`) is where acceptance criteria and file scope get added — releasing an unenriched import is choosing to run it thin.

**6. Log** one line per action to `_metrics/sync-log.jsonl` (append-only, schema below).

## Export (TL → JIRA)

Runs after import, over every spec **with a `jira_key`** — specs born locally are untouched until someone links them. Export is derived from current state, so a run that was skipped offline needs no catch-up bookkeeping:

**1. Done push.** For each `jira_key` spec in `done/` with no prior successful `pushed_status` line in `_metrics/sync-log.jsonl`: `GET {url}/rest/api/3/issue/{key}/transitions`, pick the transition whose target status has category Done, then `POST .../transitions` with `{"transition": {"id": "<id>"}}`. Status changes go through the transitions endpoint only — a field edit cannot carry a transition. No Done-category transition available from the issue's current status → log `error`, flag in the report, move on.

**2. Priority push.** For each `jira_key` spec with `priority_set_by: human` whose priority differs from the last value synced for that key (per the log): `PUT {url}/rest/api/3/issue/{key}` with `{"fields": {"priority": {"name": "<mapped name>"}}}`, using the reverse mapping above. Priority set by triage is **never** pushed — only human calls cross the bridge.

**3.** Any 4xx/5xx: log an `error` line with the key and status code (never the response body wholesale — it can echo auth details), continue with the remaining specs, and summarize failures in the report. Partial success is fine; the next run retries whatever the log doesn't show as pushed.

## `sync-log.jsonl`

One line per action, append-only, in `_metrics/`:

```json
{"timestamp": "2026-07-12T14:03:22Z", "direction": "import", "action": "created_spec", "jira_key": "PROJ-123", "path": "triage/proj-123-rate-limit/", "detail": ""}
```

`direction`: `import` | `export` | `none`. `action`: `run_started` `run_completed` `created_spec` `created_intent` `updated_priority` `pushed_status` `pushed_priority` `conflict` `flagged` `offline` `error`. The log doubles as sync memory: the import watermark, the already-pushed check, and conflict detection all read it — never edit existing lines.

## Report

Created intents and specs (with JIRA keys), updates applied, pushes made, then the human-attention list: Done-in-JIRA mismatches, conflicts where JIRA won, reassignments, unlinked intents (`goals: []`), and errors.

## Deferred

Per the spec's phasing: mid-stage status export (in-progress → "In Progress") and true bidirectional priority reconciliation are deferred. The conflict rule above — JIRA wins, loudly — is the placeholder until a real merge policy earns its keep.

## Guardrails

- The credential rule is absolute: token in env or a file outside the repo, never in `TRIAGE.yml`, never committed, never logged, never echoed.
- `jira_key` dedup is mandatory — one JIRA issue maps to at most one spec or intent, ever.
- Import never moves claimed work and never moves anything to `done/`; export never touches JIRA fields other than status transitions and priority.
- Never delete specs, intents, or JIRA issues; removal is flagged, not performed.
- This SKILL.md (the procedure) is public; any always-on sync daemon or hosted service belongs in the private repo per `docs/repo-split.md`. The boundary is the data contract — `jira_key` in frontmatter — not shared code.
- Offline is a clean stop, not an error state. Local-only tl is a complete product.

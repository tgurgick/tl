# Frontmatter schema

The contract between the markdown files, the skills, and any UI. One file = one record; YAML frontmatter is the machine-readable part, the body is for humans and agents. Parsers must preserve unknown fields. Enums are lowercase. Dates are ISO (`YYYY-MM-DD`).

## Folder semantics

A spec's lifecycle stage is its folder, inside a workspace (`projects/<name>/`):

| Folder | Meaning |
|--------|---------|
| `triage/` | Idea under evaluation — not yet an intent or spec |
| `intents/` | Human objectives |
| `specs/` | Agent-ready, not started (`status: ready` or `blocked`) |
| `in-progress/` | Being worked |
| `done/` | Completed, has `outcome/FEEDBACK.md` |
| `threads/` | Anything worth remembering that isn't active work |

If `status` and folder disagree, the folder wins; skills fix the field to match.

## Spec (`specs/*/SPEC.md`, `done/*/SPEC.md`)

| Field | Type | Values | Written by |
|-------|------|--------|-----------|
| `title` | string | required | human / bug-capture |
| `created` | date | required | author |
| `project` | string | workspace name | author |
| `repo` | path | project repo | author |
| `intent` | path | parent intent or `""` | author |
| `type` | enum | `feature` `bug` `tech_debt` `research` | author |
| `status` | enum | `ready` `in-progress` `blocked` `done` | author / triage |
| `priority` | enum | `p0` `p1` `p2` `p3` or `""` | triage / human |
| `priority_set_by` | enum | `triage` `human` or `""` | triage / human |
| `size` | enum | `small` `medium` `large` | author |
| `depends_on` | list of paths | | author |
| `blocks` | list of paths | | author |
| `tags` | list | | author |

Bug specs add: `source` (`sentry` `datadog` `manual`), `source_id`, `source_url`, `affected_users` (int), `first_seen` (date).

**The override signal.** `priority_set_by` is how the system learns. When the triage skill sets a priority it writes `priority_set_by: triage`. When you set or change a priority by hand, set `priority_set_by: human` — triage will never re-score that spec (only P0 rules can still fire). If triage finds a priority changed since its last run while `priority_set_by` still says `triage`, it treats that as a human override: it flips the field to `human` and logs the change to `_metrics/override-log.jsonl`. Those override lines are the training data for future auto-triage tuning.

## Intent (`intents/*.md`)

| Field | Type | Values |
|-------|------|--------|
| `title` | string | required |
| `created` | date | required |
| `project` | string | workspace name |
| `status` | enum | `draft` `approved` `decomposed` |
| `priority` | enum | `p0`–`p3` or `""` |
| `tags` | list | |
| `specs` | list of paths | specs derived from this intent |

## Thread (`threads/*.md`)

The only primitive besides intents and specs: intents = why, specs = what to do now, threads = what not to lose. Open loops, parked ideas, decision history, and cleanup queues are all *views* over threads — never new object types.

| Field | Type | Values | Notes |
|-------|------|--------|-------|
| `title` | string | required | |
| `created` | date | required | |
| `type` | enum | `idea` `followup` `decision` `risk` `cleanup` `question` | what kind of memory this is |
| `status` | enum | `open` `parked` `promoted` `closed` | `open` = unresolved (an open loop); `parked` = good, not now; `promoted` = became a spec; `closed` = resolved/recorded |
| `origin` | string | spec path, conversation, person | where it came from |
| `linked_intent` | path | optional | |
| `linked_spec` | path | optional | |

Body: the thought itself. For `decision` threads, include the why — a recorded decision is `status: closed` and stays as the record.

## Feedback (`done/*/outcome/FEEDBACK.md`)

| Field | Type | Values |
|-------|------|--------|
| `spec` | path | the completed spec |
| `completed` | date | required |
| `agent_model` | string | e.g. `claude-fable-5` |
| `scores.correctness` | int 1–5 | did it work |
| `scores.completeness` | int 1–5 | all criteria met |
| `scores.scope_discipline` | int 1–5 | stayed in bounds |
| `priority_was_right` | bool | was this worth doing when we did it |

`scores` and `priority_was_right` are the learnable fields — keep them honest, they feed the same loop as the override log.

## Workspace config (`TRIAGE.yml`)

```yaml
goals:                  # what matters now
  - id: slug
    description: ""
    weight: 0.0         # weights should sum to ~1.0
    key_results: []
allocation:             # target work mix, fractions sum to 1.0
  bugs: 0.0
  features: 0.0
  tech_debt: 0.0
  research: 0.0
  drift_threshold: 0.15
rules:                  # priority overrides, first match wins
  - condition: ""       # boolean expression over spec fields
    action: ""          # "set priority pN" | "boost priority by 1 level" | "flag for review"
    reason: ""
error_tracking:         # optional — enables /tl bug-capture
  provider: ""          # sentry | datadog | bugsnag
  project_slug: ""
  enabled: false
```

## Metrics (`_metrics/*.jsonl`, per workspace)

Append-only, one JSON object per line. Schemas are defined in each skill's SKILL.md. Never edit existing lines; corrections are new lines.

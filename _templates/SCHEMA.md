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
| `tests/` | Code complete, the test/verification gate (CI or acceptance tests) — auto gate |
| `in-review/` | Tests green, awaiting human sign-off — the human gate, has `outcome/FEEDBACK.md` |
| `done/` | Reviewed and accepted |
| `threads/` | Anything worth remembering that isn't active work |

If `status` and folder disagree, the folder wins; skills fix the field to match.

A spec flows `ready → in-progress → tests → in-review → done`. An agent (`/tl run`) carries work as far as `in-review`; only a human (or `/tl review`) promotes `in-review → done`. This gate is what makes parallel fan-out safe — many agents land their work in `in-review`, where it's signed off in a batch rather than merged blind.

## Spec (`specs/*/SPEC.md`, `done/*/SPEC.md`)

| Field | Type | Values | Written by |
|-------|------|--------|-----------|
| `title` | string | required | human / bug-capture |
| `created` | date | required | author |
| `project` | string | workspace name | author |
| `repo` | path | project repo | author |
| `intent` | path | parent intent or `""` | author |
| `type` | enum | `feature` `bug` `tech_debt` `research` | author |
| `status` | enum | `ready` `in-progress` `tests` `in-review` `blocked` `done` | author / triage |
| `priority` | enum | `p0` `p1` `p2` `p3` or `""` | triage / human |
| `priority_set_by` | enum | `triage` `human` or `""` | triage / human |
| `size` | enum | `small` `medium` `large` | author |
| `depends_on` | list of paths | | author |
| `blocks` | list of paths | | author |
| `tags` | list | | author |
| `agent` | enum | optional — `any` `claude` `codex` `cursor` `gemini` (default `any`) | author / human |

**Agent routing.** `agent` is a lane hint for heterogeneous fan-out. `tl run --agent <name>` claims only specs whose `agent` is `<name>` or `any` — so Claude, Codex, and Cursor can each drain their own lane concurrently over one throughline, coordinated by the folder-move claim (`specs/ → in-progress/` is the lock — whoever moves it first owns the spec; no central orchestrator). Absent or `any` = runnable by whichever agent picks it up. This field also tells the TESTS gate who *built* a spec, so a cross-model verifier can pick a checker that isn't the builder (see `alt-model-alignment-check`).

Bug specs add: `source` (`sentry` `datadog` `manual`), `source_id`, `source_url`, `affected_users` (int), `first_seen` (date).

**The override signal.** `priority_set_by` is how the system learns. When the triage skill sets a priority it writes `priority_set_by: triage`. When you set or change a priority by hand, set `priority_set_by: human` — triage will never re-score that spec (only P0 rules can still fire). If triage finds a priority changed since its last run while `priority_set_by` still says `triage`, it treats that as a human override: it flips the field to `human` and logs the change to `_metrics/override-log.jsonl`. Those override lines are the training data for future auto-triage tuning.

## Intent (`intents/*.md`)

| Field | Type | Values |
|-------|------|--------|
| `title` | string | required |
| `created` | date | required |
| `project` | string | workspace name |
| `status` | enum | `draft` `approved` `decomposed` `done` |
| `goals` | list of goal ids | which `TRIAGE.yml` goal(s) this intent serves — the top rung of the throughline |
| `priority` | enum | `p0`–`p3` or `""` |
| `tags` | list | |
| `specs` | list of paths | specs derived from this intent |

The full traceability chain is `goals → intents → specs → code`: a spec names its `intent`, an intent names its `goals`, and `TRIAGE.yml` defines the goals. `/tl map` walks this chain; a missing link (a spec with no intent, an intent with no goal, a goal with nothing under it) is a break in the throughline.

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
| `agent_tool` | enum | optional — `claude-code` `cursor` `codex` `windsurf` `other` — which tool ran the spec (not just the model) |
| `duration_minutes` | number | optional — wall-clock minutes to carry the spec to in-review, e.g. `12` |
| `cost_usd` | number | optional — estimated API cost in USD, e.g. `0.42` |
| `tokens_used` | number | optional — total tokens consumed, e.g. `38000` |
| `scores.correctness` | int 1–5 | did it work |
| `scores.completeness` | int 1–5 | all criteria met |
| `scores.scope_discipline` | int 1–5 | stayed in bounds |
| `priority_was_right` | bool | was this worth doing when we did it |

`scores` and `priority_was_right` are the learnable fields — keep them honest, they feed the same loop as the override log.

`agent_tool`, `duration_minutes`, `cost_usd`, and `tokens_used` are optional cost signals — absent on older FEEDBACK files and unset when unknown. Together they enable head-to-head comparison across agents for the same spec type; they feed the future benchmark-analytics schema. The same four fields appear on each `cycle-log.jsonl` line (below) so metrics aggregation reads them without reparsing markdown.

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

`cycle-log.jsonl` records one line per completed cycle and carries the same four cost signals as FEEDBACK.md, so metrics aggregation reads them from the JSONL without reparsing markdown. Each line includes at least: `spec` (path), `completed` (date), plus the optional `agent_tool` (enum: `claude-code` `cursor` `codex` `windsurf` `other`), `duration_minutes` (number), `cost_usd` (number, estimated), and `tokens_used` (number). Older lines that predate these fields are valid — the fields are optional.

`loop-log.jsonl` (written by `/tl loop`) records one line per loop iteration: `goal` (id), `iteration` (int), `specs_run` (int), `specs_auto_reviewed` (int), `specs_awaiting_review` (int), `key_results_met` (int), `key_results_total` (int). It traces a goal's progress across an autonomous cycle; the human gate still owns `in-review → done`.

## Spec notes (`<stage>/<slug>/NOTES.md`, optional)

Append-only human feedback on a spec, left from the cockpit while work is in flight. Each note is a small dated section (`## YYYY-MM-DD — note`, or `— kicked back` for a review rejection). The file lives in the spec's own folder, so it travels with the spec through every stage. `/tl run` reads it as binding context (treat it like the acceptance criteria); `/tl review` surfaces it. There is no queue — the `ready/` stage **is** the queue, the stage folders **are** the status, and the cockpit's write actions are review (accept / kick back) and notes, not dispatch.

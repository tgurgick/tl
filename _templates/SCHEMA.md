# Frontmatter schema

The contract between the markdown files, the skills, and any UI. One file = one record; YAML frontmatter is the machine-readable part, the body is for humans and agents. Parsers must preserve unknown fields. Enums are lowercase. Dates are ISO (`YYYY-MM-DD`).

## Folder semantics

A spec's lifecycle stage is its folder, inside a workspace (`projects/<name>/`):

| Folder | Meaning |
|--------|---------|
| `triage/` | Ranked spec held for human release — scored by `/tl triage`, but not runnable until moved to `specs/` |
| `intents/` | Human objectives |
| `specs/` | Agent-ready, not started (`status: ready` or `blocked`) |
| `in-progress/` | Being worked |
| `tests/` | Code complete, the test/verification gate (CI or acceptance tests) — auto gate |
| `in-review/` | Tests green, awaiting human sign-off — the human gate, has `outcome/FEEDBACK.md` |
| `done/` | Reviewed and accepted |
| `threads/` | Anything worth remembering that isn't active work |
| `_dispatch/` | Continuation triggers — one JSON file per kicked-back/mid-flight spec awaiting resume (see below) |

If `status` and folder disagree, the folder wins; skills fix the field to match.

A spec can be held before release: `triage → ready → in-progress → tests → in-review → done`. `triage/` is a release gate, not the run queue: `/tl triage` may score and rank a held spec there, but `/tl run` only claims from `specs/`. Releasing work means moving `triage/<slug>/ → specs/<slug>/` and setting `status: ready`. An agent (`/tl run`) carries work as far as `in-review`; only a human (or `/tl review`) promotes `in-review → done`. This gate is what makes parallel fan-out safe — many agents land their work in `in-review`, where it's signed off in a batch rather than merged blind.

## Project (`PROJECT.md`)

One per workspace root — the workspace's identity card. The context-map body is for humans; the frontmatter is machine-read, and `repo:` / `remote:` are load-bearing: the `/tl new` and `/tl decompose` repo preflights read both, and `/tl run`'s claim preflight reads the workspace `repo:` for the tl-checkout exemption (below).

| Field | Type | Values |
|-------|------|--------|
| `name` | string | required — workspace name |
| `created` | date | required |
| `status` | enum | `active` `paused` `archived` |
| `repo` | path | the project's code repo — never the tl checkout or inside it (see below) |
| `remote` | string | the repo's remote URL, or explicitly `"none yet"` |
| `description` | string | one line |

**`repo:` resolution.** A local path — `~` and `~/…` expand against the home directory, then resolve absolute (`lib/batch.js` `localRepoPath`). A URL-shaped value (`scheme://…` or `user@host:…`) has nothing local to check and is treated as unset by the local-path checks. Skills resolve `repo:`-prefixed context-map locations against this path.

**The never-the-tl-checkout constraint.** A workspace only *tracks* the work; the project's code lives in its own repo, never in the tl checkout. `/tl new` rejects a `repo:` at or inside the tl root, and `/tl run`'s claim preflight (`lib/batch.js` `repoHoldReason`) holds any code spec whose effective repo is unset, URL-only, or at/inside the tl checkout — reason: `no project repo — refusing to work in the tl checkout` — rather than defaulting into cwd. The one exception is the tl-developing-tl workspace, whose own PROJECT.md `repo:` points at the tl root; it is accepted at `/tl new` only with the user's explicit confirmation, and it is what exempts that workspace from the claim-preflight hold.

**`remote:` verification.** The remote is how the repo's existence is verified. The `/tl new` / `/tl decompose` preflight checks: a local `repo:` path exists and is a git checkout; when `remote:` is also set, the checkout's `origin` matches it; and `remote:` answers `git ls-remote` with at least one ref beyond an empty/init-only state. An unreachable remote (offline, auth) is a warning, not a hard stop. `"none yet"` is an explicit answer; a blank left by omission is a hole the preflight can't reason about — never skip recording it.

## Spec (`triage/*/SPEC.md`, `specs/*/SPEC.md`, `done/*/SPEC.md`)

| Field | Type | Values | Written by |
|-------|------|--------|-----------|
| `title` | string | required | human / bug-capture |
| `created` | date | required | author |
| `project` | string | workspace name | author |
| `repo` | path | project repo | author |
| `intent` | path | parent intent or `""` | author |
| `type` | enum | `feature` `bug` `tech_debt` `research` | author |
| `status` | enum | `triage` `ready` `in-progress` `tests` `in-review` `blocked` `done` | author / triage |
| `priority` | enum | `p0` `p1` `p2` `p3` or `""` | triage / human |
| `priority_set_by` | enum | `triage` `human` or `""` | triage / human |
| `size` | enum | `small` `medium` `large` | author |
| `depends_on` | list of paths | | author |
| `blocks` | list of paths | | author |
| `tags` | list | | author |
| `agent` | enum | optional — `any` `claude` `codex` `cursor` `gemini` (default `any`) | author / human |
| `claimed_by` | enum | optional — `claude` `codex` `cursor` `gemini` — who actually claimed/is working it | claiming agent |
| `claimed_at` | date | optional — when the spec was claimed | claiming agent |
| `jira_key` | string | optional — JIRA issue key this spec mirrors, e.g. `PROJ-123` | sync / author |
| `jira_url` | string | optional — the JIRA issue's browse URL | sync / author |

**Agent routing.** `agent` is a lane hint for heterogeneous fan-out. `tl run --agent <name>` claims only specs whose `agent` is `<name>` or `any` — so Claude, Codex, and Cursor can each drain their own lane concurrently over one throughline, coordinated by the folder-move claim (`specs/ → in-progress/` is the lock — whoever moves it first owns the spec; no central orchestrator). Absent or `any` = runnable by whichever agent picks it up.

**Claim ownership.** `agent` is the *lane* (who a spec is routed to, author-set, often `any`); `claimed_by` is *who actually grabbed it* — stamped by the claiming agent when it moves the spec `specs/ → in-progress/` (with `claimed_at`). Because the folder move alone is anonymous, `claimed_by` is what makes concurrent multi-agent work legible: the cockpit shows it as the live owner on in-progress/tests/in-review cards, so a human can see *which* agent has picked up *which* task. It **identifies the builder** at the TESTS gate — the cross-model verifier must pick a checker that is *not* `claimed_by` (the verifier must differ; see `alt-model-alignment-check` and the alignment record below). Falls back to `agent` when a spec predates claim-stamping.

Bug specs add: `source` (`sentry` `datadog` `manual`), `source_id`, `source_url`, `affected_users` (int), `first_seen` (date).

**The JIRA bridge (`jira_key` / `jira_url`).** `jira_key` links a spec (or intent, below) to the JIRA issue it mirrors — written by `/tl sync` on import, or by hand to link work born locally. It is the sync dedup key: one JIRA issue maps to at most one spec or intent, and `/tl sync` updates a matched record rather than recreating it. `jira_url` is the human-clickable browse URL. Both optional; absent means the record has no JIRA counterpart and sync leaves it alone. The link lives entirely in frontmatter — TL works fully offline and never depends on JIRA being reachable (algorithm: `skills/sync/SKILL.md`).

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
| `jira_key` | string | optional — JIRA epic key this intent mirrors (see the JIRA bridge, above) |

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

`agent_tool`, `duration_minutes`, `cost_usd`, and `tokens_used` are optional cost signals — absent on older FEEDBACK files and unset when unknown. Together they enable head-to-head comparison across agents for the same spec type; they feed `benchmark-log.jsonl` (below). The same four fields appear on each `cycle-log.jsonl` line (below) so metrics aggregation reads them without reparsing markdown.

## Alignment (`*/outcome/ALIGNMENT.md`)

The record of the cross-model check at the TESTS gate: a verifier agent **different from the builder** reviews the diff against the acceptance criteria, the intent's Outcome, and `_patterns/review-gates.md`, its concerns go back to the builder to remediate (bounded), and this file logs each round. Written before the spec advances to `in-review`; travels with the spec. The **builder** is the spec's `agent:` field; the **verifier** must differ.

| Field | Type | Values |
|-------|------|--------|
| `spec` | path | the spec being checked |
| `builder` | string | who built it — the spec's `claimed_by` / `agent:` lane / FEEDBACK `agent_tool` (e.g. `claude`) |
| `verifier` | string | the checking agent (e.g. `codex`) — must differ from `builder` unless `verification_type: self-check` is policy-allowed |
| `verification_type` | enum | **required**: `independent` (verifier ≠ builder) or `self-check` — `self-check` is valid **only** when the workspace's `verification.allow_self_check_for` lists the spec's `type` |
| `rounds` | int | how many advise → remediate → re-check cycles ran (1–2; cap ~2) |
| `verdict` | enum | `pass` (converged) or `residual-concerns` (cap tripped, unresolved) |
| `residual_concerns` | list | specifics still open when `verdict: residual-concerns`; `[]` on `pass` |

Body: one short section per round — what the verifier raised, and how the builder addressed it. On `residual-concerns` the open items are the flag the human reads at `/tl review`; the human gate is never removed, only better-informed. Absent = no cross-model check ran (older, pre-gate specs — grandfathered at review, treated like self-check).

**Enforcement (`verification` in `TRIAGE.yml`).** The gate that makes the above policy, not convention (`lib/verification-gate.js` `canAdvanceToReview`; incident: `done/allocation-actionable-prompt` advanced with `builder == verifier == codex`):

```yaml
verification:
  require_independent_verifier: true   # builder ≠ verifier required to advance tests → in-review
  allow_self_check_for: []             # spec types exempt (e.g. [research]); empty = none
```

When required and no independent verifier is available, the builder **stops at `tests/`** (`status: blocked`) instead of self-verifying: it sets spec frontmatter `awaiting_verifier: true` + `requested_at: YYYY-MM-DD` and writes a minimal `VERIFY.md` request (builder, date, anything to flag) in the spec folder. `tl verify [ws] [--agent <name>]` lists these for any agent that is **not** the builder. The verifier writes ALIGNMENT (`verification_type: independent`), stamps the spec frontmatter — `verified_by: <agent>`, `verification_type`, `awaiting_verifier: false` — and advances the spec to `in-review/`. The cockpit's in-review badge reads those frontmatter stamps (`verified by <agent>` vs `self-check`); a section absent from `TRIAGE.yml` means not enforced (pre-gate workspaces unchanged).

## Experiments (`_experiments/*`)

Experiments compare one task across one primary candidate and zero or more shadow candidates. They are shadow attempts: they never move canonical `specs/`, `in-progress/`, `tests/`, `in-review/`, or `done/` folders by themselves. A winning patch becomes source-of-truth work only through a later explicit apply/review path.

The experiment model is portable. TL maps a spec to a generic `task`, but the artifact contract should also work for future non-TL tasks:

| Generic concept | Meaning | TL mapping |
|-----------------|---------|------------|
| `task` | The work request, scope, acceptance criteria, and context | A spec plus its intent outcome, goal context, allowed files, and base commit |
| `candidate_run` | One agent/tool/model attempt to satisfy the task | A primary or shadow run that produces a patch, feedback, metrics, and optional trace |
| `judge_run` | One evaluation of candidate outputs | A human or agent judge comparing candidates against gates, scores, and utility |
| `experiment` | The cohort tying task, candidates, judge, base commit, and hashes together | One `_experiments/<experiment_id>/` folder |
| `runtime_fingerprint` | The exact runtime identity used by a candidate or judge | Tool, model, framework, adapter, rules, and skills hashes |

Experiment folders use this shape:

```text
_experiments/<experiment_id>/
├── EXPERIMENT.md
├── candidates/<candidate_id>/
│   ├── PATCH.diff
│   ├── FEEDBACK.md
│   ├── METRICS.json
│   ├── TRACE.jsonl          # optional
│   └── REASONING.md         # optional; deliberate summaries only, never private chain-of-thought
├── evaluation/<judge_id>/
│   ├── EVALUATION.md
│   └── SCORES.json
├── WINNER.json              # optional; current winner-application state (explicit human decisions only)
├── APPLICATION.md           # optional; review artifact written on apply / send-to-review
└── queue/                   # optional local queue files for later worker specs
```

### `EXPERIMENT.md`

Frontmatter:

| Field | Type | Values |
|-------|------|--------|
| `experiment_id` | string | required; folder-safe id |
| `task_type` | enum/string | `tl_spec` for TL specs; other adapters may define their own |
| `tl_spec` | path | TL spec path when `task_type: tl_spec` |
| `spec_hash` | string | content hash of the task/spec at experiment creation time |
| `base_commit` | string | git commit the candidates run against |
| `primary_agent` | string | primary candidate id or agent tool |
| `shadow_agents` | list | shadow candidate ids or agent tools |
| `judge_agent` | string | judge id/tool |
| `status` | enum | see experiment statuses below |
| `created` | date/datetime | ISO |
| `self_judge` | bool | optional, default `false` — allow the judge to be the primary candidate; see the judge rubric |
| `replay_of` | string | optional experiment id |
| `suite_id` | string | optional replay/benchmark suite id |

Body: short task summary, candidate list, judge plan, and any human constraints that should be visible before reading machine artifacts.

### Candidate Artifacts

Each `candidates/<candidate_id>/` folder records the observable output of one candidate:

| File | Meaning |
|------|---------|
| `PATCH.diff` | Candidate patch against `base_commit`; absent or empty only for terminal faults such as `unavailable` |
| `FEEDBACK.md` | Human-readable report from the candidate: what changed, tests, caveats, and handoff notes |
| `METRICS.json` | Machine-readable runtime, cost, timing, token, and status data |
| `TRACE.jsonl` | Optional append-only observable action trace: tools, files, commands, tests, retries, status changes |
| `REASONING.md` | Optional deliberate plan/rationale summary when a runtime exposes one; never required and never private chain-of-thought |

`METRICS.json` includes at least:

```json
{
  "candidate_id": "codex-primary",
  "role": "primary",
  "status": "succeeded",
  "agent_tool": "codex",
  "agent_model": "gpt-5",
  "agent_model_auto": false,
  "agent_model_source": "reported",
  "runtime_version": "",
  "framework": "codex",
  "adapter_version": "",
  "duration_minutes": 0,
  "cost_usd": null,
  "tokens_used": null,
  "fault": null
}
```

Runtime fingerprint fields are shared by candidate and judge records: `agent_tool`, `agent_model`, `agent_model_auto`, `agent_model_source`, `runtime_version`, `framework`, `adapter_version`, `rules_hash`, and `skills_hash`.

### Evaluation Artifacts

Each `evaluation/<judge_id>/` folder records one judge pass. The judge applies `_patterns/experiment-judge.md` (the rubric) via `skills/experiment-judge/SKILL.md` (the procedure) — the same shared-criteria discipline as `_patterns/review-gates.md` at `/tl review`. The judge **must differ from the primary candidate** unless the experiment sets `self_judge: true`.

| File | Meaning |
|------|---------|
| `EVALUATION.md` | Human-readable comparison, per-candidate hard-gate notes, the utility weights used, winner rationale, and review burden |
| `SCORES.json` | Machine-readable per-candidate hard-gate pass, scores, utility, winner, rationale summary, and override metadata |

**Hard gates** are pass/fail and checked first: patch applies, acceptance criteria met, tests pass or declared unavailable, no scope violations, no security/code-standard failures (per `_patterns/review-gates.md`), valid output. A candidate that fails any gate cannot win but is still scored and logged. **Score dimensions** are `correctness`, `completeness`, `scope_discipline`, `maintainability`, `test_quality`, and `explanation_quality`, each an int 1–5 with meanings fixed by the rubric so results are comparable across experiments. **Utility** is a single configurable number — quality score minus cost, latency, feedback (review burden), failure, and scope penalties; the judge records the weights it used in `EVALUATION.md` so a replay is reproducible.

A **faulted** candidate (`over_budget`, `timed_out`, `unavailable`, `invalid_output`, `cancelled`) is scored non-winning with `hard_gates_passed: false` but still recorded — faults are learning data, never dropped. **Tie-breaks** apply in order: hard-gate pass beats fail; then higher utility; then lower review burden; then lower cost; then a human decides (`winner: null`). `winner_set_by` is `judge` normally, or `human` when a person overrides the judge — the override is preserved and logged, exactly like a `priority_set_by: human` triage override.

`SCORES.json` includes at least:

```json
{
  "judge_id": "codex-judge",
  "judge_agent": "codex",
  "status": "succeeded",
  "self_judge": false,
  "winner": "candidate-a",
  "winner_set_by": "judge",
  "rationale": "Candidate A passed all hard gates with lower review burden.",
  "utility_weights": {
    "quality": 1.0,
    "cost_penalty": 0.2,
    "latency_penalty": 0.1,
    "feedback_penalty": 0.2,
    "failure_penalty": 0.3,
    "scope_penalty": 0.2
  },
  "candidates": {
    "candidate-a": {
      "hard_gates_passed": true,
      "fault": null,
      "scores": {
        "correctness": 5,
        "completeness": 5,
        "scope_discipline": 5,
        "maintainability": 4,
        "test_quality": 4,
        "explanation_quality": 5
      },
      "utility": 4.7
    },
    "candidate-b": {
      "hard_gates_passed": false,
      "fault": "timed_out",
      "scores": {
        "correctness": 3,
        "completeness": 2,
        "scope_discipline": 4,
        "maintainability": 3,
        "test_quality": 2,
        "explanation_quality": 3
      },
      "utility": 1.9
    }
  }
}
```

### Experiment Statuses

Experiment and candidate statuses use lowercase strings:

| Status | Meaning |
|--------|---------|
| `queued` | Waiting for a worker or manual action |
| `running` | Actively being produced |
| `succeeded` | Completed and produced valid artifacts |
| `failed` | Finished unsuccessfully with a recorded reason |
| `timed_out` | Stopped after the configured time limit |
| `over_budget` | Stopped after the configured cost/token budget |
| `unavailable` | Required runtime or worker was unavailable |
| `cancelled` | Explicitly stopped by a human or policy |
| `invalid_output` | Output could not be parsed, applied, or judged |
| `awaiting_evaluation` | Candidate runs are terminal and waiting for a judge |

### Winner Application Artifacts

Winner application is the explicit human-controlled step after judging: candidate artifacts are evidence, and only an explicit human action (`tl experiment select|apply|reject|send-to-review`) moves a winning patch toward the canonical repo. Nothing applies automatically. States: `selected`, `applied`, `rejected`, `sent-to-review`, `apply-failed`, and `superseded`.

`WINNER.json` holds the **current** state of the decision for one experiment (the UI winner panel reads it, degrading to the judge's pick when absent); `_metrics/winner-log.jsonl` is the **append-only** decision trail. Rejections and supersessions never delete candidate artifacts.

`WINNER.json` includes at least:

```json
{
  "experiment_id": "exp-1",
  "candidate_id": "cand-a",
  "state": "applied",
  "previous_state": "selected",
  "decided_by": "trevor",
  "decision_source": "human",
  "decided_at": "2026-07-12T12:00:00.000Z",
  "patch_path": "_experiments/exp-1/candidates/cand-a/PATCH.diff",
  "patch_sha256": "9b2e44a1c7f3…",
  "reason": null,
  "error_summary": null,
  "review_artifact": "_experiments/exp-1/APPLICATION.md"
}
```

| Field | Meaning |
|-------|---------|
| `candidate_id` | The selected winning candidate |
| `state` | One of the six winner-application states above |
| `decided_by` / `decision_source` | Who took the action and as what (`human` required for apply) |
| `decided_at` | ISO timestamp of the decision |
| `patch_path` / `patch_sha256` | The exact patch artifact the decision covers (SHA-256 of `PATCH.diff`) |
| `reason` | Required on `rejected` — why the winner was not applied |
| `error_summary` | Set on `apply-failed` — the dry-run/apply error; canonical files are unchanged |
| `review_artifact` | Path to `APPLICATION.md` when one exists |

`APPLICATION.md` is the review artifact created on `applied` and `sent-to-review` (and updated on a later rejection). It points normal TL review back at the experiment index, the winning candidate's artifacts, the judge evaluation, and the decision trail — applied patches are still accepted or kicked back through the ordinary human review gate; the winner workflow never moves specs through their lifecycle by itself.

## Workspace config (`TRIAGE.yml`)

```yaml
focus: ""               # optional — human-owned epoch label (set via /tl goal); stamps goal/override logs
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
auto_review:            # optional — per-type autonomy dial for /tl run's gate
  research: true
  bug: false
  feature: false
  tech_debt: false
  to_done: false        # hard guard, default false — agents never move to done/
run:                    # optional — fan-out width for /tl run and worker ticks
  cap: 4                # calm cap: positive integer; anything else falls back to 4
sync:                   # optional — enables /tl sync (the JIRA shadow layer)
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

**The autonomy dial (`auto_review`).** An optional per-`type` map that lets `/tl run` *fast-track* low-risk spec types at the gate. Each key is a spec `type` (`research` `bug` `feature` `tech_debt`); the value is a bool, **all default `false`** (absent map or absent key = `false` = unchanged behavior). When a completing spec's `type` maps to `true`, `/tl run` still carries it `in-progress → tests → in-review` and **still writes `outcome/FEEDBACK.md` and `outcome/ALIGNMENT.md` first** — but stamps the spec `auto_reviewed: true` so `/tl review` and the cockpit can surface it as a low-risk fast-track candidate (and `cycle-log.jsonl` records `auto_reviewed: true/false` for measuring impact).

`auto_review` **never skips the human gate.** Even with a type set to `true`, `/tl run` lands the spec in `in-review`, not `done` — an agent never signs off its own work. The extra `to_done` guard is a belt-and-suspenders flag: it is `false` and agents must treat it as read-only false; there is no agent path to `done/`. `auto_review: true` means "flagged for a lighter-touch review," not "auto-accepted." (Deviation from the original spec, which proposed `auto_review` landing specs directly in `done/`: capped at `in-review` to keep the human gate intact.)

**The calm cap (`run`).** An optional section bounding how wide a single `/tl run` may fan out (`lib/batch.js` `calmCap`). `run: cap:` bounds **both** halves of a run: how many fresh ready specs one run may claim (`selectBatch`) and how many pending continuations may resume together (`selectContinuations`). Overflow is held, not dropped — the spec or dispatch waits for the next run with the concrete reason `batch capped at <n>`, and a held dispatch stays `pending`. Headless worker ticks read the same dial for fresh-batch selection (`lib/worker.js`), though one tick spawns at most one session. Fallback-on-garbage: the value must be a positive integer — a missing `run:` section, a missing `cap:` key, zero, a negative, a fractional, or a non-numeric value all fall back to the default `4`. Calm over swarm: the cap exists to bound parallelism, so it is never `0` — no cap value disables work (pause lanes with a `PAUSE` file instead).

**Priority epochs (`focus`).** An optional top-level string naming the current priority epoch — a human-owned label tying related weight shifts and overrides together (e.g. `focus: "partner-launch"`). Set via `/tl goal` when rebalancing; absent means no active epoch label. The epoch is **not** a stored period object — it is a join key on append-only logs. When present, `/tl goal` and human priority overrides should stamp the same label on their log lines (`epoch` field, below). `/tl reflect` groups by that label and narrates the span.

**JIRA sync (`sync`).** An optional section enabling `/tl sync` against a JIRA Cloud site (REST API v3 only — not Server/DC). `url` and `project` identify the site and project; `import_filter` is the JQL that scopes what gets imported (default `assignee = currentUser() AND statusCategory != Done`); `map` states the fixed issue-type → primitive mapping (epic → intent, story/task/bug → spec) for legibility. **Credentials never live here** — the API token comes from the environment (`JIRA_EMAIL` / `JIRA_API_TOKEN`) or a credentials file outside the repo, never from `TRIAGE.yml` or any committed file. Section absent = sync disabled; TL is fully functional without it. Algorithm, status/priority mappings, and the `sync-log.jsonl` schema: `skills/sync/SKILL.md`.

## Metrics (`_metrics/*.jsonl`, per workspace)

Append-only, one JSON object per line. Schemas are defined in each skill's SKILL.md. Never edit existing lines; corrections are new lines.

`cycle-log.jsonl` records one line per completed cycle and carries the same four cost signals as FEEDBACK.md, so metrics aggregation reads them from the JSONL without reparsing markdown. Each line includes at least: `spec` (path), `completed` (date), plus the optional `agent_tool` (enum: `claude-code` `cursor` `codex` `windsurf` `other`), `duration_minutes` (number), `cost_usd` (number, estimated), and `tokens_used` (number). Older lines that predate these fields are valid — the fields are optional.

`loop-log.jsonl` (written by `/tl loop`) records one line per loop iteration: `goal` (id), `iteration` (int), `specs_run` (int), `specs_auto_reviewed` (int), `specs_awaiting_review` (int), `key_results_met` (int), `key_results_total` (int). It traces a goal's progress across an autonomous cycle; the human gate still owns `in-review → done`.

`goal-log.jsonl` (written by `/tl goal`) records one line per goal add/rebalance/edit. Fields include: `date`, `action` (`add` `rebalance` `edit`), `goal` (id), `weight` (number — the new weight for the affected goal), `rebalanced` (optional map of goal id → `[old_weight, new_weight]` for every changed goal), `reason` (the human's words), and optional `epoch` (string — join key tying this weight shift to related override lines; defaults to `TRIAGE.yml` `focus` when set). Older lines without `epoch` are valid.

`override-log.jsonl` (written by `/tl triage` on detected human priority changes, and by the cockpit on manual overrides) records one line per override. Fields include: `date`, `spec` (path), `from` (priority), `to` (priority), optional `reason` (the human's why), and optional `epoch` (string — same join key as `goal-log.jsonl`; defaults to `TRIAGE.yml` `focus` when set). Older lines without `epoch` are valid.

`sync-log.jsonl` (written by `/tl sync`) records one line per sync action — imports, pushes, conflicts, offline stops. Fields include: `timestamp`, `direction` (`import` `export` `none`), `action`, `jira_key`, `path`, `detail`. The log doubles as sync memory: the import watermark, already-pushed detection, and conflict detection all read it. Full schema in `skills/sync/SKILL.md`.

The epoch is **derived from shared label + date range**, not declared as a period object. A span is recoverable from `goal-log.jsonl` alone (interval between two rebalances); `epoch` connects an override to the weighting shift that caused it. `/tl reflect` groups lines by `epoch` and narrates priority changes across the span.

### `benchmark-log.jsonl` (H2H agent comparison)

One line per completed spec — the cross-agent benchmarking record. Where `cycle-log.jsonl` measures the *workspace* (throughput per cycle), `benchmark-log.jsonl` measures the *agent*: enough per-run data that "which agent is best for CDK specs? which is cheapest for React components? which stays in scope most reliably?" is answerable from the JSONL alone, segmented by spec type, project, and model. Appended when a spec is accepted at review (`in-review → done`), assembled from data that already exists — spec frontmatter plus `outcome/FEEDBACK.md` — so the line is a side effect of normal use, never a separate data-entry step. The local tool only ever writes this file; any aggregation across workspaces or users is the private repo's job (`docs/repo-split.md`).

| Field | Type | Example | Written by |
|-------|------|---------|-----------|
| `date` | date | `"2026-07-12"` | system — when the line is appended (review acceptance) |
| `spec_slug` | string | `"jira-sync-skill"` | system — the spec's folder name |
| `spec_hash` | string | `"9b2e44a1c7f3"` | system — SHA-256 hex (first 12 chars) of SPEC.md at claim time (`specs/ → in-progress/`). Two runs with the same `spec_hash` did the same task — the controlled variable for H2H comparison. Same meaning as `spec_hash` on experiment records. |
| `spec_type` | enum | `"feature"` | system — the spec's `type`: `feature` `bug` `tech_debt` `research` |
| `project` | string | `"throughline"` | system — workspace name |
| `intent` | path | `"intents/enterprise-offering.md"` | system — the spec's `intent` (`""` if none) |
| `goal_ids` | list | `["cross-agent-reach"]` | system — the parent intent's `goals` (`[]` if no intent) |
| `agent_model` | string | `"claude-fable-5"` | agent — from FEEDBACK.md |
| `agent_tool` | enum | `"claude-code"` | agent — `claude-code` `cursor` `codex` `windsurf` `other` |
| `duration_minutes` | number | `18` | agent — wall-clock minutes to carry the spec to in-review |
| `cost_usd` | number | `0.84` | agent — estimated API cost in USD |
| `tokens_used` | number | `52000` | agent — total tokens consumed |
| `scores` | object | `{"correctness": 5, "completeness": 5, "scope_discipline": 4}` | human — the three ints 1–5 from FEEDBACK.md; the quality half of the comparison |
| `priority_was_right` | bool | `true` | human — from FEEDBACK.md |
| `auto_reviewed` | bool | `false` | system — whether the run fast-tracked this spec at the gate (`auto_review` dial) |

Who writes what, in one line: the **system** fills identity and provenance (`date`, `spec_slug`, `spec_hash`, `spec_type`, `project`, `intent`, `goal_ids`, `auto_reviewed`) mechanically from the spec folder; the **agent** fills the cost side (`agent_model`, `agent_tool`, `duration_minutes`, `cost_usd`, `tokens_used`) via FEEDBACK.md when it lands the spec in in-review; the **human** fills the quality side (`scores`, `priority_was_right`) at review — the same honest-signal discipline as the override log. A value unknown at write time is `null`, never omitted-and-guessed; as everywhere, parsers preserve unknown fields and corrections are new lines.

**Worked example — the same spec run by two agents.** A kickback rerun (or an experiment replay) of `jira-sync-skill` produces two lines with the same `spec_hash`:

```jsonl
{"date":"2026-07-10","spec_slug":"jira-sync-skill","spec_hash":"9b2e44a1c7f3","spec_type":"feature","project":"throughline","intent":"intents/enterprise-offering.md","goal_ids":["cross-agent-reach"],"agent_model":"claude-fable-5","agent_tool":"claude-code","duration_minutes":18,"cost_usd":0.84,"tokens_used":52000,"scores":{"correctness":5,"completeness":5,"scope_discipline":4},"priority_was_right":true,"auto_reviewed":false}
{"date":"2026-07-11","spec_slug":"jira-sync-skill","spec_hash":"9b2e44a1c7f3","spec_type":"feature","project":"throughline","intent":"intents/enterprise-offering.md","goal_ids":["cross-agent-reach"],"agent_model":"gpt-5","agent_tool":"codex","duration_minutes":11,"cost_usd":0.31,"tokens_used":29000,"scores":{"correctness":4,"completeness":4,"scope_discipline":5},"priority_was_right":true,"auto_reviewed":false}
```

Matching `spec_hash` means the task was identical, so every other column is a fair comparison: claude-code scored higher on correctness and completeness (5/5 vs 4/4) but cost 2.7× more ($0.84 vs $0.31) and took 1.6× longer (18 min vs 11); codex stayed in scope better (5 vs 4). One pair proves nothing — but grouped by `spec_type` across many lines, these columns become "claude-code wins on feature-spec quality, codex wins on cost, and scope discipline is a wash," which is exactly the question the paid analytics product answers at aggregate scale.

Experiment logs are append-only JSONL under `_metrics/`. Markdown artifacts explain what happened for humans; JSON and JSONL records are the learning/querying surface.

`candidate-run-log.jsonl` records one line per candidate attempt. Fields include: `date`, `experiment_id`, `task_type`, `tl_spec`, `spec_hash`, `base_commit`, `candidate_id`, `role` (`primary` or `shadow`), `status`, `fault`, `agent_tool`, `agent_model`, `agent_model_auto`, `agent_model_source`, `runtime_version`, `framework`, `adapter_version`, `rules_hash`, `skills_hash`, `duration_minutes`, `cost_usd`, `tokens_used`, `patch_path`, and `trace_path`.

`judge-log.jsonl` records one line per judge run. Fields include: `date`, `experiment_id`, `judge_id`, `judge_agent`, `judge_model`, `status`, `winner`, `winner_set_by` (`judge` or `human`), `rationale`, `scores_path`, `evaluation_path`, `utility`, `hard_gates_passed`, `duration_minutes`, `cost_usd`, and `tokens_used`.

`experiment-log.jsonl` records one line per experiment lifecycle transition. Fields include: `date`, `experiment_id`, `task_type`, `tl_spec`, `spec_hash`, `base_commit`, `primary_agent`, `shadow_agents`, `judge_agent`, `status`, `previous_status`, `replay_of`, `suite_id`, and `reason`.

`winner-log.jsonl` records one line per winner-application decision (select, apply, reject, send-to-review, apply-failed, superseded) — append-only; `WINNER.json` carries only the current state. Fields include: `date`, `experiment_id`, `tl_spec`, `base_commit`, `candidate_id`, `state`, `previous_state`, `decided_by`, `decision_source`, `decided_at`, `patch_path`, `patch_sha256`, `reason`, `error_summary`, and `review_artifact`.

`routing-priors.jsonl` records local transparent routing evidence. Fields include: `date`, `context_key`, `agent_tool`, `agent_model`, `runtime_fingerprint`, `expected_quality`, `expected_cost`, `expected_latency`, `success_rate`, `samples`, `last_updated`, and `source`.

`replay-log.jsonl` records benchmark/replay comparisons. Fields include: `date`, `experiment_id`, `replay_of`, `suite_id`, `candidate_id`, `previous_winner`, `new_winner`, `utility_delta`, `quality_delta`, `cost_delta`, `latency_delta`, and `promotion_recommendation`.

`trace-features.jsonl` records derived trace features for learning without rereading full traces. Fields include: `date`, `experiment_id`, `candidate_id`, `event_count`, `tool_calls`, `test_iterations`, `first_test_at_ms`, `replan_count`, `backtrack_count`, `scope_violations`, and `human_intervention_count`.

## Spec notes (`<stage>/<slug>/NOTES.md`, optional)

Append-only human feedback on a spec, left from the cockpit while work is in flight. Each note is a small dated section (`## YYYY-MM-DD — note`, or `— kicked back` for a review rejection). The file lives in the spec's own folder, so it travels with the spec through every stage. `/tl run` reads it as binding context (treat it like the acceptance criteria); `/tl review` surfaces it. There is no queue for *new* work — the `ready/` stage **is** the queue, the stage folders **are** the status, and the cockpit's write actions are review (accept / kick back) and notes. The one dispatch artifact that exists is the **continuation** trigger a kickback leaves behind (next section): it resumes already-claimed work, it never starts fresh work.

## Continuation dispatches (`_dispatch/<slug>.json`)

The continuation half of dispatch. When work moves *backwards* (`in-review/ → in-progress/` on a kickback) or is left mid-flight with binding `NOTES.md`, the kickback writes a small JSON trigger so the next `/tl run` — including a scheduled headless session — resumes that spec without a human re-assembling context. Files only; no server-side execution.

```json
{
  "spec": "<slug>",
  "mode": "continuation",
  "stage": "in-progress",
  "notes_path": "<slug>/NOTES.md",
  "status": "pending",
  "created": "YYYY-MM-DD",
  "reason": "kicked back: <first line of the note>"
}
```

- `mode` is always `"continuation"` — fresh ready work is claimed from `specs/` directly, never via `_dispatch/`.
- `stage` names the folder the spec now sits in (`in-progress`, or `tests` for a blocked tests-gate handoff); `notes_path` is relative to that stage folder.
- `status` lifecycle: `pending → claimed → done|failed`. The resuming agent flips it to `claimed` before working, and `done` once the spec is out of its hands: it reaches `in-review/`, **or** it stops at the **verifier hand-off** — `tests/` with `awaiting_verifier: true` and a `VERIFY.md` request (the verification enforcement above). The hand-off is a healthy completion of the continuation — the remaining path to `in-review/` belongs to `tl verify`, not another resume — so an awaiting-verifier stop is never `failed`. `failed` is reserved for a genuine stall: the spec ends blocked with no verifier hand-off. Transitions only — never delete the file; `_dispatch/` stays auditable.
- Idempotent: re-writing the same pending file (a second kickback before anyone resumed) is fine — one file per slug.
- `/tl run` prefers pending continuations over fresh ready claims: the run banner surfaces the spec and its `NOTES.md` excerpt, and ready specs wait for the next run. A pending continuation whose spec is no longer in `in-progress/` or `tests/` is stale — mark it `done` (accepted meanwhile) or `failed`.

## Headless lanes (`lanes:` in `TRIAGE.yml`, `bin/tl-worker.js`)

The scheduling half of cross-agent dispatch: `node bin/tl-worker.js <workspace> --agent <lane>` performs **one worker tick** — if the lane has eligible run work (a pending continuation it owns first, then at most one conflict-free ready spec in its lane), it launches the lane's configured agent CLI once with the `tl run` brief as the prompt, logs the session, and exits. Cron/launchd owns the interval; the driver never moves a spec, never advances a stage, and the spawned session stops at `in-review/` as always. v1 schedules the **run lane only** — verifier scheduling (`tl verify`) is a separate tick. Recipes and the operational model live in `docs/headless-lanes.md`.

**`lanes:` config.** A lane is any shell command — tl ships no provider integrations. Per-lane keys are path-safe lane names matching spec `agent:` / `claimed_by` values: lowercase letters, numbers, dots, underscores, and hyphens only.

```yaml
lanes:
  claude:
    command: "claude -p {prompt_file}"    # {prompt_file} → path to the brief temp file
    lock_timeout_minutes: 120             # optional — stale-lock takeover threshold (default 120)
  codex:
    command: "codex exec --sandbox workspace-write -"   # no placeholder → brief arrives on stdin
```

Prompt delivery, in order: `{prompt_file}` in the command is substituted with the shell-escaped path of the brief written to `_metrics/worker-prompts/<lane>-<timestamp>.txt`; `{prompt}` is substituted with a shell-escaped **single-line** form of the brief (lossy — prefer `{prompt_file}`); a command with neither placeholder receives the brief bytes on stdin. Workspace artifacts (prompts, locks, logs) live under `projects/<name>/`, which is already gitignored. An unconfigured lane is a hard error: exit `1`, nothing executes.

**Continuation ownership (lane filter).** A pending continuation is eligible for lane `<lane>` only when ownership matches: if the linked spec has `claimed_by`, that value must equal `<lane>` — `agent: any` never overrides an existing claim. Only when unclaimed does the routing lane (`agent: <lane>` or `any`) decide. While another lane's continuation is pending, a tick claims **no** fresh ready work (matching `/tl run`, which holds the ready queue behind any pending continuation) and exits `0` with reason `no_continuation`.

**Safety.** A workspace-root `PAUSE` file halts all lanes (exit `2`, no spawn). A per-lane JSON lock at `_metrics/locks/<lane>.lock` — containing at least `date`, `workspace`, `lane`, `pid`, `picked`, `prompt_path` — is created immediately before the spawn and removed after the child exits (success or failure); a lock younger than the stale timeout means exit `2` without spawning, an older one is taken over (logged). Staleness is judged by file mtime, so a corrupt lock still times out. `--dry-run` prints the exact command and prompt delivery, exits `0`, and writes **nothing** — no prompt file, no lock, no log line.

**Exit codes.** `0` — no work (quiet cron) or child exited 0; `1` — lane misconfigured, `tl run` subprocess failure, spawn failure, or child exited non-zero; `2` — `PAUSE` present or lock held.

**`worker-log.jsonl`** (`_metrics/worker-log.jsonl`, append-only): one line per non-dry tick — `date`, `workspace`, `lane`, `picked` (spec path, `_dispatch/<slug>.json`, or `none`), `spawned` (bool), `exit_code` (the tick's exit code), `duration_seconds`, and `reason` when not spawned (`no_continuation` `no_ready` `paused` `locked` `lane_unconfigured` `tl_run_failed` `spawn_failed`). Extra fields appear when relevant (`child_exit_code`, `stale_lock_takeover`); a lock-cleanup failure appends its own `event: lock_cleanup_failed` line. As everywhere: never edit existing lines.

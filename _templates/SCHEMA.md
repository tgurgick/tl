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

**Agent routing.** `agent` is a lane hint for heterogeneous fan-out. `tl run --agent <name>` claims only specs whose `agent` is `<name>` or `any` — so Claude, Codex, and Cursor can each drain their own lane concurrently over one throughline, coordinated by the folder-move claim (`specs/ → in-progress/` is the lock — whoever moves it first owns the spec; no central orchestrator). Absent or `any` = runnable by whichever agent picks it up.

**Claim ownership.** `agent` is the *lane* (who a spec is routed to, author-set, often `any`); `claimed_by` is *who actually grabbed it* — stamped by the claiming agent when it moves the spec `specs/ → in-progress/` (with `claimed_at`). Because the folder move alone is anonymous, `claimed_by` is what makes concurrent multi-agent work legible: the cockpit shows it as the live owner on in-progress/tests/in-review cards, so a human can see *which* agent has picked up *which* task. It **identifies the builder** at the TESTS gate — the cross-model verifier must pick a checker that is *not* `claimed_by` (the verifier must differ; see `alt-model-alignment-check` and the alignment record below). Falls back to `agent` when a spec predates claim-stamping.

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

Winner application states are reserved for later workflow specs: `selected`, `applied`, `rejected`, `sent-to-review`, `apply-failed`, and `superseded`.

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
auto_review:            # optional — per-type autonomy dial for /tl run's gate
  research: true
  bug: false
  feature: false
  tech_debt: false
  to_done: false        # hard guard, default false — agents never move to done/
```

**The autonomy dial (`auto_review`).** An optional per-`type` map that lets `/tl run` *fast-track* low-risk spec types at the gate. Each key is a spec `type` (`research` `bug` `feature` `tech_debt`); the value is a bool, **all default `false`** (absent map or absent key = `false` = unchanged behavior). When a completing spec's `type` maps to `true`, `/tl run` still carries it `in-progress → tests → in-review` and **still writes `outcome/FEEDBACK.md` and `outcome/ALIGNMENT.md` first** — but stamps the spec `auto_reviewed: true` so `/tl review` and the cockpit can surface it as a low-risk fast-track candidate (and `cycle-log.jsonl` records `auto_reviewed: true/false` for measuring impact).

`auto_review` **never skips the human gate.** Even with a type set to `true`, `/tl run` lands the spec in `in-review`, not `done` — an agent never signs off its own work. The extra `to_done` guard is a belt-and-suspenders flag: it is `false` and agents must treat it as read-only false; there is no agent path to `done/`. `auto_review: true` means "flagged for a lighter-touch review," not "auto-accepted." (Deviation from the original spec, which proposed `auto_review` landing specs directly in `done/`: capped at `in-review` to keep the human gate intact.)

## Metrics (`_metrics/*.jsonl`, per workspace)

Append-only, one JSON object per line. Schemas are defined in each skill's SKILL.md. Never edit existing lines; corrections are new lines.

`cycle-log.jsonl` records one line per completed cycle and carries the same four cost signals as FEEDBACK.md, so metrics aggregation reads them from the JSONL without reparsing markdown. Each line includes at least: `spec` (path), `completed` (date), plus the optional `agent_tool` (enum: `claude-code` `cursor` `codex` `windsurf` `other`), `duration_minutes` (number), `cost_usd` (number, estimated), and `tokens_used` (number). Older lines that predate these fields are valid — the fields are optional.

`loop-log.jsonl` (written by `/tl loop`) records one line per loop iteration: `goal` (id), `iteration` (int), `specs_run` (int), `specs_auto_reviewed` (int), `specs_awaiting_review` (int), `key_results_met` (int), `key_results_total` (int). It traces a goal's progress across an autonomous cycle; the human gate still owns `in-review → done`.

Experiment logs are append-only JSONL under `_metrics/`. Markdown artifacts explain what happened for humans; JSON and JSONL records are the learning/querying surface.

`candidate-run-log.jsonl` records one line per candidate attempt. Fields include: `date`, `experiment_id`, `task_type`, `tl_spec`, `spec_hash`, `base_commit`, `candidate_id`, `role` (`primary` or `shadow`), `status`, `fault`, `agent_tool`, `agent_model`, `agent_model_auto`, `agent_model_source`, `runtime_version`, `framework`, `adapter_version`, `rules_hash`, `skills_hash`, `duration_minutes`, `cost_usd`, `tokens_used`, `patch_path`, and `trace_path`.

`judge-log.jsonl` records one line per judge run. Fields include: `date`, `experiment_id`, `judge_id`, `judge_agent`, `judge_model`, `status`, `winner`, `winner_set_by` (`judge` or `human`), `rationale`, `scores_path`, `evaluation_path`, `utility`, `hard_gates_passed`, `duration_minutes`, `cost_usd`, and `tokens_used`.

`experiment-log.jsonl` records one line per experiment lifecycle transition. Fields include: `date`, `experiment_id`, `task_type`, `tl_spec`, `spec_hash`, `base_commit`, `primary_agent`, `shadow_agents`, `judge_agent`, `status`, `previous_status`, `replay_of`, `suite_id`, and `reason`.

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
- `status` lifecycle: `pending → claimed → done|failed`. The resuming agent flips it to `claimed` before working, `done` when the spec reaches `in-review/`, `failed` if it ends blocked. Transitions only — never delete the file; `_dispatch/` stays auditable.
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

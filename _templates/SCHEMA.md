# Frontmatter schema

The contract between the markdown files, the skills, and any UI. One file = one record; YAML frontmatter is the machine-readable part, the body is for humans and agents. Parsers must preserve unknown fields. Enums are lowercase. Dates are ISO (`YYYY-MM-DD`).

## Folder semantics

A spec's lifecycle stage is its folder, inside a workspace (`projects/<name>/`):

| Folder | Meaning |
|--------|---------|
| `triage/` | Spec held for shaping — blocked on a human action (decision, scope, research, rule flag); not authorized to run |
| `intents/` | Human objectives |
| `specs/` | Agent-ready, not started (`status: ready` or `blocked`) |
| `in-progress/` | Being worked |
| `tests/` | Code complete, the test/verification gate (CI or acceptance tests) — auto gate |
| `in-review/` | Tests green, awaiting human sign-off — the human gate, has `outcome/FEEDBACK.md` |
| `done/` | Reviewed and accepted |
| `threads/` | Anything worth remembering that isn't active work |
| `_dispatch/` | Continuation triggers — one JSON file per kicked-back/mid-flight spec awaiting resume (see below) |

If `status` and folder disagree, the folder wins; skills fix the field to match.

A spec can be held for shaping before it runs: `triage → ready → in-progress → tests → in-review → done`. `triage/` is the shaping hold pen, not the run queue: `/tl triage` is the sole writer that routes unauthorized specs there with a `hold_reason`; `/tl run` only claims from `specs/`. Releasing shaped work means moving `triage/<slug>/ → specs/<slug>/`, setting `status: ready`, and clearing `hold_reason`. An agent (`/tl run`) carries work as far as `in-review`; only a human (or `/tl review`) promotes `in-review → done`. The in-review gate is what makes parallel fan-out safe — many agents land their work in `in-review`, where it's signed off in a batch rather than merged blind. `threads/` keeps sole ownership of "idea under evaluation"; `triage/` is for agent-ready specs that still need a human-shaped fix before they may run.

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
| `claimed_model` | string | optional — model identity at claim time, e.g. `claude-fable-5` `gpt-5` `composer-1`; absent = unknown, never guessed | claiming agent |
| `accepted_by` | enum | optional — `human-cockpit` (cockpit accept) `human-cli` (`/tl review` accept) | review gate |
| `accepted_at` | datetime | optional — full ISO timestamp of the accept | review gate |
| `kicked_back_by` | enum | optional — `human-cockpit` `human-cli` — who kicked it back at review | review gate |
| `kicked_back_at` | datetime | optional — full ISO timestamp of the kick-back | review gate |
| `gate` | enum | optional — `verified` `unverified` — `canAdvanceToReview` result at the last review decision | review gate |
| `jira_key` | string | optional — JIRA issue key this spec mirrors, e.g. `PROJ-123` | sync / author |
| `jira_url` | string | optional — the JIRA issue's browse URL | sync / author |
| `hold_reason` | string | optional — short literal why this spec sits in `triage/` (e.g. rule flag, undeclared scope, unmet research dependency, failed asset preflight); cleared on release to `specs/` | triage / human |

**Agent routing.** `agent` is a lane hint for heterogeneous fan-out. `tl run --agent <name>` claims only specs whose `agent` is `<name>` or `any` — so Claude, Codex, and Cursor can each drain their own lane concurrently over one throughline, coordinated by the folder-move claim (`specs/ → in-progress/` is the lock — whoever moves it first owns the spec; no central orchestrator). Absent or `any` = runnable by whichever agent picks it up.

**Claim ownership.** `agent` is the *lane* (who a spec is routed to, author-set, often `any`); `claimed_by` is *who actually grabbed it* — stamped by the claiming agent when it moves the spec `specs/ → in-progress/` (with `claimed_at`). Because the folder move alone is anonymous, `claimed_by` is what makes concurrent multi-agent work legible: the cockpit shows it as the live owner on in-progress/tests/in-review cards, so a human can see *which* agent has picked up *which* task. It **identifies the builder** at the TESTS gate — the cross-model verifier must pick a checker that is *not* `claimed_by` (the verifier must differ; see `alt-model-alignment-check` and the alignment record below). Falls back to `agent` when a spec predates claim-stamping.

**Model at claim (`claimed_model`).** `claimed_by` names the *tool*; `claimed_model` names the *model* that tool is running (cursor may be composer or a GPT; claude may be any Claude model) — stamped in the same frontmatter pass as `claimed_by`/`claimed_at` when the claiming agent knows its model, so identity is tool+model from the *start* of a build, matching how the experiment engine and `benchmark-log.jsonl` already key on model as primary identity. Sources, in order of honesty: what the agent knows it is; else the lane-configured identity a headless brief carries (`lanes.<name>.model`, below). **Absent = unknown, never guessed** — Cursor auto mode (and any agent that can't confirm its model) leaves it unset rather than inventing one; same discipline as the experiment fingerprint's `agent_model: unknown`. It is the early signal, not the verdict: FEEDBACK.md `agent_model` at the tests gate stays ground truth, and a mismatch between the two is legible data (the lane was mislabeled, or the tool switched models mid-build), never something to retro-edit. Reclaim's advance-to-tests path leaves it untouched with `claimed_by`/`claimed_at` (builder attribution); a fresh claim after kick-back or return-to-ready re-stamps it like `claimed_by`.

Bug specs add: `source` (`sentry` `datadog` `manual`), `source_id`, `source_url`, `affected_users` (int), `first_seen` (date).

**The JIRA bridge (`jira_key` / `jira_url`).** `jira_key` links a spec (or intent, below) to the JIRA issue it mirrors — written by `/tl sync` on import, or by hand to link work born locally. It is the sync dedup key: one JIRA issue maps to at most one spec or intent, and `/tl sync` updates a matched record rather than recreating it. `jira_url` is the human-clickable browse URL. Both optional; absent means the record has no JIRA counterpart and sync leaves it alone. The link lives entirely in frontmatter — TL works fully offline and never depends on JIRA being reachable (algorithm: `skills/sync/SKILL.md`).

**Reviewer provenance (`accepted_by` / `accepted_at` / `kicked_back_by` / `kicked_back_at` / `gate`).** Every review decision — cockpit `/api/review` or the `/tl review` CLI path — stamps who made it and when, and appends one row to `_metrics/review-log.jsonl` (schema under Metrics, below), so a human accept is distinguishable from an agent folder-move after the fact (incident: `threads/2026-07-14-judge-drain-stage-advance-without-verification.md` — a `done/` hop with no stamp and no log line took a human interview to attribute). `gate` records what `lib/verification-gate.js` `canAdvanceToReview` said at the moment of the decision: `verified` = the gate passed; `unverified` = it failed (e.g. no `outcome/ALIGNMENT.md` under `require_independent_verifier`) but the human decided anyway. `gate: unverified` is a **visible flag, never a block** — the human's call outranks the gate, this just makes the gap readable off the artifact. Recording only: accept semantics are unchanged, and historical `done/` specs without these stamps remain valid (pre-stamp accepts are grandfathered — absence means "predates the audit line," never "invalid"; do not retro-stamp).

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

Body sections follow `_templates/FEEDBACK.md`; Resume reads the **What shipped** section for its value line (falls back to Asked vs. delivered when absent).

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
| `remediation_files` | list | paths the verifier (or builder-on-kickback) changed during fix-forward, derived from `outcome/REMEDIATION.diff`; `[]` when that diff is empty |
| `remediation_lines` | int | added + removed line count in `outcome/REMEDIATION.diff`; `0` when the verifier changed nothing |

Body: one short section per round — what the verifier raised, and how the builder addressed it. On `residual-concerns` the open items are the flag the human reads at `/tl review`; the human gate is never removed, only better-informed. Absent = no cross-model check ran (older, pre-gate specs — grandfathered at review, treated like self-check).

**Authorship diffs (`outcome/BUILDER.diff` / `outcome/REMEDIATION.diff`).** Alongside FEEDBACK and ALIGNMENT, the outcome folder may hold two text diffs that keep builder and verifier edits attributable:

| Artifact | Written when | Content |
|----------|--------------|---------|
| `outcome/BUILDER.diff` | Builder hand-off — when stamping `awaiting_verifier: true` (`skills/run/SKILL.md`) | `git diff` of the tree at that moment (pre-verification builder state) |
| `outcome/REMEDIATION.diff` | Verifier Record step (`skills/verify/SKILL.md`) | Delta **since** `BUILDER.diff`; empty when the verifier changed nothing |

A non-empty `REMEDIATION.diff` means a defect escaped the builder into the verifier's hands — the measurable signal behind a future `benchmark-log.jsonl` field `defects_escaped_to_verifier` (cross-ref only here; adding that field belongs to the benchmark-log writer, not this contract). Fix-forward policy itself is unchanged by these artifacts.

**Enforcement (`verification` in `TRIAGE.yml`).** The gate that makes the above policy, not convention (`lib/verification-gate.js` `canAdvanceToReview`; incident: `done/allocation-actionable-prompt` advanced with `builder == verifier == codex`):

```yaml
verification:
  require_independent_verifier: true   # builder ≠ verifier required to advance tests → in-review
  allow_self_check_for: []             # spec types exempt (e.g. [research]); empty = none
  verifier_lanes:                      # isolated verifier dispatch (lib/worker.js verifyTick)
    gemini:
      agent: gemini                    # stamped as verified_by; must ≠ claimed_by
      mode: verify                     # verify | review-only
      isolated: true                   # required — disposable worktree only
      sandbox: required                # required | true
      allow_network: false             # Gemini: true is rejected loudly
      allow_commands: []               # TL-run acceptance commands in the worktree
      command: [agy]                   # optional invocation prefix
```

When required and no independent verifier is available, the builder **stops at `tests/`** (`status: blocked`) instead of self-verifying: it writes `outcome/FEEDBACK.md`, snapshots `git diff > outcome/BUILDER.diff`, sets spec frontmatter `awaiting_verifier: true` + `requested_at: YYYY-MM-DD`, and writes a minimal `VERIFY.md` request (builder, date, anything to flag) in the spec folder. `tl verify [ws] [--agent <name>]` lists these for any agent that is **not** the builder; `tl verify --execute` (or the scheduled `tl-worker --mode verify` tick) claims at most one eligible spec through a configured `verifier_lanes` entry, never the builder's own, under a per-spec lock at `_metrics/verify-locks/<slug>.lock`. Cockpit **Dispatch verify** only writes `_metrics/verify-requests/*.json` (target lane ≠ `claimed_by`, or `any-other`) — the UI/server never spawn agent CLIs. A clean isolated pass advances `tests → in-review` with `verified_by` / `verification_type: independent`. Mutation proposals become `human-decision-required` and stay at `tests/` until an explicit human choice (`authorize-fix-forward` or `kick-back`) — never auto-applied. Failures leave the spec in `tests/` with an auditable `blocked_reason`. Unsafe Gemini configs (missing `isolated`/`sandbox`, `allow_network: true`, `--dangerously-skip-permissions`) are rejected loudly at config/read time. A section absent from `TRIAGE.yml` means the gate is not enforced (pre-gate workspaces unchanged).

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
│   ├── TRACE.jsonl          # append-only observable action trace (required for candidate runs)
│   └── REASONING.md         # optional; deliberate summaries only, never private chain-of-thought
├── evaluation/<judge_id>/
│   ├── EVALUATION.md
│   ├── SCORES.json
│   └── JUDGE-BRIEF.md       # headless deterministic judge: dimensions needing model judgment
├── WINNER.json              # optional; current winner-application state (explicit human decisions only)
└── APPLICATION.md           # optional; review artifact written on apply / send-to-review
```

### Queue layout (workspace-level)

The headless queue is **workspace-scoped**, not per-experiment: files live under `_experiments/queue/` (sibling to `_experiments/<experiment_id>/`). Initiation, claim atomicity, lane draining, and fault posture are documented in `docs/agent-experiments.md` ("Initiation and Headless Workers") — SCHEMA only names the on-disk contract.

| Path | Role |
|------|------|
| `_experiments/queue/<experiment_id>.jsonl` | Append-only, event-sourced candidate rows; newest row per candidate is current state |
| `_experiments/queue/claims/<exp>--<cand>--<attempt>.claim` | Exclusive-create claim markers (`O_EXCL`) — the atomic bit of a local claim |
| `_experiments/queue/<stamp>-<slug>.json` | Request configs (UI/CLI); rewritten `status: accepted\|invalid` with `experiment_id`, never deleted |

Every queue row carries at least: `experiment_id`, `candidate_id`, `role` (`primary` / `shadow` / `judge`), `agent_tool`, `agent_model_requested`, `status`, `attempt`, `budget_usd`, `timeout_minutes`, `created`. Transition and claim rows also carry `ts`, `claimed_by`, `fault`, `reason`, and a runner `config` object so a drain is self-contained.

**Execution trust boundary (`lib/env-policy.js`).** Candidate and judge commands run in an **isolated checkout** (detached worktree/clone) — isolation protects the canonical repo from edits; it is **not a security sandbox**, and the spawned process keeps full filesystem read, network, and host authority. The boundaries tl enforces:

- **Environment scrub by default.** Every spawn gets a scrubbed environment: credential-shaped variables (vendor prefixes `ANTHROPIC_`/`CLAUDE_`/`OPENAI_`/`JIRA_`/`AWS_`/…, secret name segments `TOKEN`/`SECRET`/`KEY`/`AUTH`/`PASSWORD`/…, plus `SSH_AUTH_SOCK`) never reach candidate or judge commands ambiently. The judge's `--test-command` (which executes the candidate's **patched code**) runs scrubbed too.
- **Per-lane allowlist.** Each provider lane receives back exactly its own auth variables (`LANE_ENV_ALLOWLIST`: claude → `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_*`, codex → `OPENAI_API_KEY`/`CODEX_HOME`, gemini → `GEMINI_API_KEY`/`GOOGLE_*`, cursor → `CURSOR_API_KEY`); `shell` receives none. Rows widen the boundary only via explicit scoped config: `config.pass_env` (ambient names to pass through) and `config.env` (explicit values over the scrubbed base). Passed-through **names** are logged; **values** are redacted by exact match from `FEEDBACK.md` and `PATCH.diff` before write, complementing the trace redaction below.
- **Unsandboxed shell fails closed.** A `shell` row runs an arbitrary `config.command` on the host — trusted-code execution, so it requires the explicit opt-in `config.unsafe_host_exec: true` on the row (auditable in the append-only queue) or `tl experiment drain --unsafe-host-exec`; absent, the row terminates `failed` with a concrete message **before** the command runs. Configuring a judge `--test-command` is the equivalent explicit trust decision for judge-side execution; no test command = nothing executes (`tests_pass: null`).

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
| `TRACE.jsonl` | Append-only observable action trace: tools, files, commands, tests, retries, status changes (see below) |
| `REASONING.md` | Optional deliberate plan/rationale summary when a runtime exposes one; never required and never private chain-of-thought |

`METRICS.json` includes at least:

```json
{
  "candidate_id": "codex-primary",
  "role": "primary",
  "status": "succeeded",
  "agent_tool": "codex",
  "agent_model": "gpt-5",
  "agent_model_requested": "gpt-5",
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

Runtime fingerprint fields are shared by candidate and judge records: `agent_tool`, `agent_model`, `agent_model_auto`, `agent_model_source`, `runtime_version`, `framework`, `adapter_version`, `rules_hash`, and `skills_hash`. Candidate `METRICS.json` also records `agent_model_requested` (what was asked for — display `auto` under Cursor auto mode) alongside the resolved `agent_model`.

**Cursor auto model visibility.** When the lane is Cursor with no explicit model (or the requested model is `auto`), set `agent_model_auto: true` and `agent_model_requested: "auto"`. Capture the resolved model when an SDK, hook, or session report exposes it; otherwise leave `agent_model` as `unknown`. Record `agent_model_source` as one of `sdk` | `hook` | `reported` | `unknown` (plus `requested` / `fixture` / `none` for non-auto paths, and `unfulfilled-request` — see below). Never invent a resolved model from chain-of-thought.

**Unfulfilled model requests.** `requested` may only be recorded when the requested model was actually transmitted to the provider CLI. Until a per-provider model flag exists in the adapter, a cohort's requested model is NOT passed — the CLI runs on its own default — and the record must say so: `agent_model_requested` keeps what was asked for, the resolved `agent_model` stays `unknown` with `agent_model_auto: true`, and `agent_model_source` is `unfulfilled-request` (`lib/experiment-runner.js`). A fingerprint never claims a model identity the run did not use — benchmark comparisons and routing priors train on these fields.

#### `TRACE.jsonl` (candidate action trace)

Append-only JSONL under each candidate folder. Privacy boundary matches the non-experiment activity-trace contract: **required** = observable actions; **optional** = deliberate plan/reasoning summaries a runtime reports; **never** = private chain-of-thought.

Common event fields (every row):

| Field | Type | Meaning |
|-------|------|---------|
| `ts` | datetime | ISO timestamp |
| `type` | string | event type (tables below) |
| `agent_tool` | string | lane / tool identity |
| `agent_model` | string | resolved model when known |
| `agent_model_auto` | bool | true when Cursor (or similar) auto-selected the model |
| `agent_model_source` | string | `sdk` / `hook` / `reported` / `requested` / `unfulfilled-request` / `unknown` / … |
| `source` | string | who emitted the event (`runner`, `adapter`, `sdk`, …) |
| `duration_ms` | number/null | optional duration for this step |
| `status` | string | run-relative status at emit time (`running`, terminal status, …) |
| `summary` | string | short observable action summary (secret-redacted before write) |

Event-specific payload keys (e.g. `command`, `path`, `fault`, `scope_violation`) ride alongside the common fields.

**Required event types** (documented; local runner emits where possible via `lib/experiment-trace.js` + `lib/experiment-runner.js`): `start`, `plan_summary`, `tool`, `file_read`, `file_write`, `test`, `command`, `patch`, `status`, `fault`, `finish`.

**Optional event types** (never required for a valid candidate): `reasoning_summary`, `replan`, `backtrack`, `human_intervention`.

**Redaction before write.** `lib/experiment-trace.js` redacts env-style credential assignments (`API_KEY=…`, `SECRET=…`, …) and known secret patterns (API keys, tokens, JWTs, bearer/password assignments) to `[redacted]` before appending any event. Traces are learning inputs; secrets must not land on disk.

Derived learning rows land in `_metrics/trace-features.jsonl` (see Learning Surfaces below) without rereading full traces.

### Evaluation Artifacts

Each `evaluation/<judge_id>/` folder records one judge pass. The judge applies `_patterns/experiment-judge.md` (the rubric) via `skills/experiment-judge/SKILL.md` (the procedure) — the same shared-criteria discipline as `_patterns/review-gates.md` at `/tl review`. The judge **must differ from the primary candidate** unless the experiment sets `self_judge: true`. Headless drain also runs a deterministic judge (`lib/experiment-judge.js`) that writes the same folder shape plus `JUDGE-BRIEF.md` (see below).

| File | Meaning |
|------|---------|
| `EVALUATION.md` | Human-readable comparison, per-candidate hard-gate notes, the utility weights used, winner rationale, and review burden |
| `SCORES.json` | Machine-readable per-candidate hard-gate pass, scores, utility, winner, rationale summary, and override metadata |
| `JUDGE-BRIEF.md` | Lane-agnostic brief (headless deterministic judge): lists rubric dimensions that still need model judgment so any lane or `skills/experiment-judge` can refine without rewriting the deterministic folder |

**Hard gates** are pass/fail and checked first: patch applies, acceptance criteria met, tests pass or declared unavailable, no scope violations, no security/code-standard failures (per `_patterns/review-gates.md`), valid output. A candidate that fails any gate cannot win but is still scored and logged. **Score dimensions** are `correctness`, `completeness`, `scope_discipline`, `maintainability`, `test_quality`, and `explanation_quality`, each an int 1–5 with meanings fixed by the rubric so results are comparable across experiments. **Utility** is a single configurable number — quality score minus cost, latency, feedback (review burden), failure, and scope penalties; the judge records the weights it used in `EVALUATION.md` so a replay is reproducible.

A **faulted** candidate (`over_budget`, `timed_out`, `unavailable`, `invalid_output`, `cancelled`) is scored non-winning with `hard_gates_passed: false` but still recorded — faults are learning data, never dropped. **Tie-breaks** apply in order: hard-gate pass beats fail; then higher utility; then lower review burden; then lower cost; then a human decides (`winner: null`). `winner_set_by` is `judge` normally, or `human` when a person overrides the judge — the override is preserved and logged, exactly like a `priority_set_by: human` triage override.

**Additive parser posture.** Parsers preserve unknown `SCORES.json` / evaluation fields — new keys are additive and never break older readers. The headless deterministic judge may write extra top-level and per-candidate fields beyond the minimum below; consumers treat missing keys as absent, never as hard failures.

**Headless / deterministic extras** (written by `lib/experiment-judge.js` when `tl experiment drain` executes judge rows — CLI default; `--skip-judges` leaves them queued):

| Field | Where | Meaning |
|-------|-------|---------|
| `judge_model` | top-level | e.g. `"deterministic"` for the code judge |
| `scored_by` | top-level | `"deterministic"` when baselines came from code, not a model/human pass |
| `model_judgment_pending` | top-level | dimensions still needing model judgment (today: `correctness`, `completeness`, `scope_discipline`, `maintainability`) |
| `brief_path` | top-level | workspace-relative path to this folder's `JUDGE-BRIEF.md` |
| `gates` | per candidate | `{ valid_output, patch_applies, tests_pass }` each `true` \| `false` \| `null` — `null` = declared unavailable / unchecked and **never fails** the candidate |
| `cost_usd` / `duration_minutes` | per candidate | carried onto the scores surface for utility / learning readers |

Gate semantics worth stating: `patch_applies: false` stamps the candidate `fault: invalid_output` (per the rubric); `null` gates are recorded honestly and do not fail. Refining a deterministic baseline writes a **new** `evaluation/<judge_id>/` folder and appends a new `judge-log.jsonl` line — never rewrites the deterministic folder in place.

**Judge-row failure / retry (queue).** Drain claims judge rows the same way as candidates (`judgeLaneRows` + claim marker). A mid-run failure marks the queue row `failed`, releases the claim (`releaseClaim`), and leaves the experiment `awaiting_evaluation` — no half-written evaluation (stage-then-rename inside `runJudge`). An explicit retry or the interactive skill path re-claims.

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

Deterministic headless example (additive fields only — same minimum plus the extras above):

```json
{
  "judge_id": "fixture-judge",
  "judge_agent": "fixture",
  "judge_model": "deterministic",
  "status": "succeeded",
  "self_judge": false,
  "winner": "fixture-a",
  "winner_set_by": "judge",
  "rationale": "…",
  "utility_weights": { "quality": 1.0, "cost_penalty": 0.2, "latency_penalty": 0.1, "feedback_penalty": 0.2, "failure_penalty": 0.3, "scope_penalty": 0.2 },
  "scored_by": "deterministic",
  "model_judgment_pending": ["correctness", "completeness", "scope_discipline", "maintainability"],
  "brief_path": "_experiments/exp-t/evaluation/fixture-judge/JUDGE-BRIEF.md",
  "candidates": {
    "fixture-a": {
      "hard_gates_passed": true,
      "fault": null,
      "gates": { "valid_output": true, "patch_applies": true, "tests_pass": null },
      "scores": { "correctness": 4, "completeness": 4, "scope_discipline": 4, "maintainability": 4, "test_quality": 3, "explanation_quality": 4 },
      "utility": 3.8,
      "cost_usd": 0,
      "duration_minutes": 0.1
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
experiments:            # optional — experiment routing policy (lib/experiment-policy.js)
  enabled: false            # absent section or anything but literal true = fully off
  candidates: []            # lanes to route between: [claude, codex] or {agent_tool, agent_model, id} maps
  default_primary: ""       # the incumbent lane — the baseline a challenger must beat to be promoted
  explore_rate: 0.1         # 0..1 — chance a selection explores instead of exploiting priors
  shadow_mode: all_others   # all_others | top_n | [explicit, lane, list]
  shadow_top_n: 1           # shadow count when shadow_mode: top_n
  judge: ""                 # judge id/tool — excluded from the candidate pool unless allowed below
  allow_judge_candidate: false
  budget_usd: null          # per-candidate budget carried onto queue rows
  timeout_minutes: null     # per-candidate timeout carried onto queue rows
  min_samples_to_route: 2   # a prior below this sample count cannot drive primary selection
  min_samples_to_promote: 3 # a prior below this can never change default_primary
  promote_utility_delta: 0.1  # challenger must beat the incumbent's score by at least this
  auto_initiate: false      # spin up shadow experiments automatically on a canonical claim (lib/worker.js)
  auto_initiate_lanes: []   # lane allowlist for auto-initiation (candidate ids/tools); empty = all candidates
  auto_initiate_max_concurrent: 1  # max auto experiments with non-terminal candidate rows at once
  auto_initiate_daily_max: 3       # max auto experiments created per UTC day
automation:             # optional — tl open's schedule profile (lib/automation.js)
  enabled: false            # absent section or anything but literal true = no schedules (calm default)
  interval_minutes: 15      # tick interval in minutes; positive integer, fallback-on-garbage to 15
  lanes: []                 # lane names to tick — each MUST have lanes.<name>.command (loud error otherwise)
  verify: false             # true = isolated verify tick via tl-worker --mode verify (needs verification.verifier_lanes)
  experiment: off           # off | drain — opt-in experiment queue/drain scheduling (see below); never auto-applies winners
sync:                   # optional — enables /tl sync (the JIRA shadow layer)
  jira:
    url: ""             # the JIRA Cloud site, e.g. https://acme.atlassian.net
    project: ""         # JIRA project key, e.g. PROJ
    import_filter: ""   # JQL; default "assignee = currentUser() AND statusCategory != Done"
    map:                # issue type → tl primitive; open-ended (lib/sync-map.js)
      epic: intent      # defaults — always in effect, listed for legibility
      story: spec
      task: spec
      bug: spec
      spike:            # any site-specific type may be added: intent | spec | ignore
        to: spec        # block form (to: spec) may hint the TL spec type + tags
        type: research  # must be feature | bug | tech_debt | research
        tags: [spike]
      sub-task: ignore  # explicit ignore = dropped by config; UNMAPPED types are
                        # held + reported with a config hint, never silently dropped
```

**The autonomy dial (`auto_review`).** An optional per-`type` map that lets `/tl run` *fast-track* low-risk spec types at the gate. Each key is a spec `type` (`research` `bug` `feature` `tech_debt`); the value is a bool, **all default `false`** (absent map or absent key = `false` = unchanged behavior). When a completing spec's `type` maps to `true`, `/tl run` still carries it `in-progress → tests → in-review` and **still writes `outcome/FEEDBACK.md` and `outcome/ALIGNMENT.md` first** — but stamps the spec `auto_reviewed: true` so `/tl review` and the cockpit can surface it as a low-risk fast-track candidate (and `cycle-log.jsonl` records `auto_reviewed: true/false` for measuring impact).

`auto_review` **never skips the human gate.** Even with a type set to `true`, `/tl run` lands the spec in `in-review`, not `done` — an agent never signs off its own work. The extra `to_done` guard is a belt-and-suspenders flag: it is `false` and agents must treat it as read-only false; there is no agent path to `done/`. `auto_review: true` means "flagged for a lighter-touch review," not "auto-accepted." (Deviation from the original spec, which proposed `auto_review` landing specs directly in `done/`: capped at `in-review` to keep the human gate intact.)

**The calm cap (`run`).** An optional section bounding how wide a single `/tl run` may fan out (`lib/batch.js` `calmCap`). `run: cap:` bounds **both** halves of a run: how many fresh ready specs one run may claim (`selectBatch`) and how many pending continuations may resume together (`selectContinuations`). Overflow is held, not dropped — the spec or dispatch waits for the next run with the concrete reason `batch capped at <n>`, and a held dispatch stays `pending`. Headless worker ticks read the same dial for fresh-batch selection (`lib/worker.js`), though one tick spawns at most one session. Fallback-on-garbage: the value must be a positive integer — a missing `run:` section, a missing `cap:` key, zero, a negative, a fractional, or a non-numeric value all fall back to the default `4`. Calm over swarm: the cap exists to bound parallelism, so it is never `0` — no cap value disables work (pause lanes with a `PAUSE` file instead).

**The experiment routing dial (`experiments`).** An optional section configuring how experiments pick a primary candidate, choose shadows, and learn (`lib/experiment-policy.js` — the transparent local policy; a future private/hosted model is a drop-in replacement reading the same logs). Section absent or `enabled` anything but literal `true` = fully off; every other value is fallback-on-garbage to the defaults shown (same posture as the calm cap), and unknown keys are preserved for later dials. The policy only ever *recommends* — it never edits `TRIAGE.yml`, never queues work itself, and winner application stays human. Selection and prior-update rules are documented with `routing-priors.jsonl` (below).

**The auto-initiation dial (`auto_initiate`).** The one exception to "the policy never queues" — and it is a *separate opt-in on top of* `enabled`: shadow experiments spin up without a human typing `tl experiment queue` only when **both** `enabled: true` and `auto_initiate: true` are literal. Absent fields (or the whole section) = fully inert — zero writes, zero behavior change. When on, the headless worker tick (`lib/worker.js` `maybeAutoInitiateExperiment`, called immediately after the tick commits a fresh canonical claim — lock + prompt on disk — and before the agent spawn) consults `decideRouting` and queues the returned cohort through the ordinary `queueExperiment` path; the `tl run` claim path is a follow-up spec. The hook is **best-effort and failure-silent toward canonical work**: a broken experiment path is caught, logged, and skipped — it never stops or delays a claim (and dry-run ticks and continuation resumes never initiate; only fresh ready picks do). `auto_initiate_lanes` allowlists the candidate pool the policy routes over (matched against candidate ids and `agent_tool`s; empty = all configured candidates). The two budget caps — `auto_initiate_max_concurrent` (auto experiments with any non-terminal candidate row) and `auto_initiate_daily_max` (auto experiments created per UTC day) — **hold** new auto-experiments with a visible reason when exhausted; they never cancel running ones. Every decision (initiated / held / skipped / error) lands in `auto-initiation-log.jsonl` with the policy inputs that drove it (below); auto-created experiments are downstream-indistinguishable from manual ones — same artifacts, same judge path — except `initiated_by: "policy"` in `EXPERIMENT.md` frontmatter (absent = `"human"`, the manual CLI/UI paths). Auto-*application* stays banned: this dial only ever creates experiments.

**The automation profile (`automation`).** An optional section that makes `tl open <workspace>` the one-command operating path: it declares the workspace's headless schedule instead of N hand-written crons (`lib/automation.js`; generator details in `docs/headless-lanes.md`). Absent section — or `enabled` anything but literal `true` — means **no behavior change**: `tl open` still starts the UI and prints the next human action, but installs nothing (calm default). When enabled, `tl open` installs or refreshes a **single per-workspace schedule** (one launchd plist on macOS, one printed cron line elsewhere — `tl open --print-schedule` emits both, paste-ready) that every `interval_minutes` ticks each lane in `lanes` sequentially via `bin/tl-worker.js <ws> --agent <lane>`. Every listed lane **must** already have `lanes.<name>.command` — a missing command is a hard error with a fix hint, never a silently-green schedule. `verify: true` appends an **isolated verify tick** (`bin/tl-worker.js <ws> --mode verify`) that claims at most one awaiting-verifier spec through `verification.verifier_lanes` (builder exclusion + per-spec lock); it requires at least one safe verifier lane or the profile is misconfigured.

**The stall threshold (`stall`).** An optional section tuning when an `in-progress/` claim reads as **stalled**: `stall: { idle_hours: N }`. A claim is stalled when the newest activity across its spec folder (SPEC.md, NOTES.md, `outcome/*`, `context/*`) — floored by `claimed_at` — is idle past the threshold (`lib/stall.js`). Default **24** hours; values must be numbers **≥ 1** — anything else (absent, non-numeric, or below 1) falls back to 24, so config junk can never weaponize detection into claim-stealing. Never stalled regardless of age: `awaiting_verifier` hand-offs, `status: blocked` specs, and claims with a pending `_dispatch/` continuation. Detection is **advisory** — `tl resume`/`tl up` flag stalled claims but nothing acts on them; reclaim stays an explicit human-attributed command (`tl reclaim <ws> <spec> --by <who> --reason "<why>"`, one spec at a time, never a sweep), and a fresh claim is refused even with a reason.

**The automation experiment dial (`automation.experiment`).** Opt-in scheduling of the existing experiment queue/drain path — experiments stay research/compare, never the canonical happy path, and **never auto-select or auto-apply winners** (`lib/experiment-apply.js` stays human-only). Supported values (case-insensitive; unknown strings fail loudly when `automation.enabled` is true — never silently execute):

| Value | Schedule effect |
|-------|-----------------|
| `off` (default; absent field) | Fully inert — no experiment ticks. Status says so. |
| `drain` | Appends one `bin/tl.js experiment drain --agent <lane> <ws>` tick per `automation.lanes` entry after the lane/verify ticks. Drain folds pending `_experiments/queue/*.json` request configs and drains queued candidate/judge rows for that lane only — the same operations as a manual `tl experiment drain`. Requires a non-empty `lanes` list. |

Invalid values (anything else) and `drain` with an empty `lanes` list are **hard profile errors** with a fix hint — same posture as a missing `lanes.<name>.command`. Status / `tl up` output states exactly which drain commands will run. Queueing a new experiment cohort remains explicit (`tl experiment queue`, UI request drop, or the separate `experiments.auto_initiate` dial) — this dial does not make experiments the default work path.

The workspace `PAUSE` file remains the kill switch: the schedule keeps firing but every lane tick exits `2` without spawning, and `tl open` reports the workspace as paused. `tl open` never claims or moves specs — it schedules ticks; the ticks' spawned sessions (and the isolated verifier runner) do the work, and everything still pools at the human review gate.

**Priority epochs (`focus`).** An optional top-level string naming the current priority epoch — a human-owned label tying related weight shifts and overrides together (e.g. `focus: "partner-launch"`). Set via `/tl goal` when rebalancing; absent means no active epoch label. The epoch is **not** a stored period object — it is a join key on append-only logs. When present, `/tl goal` and human priority overrides should stamp the same label on their log lines (`epoch` field, below). `/tl reflect` groups by that label and narrates the span.

**JIRA sync (`sync`).** An optional section enabling `/tl sync` against a JIRA Cloud site (REST API v3 only — not Server/DC). `url` and `project` identify the site and project; `import_filter` is the JQL that scopes what gets imported (default `assignee = currentUser() AND statusCategory != Done`). `map` is the **open-ended** issue-type → primitive contract (`lib/sync-map.js` `normalizeTypeMap` / `classifyIssueType` are canonical): any issue-type key maps to `intent`, `spec`, or `ignore` — as a scalar, or a block (`to:` required) that for `to: spec` may hint the TL spec `type` (`feature` `bug` `tech_debt` `research` only — lifecycle/stage words are rejected) and a `tags` list merged into the created spec. The four defaults (epic → intent, story/task/bug → spec) are always in effect; same-key entries override them, other keys extend, and matching is case-insensitive with whitespace collapsed to `-` (write multi-word JIRA names hyphenated: `sub-task:`). An issue type **not in the map is held, not imported** — logged `skipped_unmapped` with a concrete config hint and enumerated in the report; only an explicit `ignore` drops issues, and any invalid entry stops the run before import. **Credentials never live here** — the API token comes from the environment (`JIRA_EMAIL` / `JIRA_API_TOKEN`) or a credentials file outside the repo, never from `TRIAGE.yml` or any committed file. Section absent = sync disabled; TL is fully functional without it. Algorithm, status/priority mappings, and the `sync-log.jsonl` schema: `skills/sync/SKILL.md`.

## Metrics (`_metrics/*.jsonl`, per workspace)

Append-only, one JSON object per line. Schemas are defined in each skill's SKILL.md. Never edit existing lines; corrections are new lines.

`cycle-log.jsonl` records one line per completed cycle and carries the same four cost signals as FEEDBACK.md, so metrics aggregation reads them from the JSONL without reparsing markdown. Each line includes at least: `spec` (path), `completed` (date), plus the optional `agent_tool` (enum: `claude-code` `cursor` `codex` `windsurf` `other`), `duration_minutes` (number), `cost_usd` (number, estimated), and `tokens_used` (number). Older lines that predate these fields are valid — the fields are optional.

`loop-log.jsonl` (written by `/tl loop`) records one line per loop iteration: `goal` (id), `iteration` (int), `specs_run` (int), `specs_auto_reviewed` (int), `specs_awaiting_review` (int), `key_results_met` (int), `key_results_total` (int). It traces a goal's progress across an autonomous cycle; the human gate still owns `in-review → done`.

`goal-log.jsonl` (written by `/tl goal`) records one line per goal add/rebalance/edit. Fields include: `date`, `action` (`add` `rebalance` `edit`), `goal` (id), `weight` (number — the new weight for the affected goal), `rebalanced` (optional map of goal id → `[old_weight, new_weight]` for every changed goal), `reason` (the human's words), and optional `epoch` (string — join key tying this weight shift to related override lines; defaults to `TRIAGE.yml` `focus` when set). Older lines without `epoch` are valid.

`override-log.jsonl` (written by `/tl triage` on detected human priority changes, and by the cockpit on manual overrides) records one line per override. Fields include: `date`, `spec` (path), `from` (priority), `to` (priority), optional `reason` (the human's why), and optional `epoch` (string — same join key as `goal-log.jsonl`; defaults to `TRIAGE.yml` `focus` when set). Older lines without `epoch` are valid.

`review-log.jsonl` (written by the cockpit `/api/review` handler and the `/tl review` CLI path) records one line per human review decision — the audit line behind the reviewer stamp (see "Reviewer provenance" in the Spec section). Fields: `date` (full ISO timestamp of the decision), `spec` (the reviewed path, `in-review/<slug>/`), `action` (`accepted` `kicked-back`), `via` (`cockpit` `cli`), `gate` (`verified` `unverified` — `canAdvanceToReview` at decision time; `unverified` flags an accept past a failing gate, it never blocks one). Append-only like every `_metrics` log: never edit existing lines, corrections are new lines. Decisions that predate this log simply have no row — absence is not evidence of an agent move.

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

**Future cross-ref — `defects_escaped_to_verifier`.** A later benchmark-log writer may add a field derived from whether `outcome/REMEDIATION.diff` was non-empty (verifier found and fixed a builder gap). That field is **not** part of this schema row yet — see Alignment authorship diffs above; do not invent the column here.

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

`auto-initiation-log.jsonl` records one line per auto-initiation decision (`experiments.auto_initiate` dial — written only when the dial is on; an off dial writes nothing). Fields include: `date` (ISO timestamp), `spec` (workspace-relative path of the claimed spec), `decision` (`initiated` `held` `skipped` `error`), `level` (`info` for initiations, budget holds, and errors; `debug` for policy "no" decisions), `initiated_by` (always `"policy"` — this log only exists for the policy path), `experiment_id` (the created experiment, else `null`), `reason` (human-readable; budget holds carry the visible exhaustion reason), `policy` (the inputs that drove the decision — the training signal for priors: dial settings, candidate ids, `context_key`, `primary` `{id, source, reason}`, `shadows`, `shadow_mode`, `scores`, `explore_rate`, `min_samples_to_route`), and `budget` (`daily_used`/`daily_max`, `concurrent_used`/`max_concurrent`). Initiations also appear in `experiment-log.jsonl` as a normal `queued` transition with reason `experiment queued (policy)`.

`winner-log.jsonl` records one line per winner-application decision (select, apply, reject, send-to-review, apply-failed, superseded) — append-only; `WINNER.json` carries only the current state. Fields include: `date`, `experiment_id`, `tl_spec`, `base_commit`, `candidate_id`, `state`, `previous_state`, `decided_by`, `decision_source`, `decided_at`, `patch_path`, `patch_sha256`, `reason`, `error_summary`, and `review_artifact`.

`routing-priors.jsonl` records local transparent routing evidence — the experiment routing policy's prior store. Full row schema, context-key generation, selection rules, and the promotion threshold: the subsection below.

`replay-log.jsonl` records benchmark/replay comparisons. Fields include: `date`, `experiment_id`, `replay_of`, `suite_id`, `candidate_id`, `previous_winner`, `new_winner`, `utility_delta`, `quality_delta`, `cost_delta`, `latency_delta`, and `promotion_recommendation`.

`trace-features.jsonl` records derived trace features for learning without rereading full traces. Fields include: `date`, `experiment_id`, `candidate_id`, `event_count`, `tool_calls`, `test_iterations`, `first_test_at_ms`, `replan_count`, `backtrack_count`, `scope_violations`, and `human_intervention_count`.

### `routing-priors.jsonl` (transparent routing evidence)

The local policy store behind experiment primary/shadow selection (`lib/experiment-policy.js` — the **sole** writer/selector for this file). Portable-core code reaches that implementation through `createLocalRoutingPolicy` in `lib/experiment-adapter.js`: a thin `{ name, choose, record }` (plus `formatPriorRow`) adapter seam that **delegates** to `experiment-policy` and does not invent a second prior-row shape. A future private or hosted learned model implements the same seam and swaps in without the core depending on it. Append-only and event-sourced like the experiment queue: the **latest** row per `(context_key, agent_tool, agent_model)` is the current prior; an update merges one new judged observation into the running aggregates and appends a **new** line — historical rows are never mutated. No neural model anywhere: the whole policy is a weighted score over quality, success rate, cost, and latency, plus an exploration rate.

| Field | Type | Meaning |
|-------|------|---------|
| `date` | date | when this aggregate row was appended |
| `context_key` | string | the work-shape bucket this prior applies to (generation below) |
| `agent_tool` | string | candidate lane, e.g. `claude` `codex` `cursor` |
| `agent_model` | string/null | model when known; `null` = tool-level prior. A model-specific row wins over a tool-level one at lookup |
| `runtime_fingerprint` | string | short hash (12 hex chars) of the 9 shared fingerprint fields from the latest observed run |
| `expected_quality` | number 0–1 | running mean of the per-run quality observation: won `1.0`, succeeded-not-winner `0.5`, faulted `0.0` |
| `expected_cost` | number | running mean `cost_usd` (unknown counts as 0) |
| `expected_latency` | number | running mean `duration_minutes` (unknown counts as 0) |
| `success_rate` | number 0–1 | fraction of runs with status `succeeded` |
| `samples` | int | observations folded into this aggregate |
| `last_updated` | datetime | ISO timestamp of this update |
| `source` | string | provenance: `judged:<experiment_id>` for rows written by the log fold — also the idempotence key (an experiment is folded exactly once) |

**Context key generation** (`buildContextKey`). A deterministic, fixed-segment key over the spec's shape — same work, same key, which is what makes priors joinable: `type=<spec type>|size=<size>|files=<file families>|tags=<tags>|risk=<risk>|caps=<capabilities>`. File families are coarse buckets from the spec's files-to-touch (top-level directory, or extension family for root files: `lib/experiment-policy.js` → `lib`, `README.md` → `md`); list segments are lowercased, sorted, deduped, capped at 4, joined with `+`, `none` when empty. Risk is a small documented heuristic — `p0` priority or a high-risk tag (`security`, `auth`, `payments`, `billing`, `migration`, `infra`, `release`) → `high`, else `normal` — and required capabilities are caller-supplied (e.g. `headless`). Example: `type=feature|size=medium|files=lib+test|tags=experiments+routing|risk=normal|caps=none`.

**Primary selection** (`selectPrimary` / `decideRouting`), in order of authority:

1. **Explicit override wins** — a CLI/experiment override, else the spec's own `agent:` lane when not `any`. Human intent is never re-decided by priors.
2. **Priors above threshold** — among candidates whose prior has `samples ≥ min_samples_to_route`, pick the best weighted score: `quality·w_q + success_rate·w_s − cost·w_c − latency·w_l` (cost/latency normalized against the candidate pool; default weights 0.5/0.3/0.1/0.1) — unless the exploration roll fires (probability `explore_rate`), so priors never go stale unchallenged.
3. **Exploration fallback** — least-sampled candidate first (round-robin by evidence), ties broken uniformly at random; with no priors at all this is a plain random pick.

**Shadow selection** (`selectShadows`): `all_others` (default — every other candidate), `top_n` (best `shadow_top_n` others by prior score), or an explicit lane list. The judge is excluded from the candidate pool — primary and shadow — unless `allow_judge_candidate: true`, and the primary never shadows itself.

**Prior updates** (`updatePriorsFromLogs`): priors update **only after judged outcomes** — an experiment contributes observations only once a succeeded `judge-log.jsonl` row exists for it, joined against the latest `candidate-run-log.jsonl` row per candidate. Each experiment is folded exactly once (the `source` tag is checked before folding), corrections are new lines, and unjudged runs teach nothing.

**Promotion threshold** (`shouldPromote`): a challenger becomes the recommended `default_primary` only with **both** `samples ≥ min_samples_to_promote` **and** a weighted-score edge over the incumbent of at least `promote_utility_delta` — a new runtime never becomes the default from a single win. The check returns a recommendation; changing `default_primary` is a human `TRIAGE.yml` edit.

## Spec notes (`<stage>/<slug>/NOTES.md`, optional)

Append-only human feedback on a spec, left from the cockpit while work is in flight. Each note is a small dated section (`## YYYY-MM-DD — note`, or `— kicked back` for a review rejection). The file lives in the spec's own folder, so it travels with the spec through every stage. `/tl run` reads it as binding context (treat it like the acceptance criteria); `/tl review` surfaces it. There is no queue for *new* work — the `ready/` stage **is** the queue, the stage folders **are** the status, and the cockpit's write actions are review (accept / kick back) and notes. The one dispatch artifact that exists is the **continuation** trigger a kickback leaves behind (next section): it resumes already-claimed work, it never starts fresh work.

## Activity trace (`<stage>/<slug>/TRACE.jsonl`, optional)

The spec-scoped, human-readable activity trace: an append-only JSONL file **in the spec's own folder**, so it travels with the folder through every stage move — claim, kickback, verification, review. One JSON object per line; each event is a small observable action, never a transcript. This is the **canonical-spec** trace; the experiment candidate trace (`candidates/<candidate_id>/TRACE.jsonl`, above) is a **separate contract** with runner-fingerprint fields — cross-reference them, never merge them. Files only: no database, no server-side execution; the cockpit reads it through the existing file-watch path.

Common fields (every row):

| Field | Type | Meaning |
|-------|------|---------|
| `ts` | datetime | ISO timestamp |
| `type` | string | event type (below) |
| `summary` | string | short observable action or deliberate rationale summary (secret-redacted before write) |
| `paths` | list | optional — workspace/repo-relative paths the event touched |
| `actor_type` | enum | `human` `agent` `policy` `system` — who performed the action |
| `actor_id` | string | e.g. `claude`, `trevor`, `tl-worker`; lane names for agents |
| `initiation` | enum | `human` `automation` `policy` `continuation` — what set the action in motion |
| `source` | enum | `cli` `cockpit` `worker` `scheduler` — the surface it came through |
| `run_id` / `dispatch_id` | string | correlation when one exists — a worker tick's `run_id` matches its `_metrics/worker-prompts/` stamp; a continuation's `dispatch_id` is the `_dispatch/<slug>.json` (or verify-request) file |

**The absence rule.** Historical omissions (and rows from writers that predate a field) mean `unknown` — absence must **never** be interpreted as `human`. Writers normalize missing provenance to the literal string `unknown` (`lib/worker.js` `appendSpecTraceEvent`); readers apply the same rule to rows that lack the fields entirely. Event-specific payload keys ride alongside the common fields; parsers preserve unknown fields.

Event types (extensible — these are the documented core):

| Type | Meaning / extra fields |
|------|------------------------|
| `claimed` | a claim was signed or committed — interactive `tl run` briefs append it with `initiation: human` / `source: cli`; a headless worker tick appends it at lock+prompt commit with `initiation: automation` / `source: worker` and its `run_id`, so a human-invoked run is distinguishable from a scheduled pickup even when the same agent does the work |
| `dispatched` | work sent to a lane **without** signing a claim — continuation resumes (carries `dispatch_id`) |
| `dispatch-failed` | an unsuccessful dispatch, first-class: `lane`, `reason` (`tl_run_failed` `spawn_failed` `agent_session_failed` …), the initiator/source/correlation of the attempt, and a sanitized failure detail (unavailable auth, invalid invocation, sandbox/workspace visibility). Always appended after any `claimed`/`dispatched` row for the attempt — a failed dispatch never leaves a spec looking successfully claimed |
| `context-read` | the agent assembled its brief (spec, NOTES, intent, goal) |
| `file-edited` | files changed — `paths`, a one-line summary, never diffs or reasoning |
| `command-run` / `test-result` | checks executed and what they said |
| `decision-summary` | a **deliberate external note** — "chose X because acceptance criterion Y requires it" — never a reasoning transcript |
| `thread-captured` | a thread was captured; `paths` names it |
| `blocked` | the spec blocked — same one-line reason as `blocked_reason` |
| `handoff` | a stage move — `from_stage`, `to_stage`, and the same correlation identifier, producing a readable claim-to-review chain (in-progress → tests, tests → in-review, a review kickback, a reclaim) |

**The privacy boundary (the core constraint).** Required = observable actions (files, commands, tests, stage moves, provenance). Optional = deliberate plan/rationale summaries the agent chooses to record. **Never** = private chain-of-thought or model-internal reasoning — it must not be requested, stored, or displayed. Writer-side redaction (`lib/experiment-trace.js` `redact`, reused by `appendSpecTraceEvent`) scrubs credential patterns before anything lands on disk, but agents should not write secrets in the first place.

**Writers.** `lib/worker.js` `tick`/`verifyTick` (scheduler/worker provenance with run correlation), `bin/tl.js` (interactive `tl run` claim, `tl reclaim` handoff, `tl verify` human-decision handoff), and the running agent itself per `skills/run/SKILL.md`. One writer per dispatch path: a tick-driven `tl run` brief subprocess skips its interactive appends (the tick owns them). Flat `.md` specs have no folder, so they have no trace — folder-form specs only. **Readers degrade gracefully:** no trace file means fall back to the spec body/notes view; the trace is observability and its absence (or a failed append) never blocks lifecycle work.

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

The scheduling half of cross-agent dispatch: `node bin/tl-worker.js <workspace> --agent <lane>` performs **one run tick** — if the lane has eligible run work (a pending continuation it owns first, then at most one conflict-free ready spec in its lane), it launches the lane's configured agent CLI once with the `tl run` brief as the prompt, logs the session, and exits. `node bin/tl-worker.js <workspace> --mode verify [--agent <verifier-lane>]` performs **one verify tick** — claims at most one awaiting-verifier spec via `verification.verifier_lanes`, never the builder, under `_metrics/verify-locks/<slug>.lock`, invokes the isolated runner (`lib/verifier-worker.js`), and records the outcome (clean → `in-review`; mutations → human-decision-required at `tests/`; failures stay in `tests/` with `blocked_reason`). Cockpit **Dispatch verify** only writes `_metrics/verify-requests/*.json` for the tick to drain. Cron/launchd owns the interval. Recipes and the operational model live in `docs/headless-lanes.md`.

**`lanes:` config.** A lane is an agent CLI invocation — tl ships no provider integrations. Per-lane keys are path-safe lane names matching spec `agent:` / `claimed_by` values: lowercase letters, numbers, dots, underscores, and hyphens only.

```yaml
lanes:
  claude:
    command: "claude --dangerously-skip-permissions -p"   # no placeholder → brief on stdin
    model: claude-fable-5                 # optional — model identity → claimed_model at claim time
    lock_timeout_minutes: 120             # optional — stale-lock takeover threshold (default 120)
  codex:
    command: "codex exec --sandbox workspace-write -"   # no placeholder → brief arrives on stdin
  structured:
    command: [codex, exec, -c, key=["value with spaces"], -]   # list form: verbatim argv elements
  piped:
    command: "foo -p | tee /tmp/lane.log"   # needs a real shell → must opt in:
    shell: true                             # literal true only; anything else = argv default
```

**Spawn contract: argv-first.** By default the worker never spawns through a shell. A string `command` is **whitespace-split into an argv array** and executed directly (`argv[0]` + the rest as arguments — the same argv-array shape as the experiment PROVIDERS table and `verifier_lanes.command`); the YAML **list form** passes each element verbatim (note: the hand-rolled parser splits inline lists on commas, so comma-bearing tokens belong in the agent's profile file). Prompt content and paths are substituted as raw argument values — no escaping exists or is needed, so brief bytes can never be interpreted as shell input. `lanes.<name>.shell: true` (literal `true`) is the **explicit opt-in** for commands that genuinely need shell features: only then is the command string run through the shell, with placeholder values shell-escaped (`shell: true` requires the string form — a list `command` with `shell: true` is unconfigured). A string command containing shell syntax (quotes, `|`, `&`, `;`, `<`, `>`, `(`, `)`, `$`, backticks, `\`, globs, or a leading `~`) **without** the opt-in is a hard error: exit `1`, reason `shell_required`, nothing executes — never a silent wrong split.

Prompt delivery: **stdin is canonical** — a command with neither `{prompt_file}` nor `{prompt}` receives the brief bytes on stdin. `{prompt}` is substituted with a **single-line** form of the brief (lossy — avoid for multiline run briefs): one verbatim argument on the argv path, shell-escaped on a `shell: true` lane. **`{prompt_file}` substitutes the path** of the brief written to `_metrics/worker-prompts/<lane>-<timestamp>.txt` — **wrong for CLIs that treat `-p <arg>` as literal prompt text** (e.g. `claude -p {prompt_file}` passes a filename string, not the brief; use stdin instead). Workspace artifacts (prompts, locks, logs) live under `projects/<name>/`, which is already gitignored. An unconfigured lane is a hard error: exit `1`, nothing executes.

**Model identity (`lanes.<name>.model`).** Optional; declares the model the lane's `command` pins (e.g. a `--model` flag in the command, or the provider's default). The worker never verifies or injects it into the command — it is the pass-through into the **claim stamp**: when set, the tick appends a claim-identity trailer to the brief naming the configured model, and the spawned session stamps `claimed_model: "<model>"` alongside `claimed_by`/`claimed_at` when it signs a claim (spec frontmatter, above; sign-the-claim step in `skills/run/SKILL.md`). The trailer carries the honesty rule with it: an agent that knows it is a *different* model stamps what it actually is, and one that can't confirm any model leaves the field unset. Scalars only, fallback-on-garbage: a missing, empty, or non-scalar `model` means no trailer and claims land with `claimed_model` absent (= unknown, never guessed). Continuation resumes sign no claim, so the trailer is inert there. When set, the lane's `_metrics/locks/<lane>.lock` also carries `model` for observability.

**Continuation ownership (lane filter).** A pending continuation is eligible for lane `<lane>` only when ownership matches: if the linked spec has `claimed_by`, that value must equal `<lane>` — `agent: any` never overrides an existing claim. Only when unclaimed does the routing lane (`agent: <lane>` or `any`) decide. While another lane's continuation is pending, a tick claims **no** fresh ready work (matching `/tl run`, which holds the ready queue behind any pending continuation) and exits `0` with reason `no_continuation`.

**Safety.** A workspace-root `PAUSE` file halts all lanes (exit `2`, no spawn). A per-lane JSON lock at `_metrics/locks/<lane>.lock` — containing at least `date`, `workspace`, `lane`, `pid`, `picked`, `prompt_path` — is created immediately before the spawn and removed after the child exits (success or failure); a lock younger than the stale timeout means exit `2` without spawning, an older one is taken over (logged). Staleness is judged by file mtime, so a corrupt lock still times out. `--dry-run` prints the exact command and prompt delivery, exits `0`, and writes **nothing** — no prompt file, no lock, no log line.

**Exit codes.** `0` — no work (quiet cron) or child exited 0; `1` — lane misconfigured, `tl run` subprocess failure, spawn failure, or child exited non-zero; `2` — `PAUSE` present or lock held.

**`worker-log.jsonl`** (`_metrics/worker-log.jsonl`, append-only): one line per non-dry tick — `date`, `workspace`, `lane`, `picked` (spec path, `_dispatch/<slug>.json`, or `none`), `spawned` (bool), `exit_code` (the tick's exit code), `duration_seconds`, and `reason` when not spawned (`no_continuation` `no_ready` `paused` `locked` `lane_unconfigured` `shell_required` `tl_run_failed` `spawn_failed`). Extra fields appear when relevant (`child_exit_code`, `stale_lock_takeover`); a lock-cleanup failure appends its own `event: lock_cleanup_failed` line. As everywhere: never edit existing lines.

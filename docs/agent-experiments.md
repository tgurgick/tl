# Agent Experiments

Agent experiments let TL compare multiple candidate runs against the same task, judge their outputs with a repeatable rubric, and store enough machine-readable evidence to improve future routing. The first implementation lives inside TL, but the model is intentionally portable: a later standalone package should be able to run the same task/candidate/judge protocol outside TL.

## Portable Model

The core concepts are deliberately generic:

| Concept | Meaning |
|---------|---------|
| Task | The work request, acceptance criteria, scope, context, and base commit |
| Candidate | One tool/model/runtime attempt to complete the task |
| Judge | A human or agent that evaluates candidate outputs against hard gates, scores, cost, and review burden |
| Experiment | The cohort tying one task, candidates, judge, hashes, and artifacts together |
| Replay | A rerun of an earlier task or suite against a new runtime or policy |
| Runtime fingerprint | The exact tool, model, framework, adapter, rules, and skills identity used for a run |

TL maps these concepts onto existing project objects, but those mappings are adapter behavior rather than core requirements. A TL spec becomes a task; a candidate produces a patch plus feedback; a judge produces scores and a winner; a later winner-application workflow decides whether any patch touches canonical source files.

## TL Adapter Mapping

| TL concept | Experiment concept | Notes |
|------------|--------------------|-------|
| Spec folder | Task source | The task includes `SPEC.md`, acceptance criteria, allowed files, do-not-touch boundaries, and any `NOTES.md` |
| Intent | Task objective context | The intent outcome explains why the spec matters |
| `TRIAGE.yml` goals | Task priority context | Goals help a judge understand value, not just mechanical correctness |
| `FEEDBACK.md` | Candidate report | Candidate-facing narrative artifact |
| `_experiments/` | Experiment store | Shadow attempts live here until explicitly applied |
| `_metrics/*.jsonl` | Learning/query surface | Append-only rows power routing, replay, and benchmark comparison |

The adapter should capture `spec_hash` at experiment creation time and `base_commit` before any candidate runs. Those two fields make comparisons controlled: every candidate should be judged against the same task text and source tree.

## Artifact Flow

An experiment folder is created under `_experiments/<experiment_id>/` with `EXPERIMENT.md` as the index. Candidate outputs live under `candidates/<candidate_id>/`; judge outputs live under `evaluation/<judge_id>/`.

Candidate folders contain `PATCH.diff`, `FEEDBACK.md`, `METRICS.json`, and `TRACE.jsonl`, plus optional `REASONING.md`. `TRACE.jsonl` is an append-only observable action stream (tool calls, file reads/writes, commands, tests, retries, status changes, faults). `REASONING.md` is optional and only for deliberate summaries a runtime exposes; private chain-of-thought is never required or stored. See "Action traces and model visibility" below.

Judge folders contain `EVALUATION.md`, `SCORES.json`, and (from a headless deterministic judgment) `JUDGE-BRIEF.md`. The markdown explains the comparison for humans. The JSON records hard gates, score dimensions, utility, winner, and rationale in a shape later routing logic can read. `JUDGE-BRIEF.md` lists the rubric dimensions that still need model judgment so any lane can refine the deterministic baseline without rewriting it.

## Fixture Proof

`tl experiment fixture <workspace>` creates a deterministic local proof run without calling any agent provider. It writes one fixture experiment under `_experiments/`, creates two candidate folders, runs a simple deterministic judge, and appends rows to `_metrics/candidate-run-log.jsonl`, `_metrics/judge-log.jsonl`, and `_metrics/experiment-log.jsonl`.

The fixture candidates are intentionally boring:

- `fixture-a` is the primary candidate and passes the hard gates.
- `fixture-b` is the shadow candidate and is retained as a non-winning result.

The fixture proves the artifact protocol before queue workers, real adapters, routing priors, replay suites, or UI panels exist. Candidate runs write only experiment artifacts and metric rows; they do not move canonical TL specs or mutate source files.

## Runtime Fingerprints

Every candidate and judge record should carry the same runtime fingerprint fields:

- `agent_tool`
- `agent_model`
- `agent_model_auto`
- `agent_model_source`
- `runtime_version`
- `framework`
- `adapter_version`
- `rules_hash`
- `skills_hash`

`agent_model_auto` distinguishes an explicit model from an automatic model selection mode. `agent_model_source` records whether the resolved model came from an SDK, a hook, a runtime report, or is unknown.

Replay records add one more field on top of the nine: `tl_version` — the version of tl itself that queued the replay. Together the fields answer *why* a candidate's behavior changed between runs: model (`agent_model*`), agent tool (`agent_tool`), framework (`framework`), adapter (`adapter_version`), rules (`rules_hash`), skills (`skills_hash`), or the harness (`tl_version`). `rules_hash` hashes the agent-facing rules files at the checkout root (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/tl.mdc`); `skills_hash` hashes every `skills/*/SKILL.md` — sorted relpath + content pairs, so the hash moves exactly when the content moves. See "Replay and benchmark suites" below. Candidate `METRICS.json` also records `agent_model_requested` (what was asked for — display `auto` under Cursor auto).

## Action traces and model visibility

How a candidate executed the task is a first-class learning input. Implementation lives in `lib/experiment-trace.js` (append, redaction, feature extraction) and is wired through `lib/experiment-runner.js`.

### Privacy boundary

| Layer | Contract |
|-------|----------|
| Required | Observable action trace — tool calls, file reads/writes, tests, commands, retries, status changes, faults |
| Optional | Reasoning / plan summaries only when deliberately reported by a runtime or agent (`reasoning_summary`, `plan_summary`) |
| Never required | Private chain-of-thought — do not request, persist, or treat hidden model reasoning as a validity gate |

A candidate run is valid without any optional reasoning events. Action trace + metrics are enough.

### `TRACE.jsonl` event contract

Each line is one JSON object with common fields: `ts`, `type`, `agent_tool`, `agent_model`, `agent_model_auto`, `agent_model_source`, `source`, `duration_ms`, `status`, `summary`, plus event-specific payload keys.

**Required types** (local runner emits where possible): `start`, `plan_summary`, `tool`, `file_read`, `file_write`, `test`, `command`, `patch`, `status`, `fault`, `finish`.

**Optional types**: `reasoning_summary`, `replan`, `backtrack`, `human_intervention`.

### Redaction

Before any event is written, summaries and string payload fields pass through redaction: env-style credential assignments (`API_KEY=…`, `*TOKEN*` / `*SECRET*` / `*PASSWORD*` names) and known secret patterns (provider API keys, GitHub/Slack tokens, AWS keys, JWTs, bearer/password assignments) become `[redacted]`. The UI applies a second redact pass when serving traces; write-time redaction is the disk safety net.

### Derived `trace-features.jsonl`

After each candidate run, the runner appends one `_metrics/trace-features.jsonl` row with: `date`, `experiment_id`, `candidate_id`, `event_count`, `tool_calls`, `test_iterations`, `first_test_at_ms`, `replan_count`, `backtrack_count`, `scope_violations`, `human_intervention_count`. Features are counts/timings over observable events only.

### Cursor auto model handling

For Claude/Codex, the model may be declared by the CLI/API (`agent_model_requested` + `agent_model_source: requested|reported`). For Cursor auto:

1. Display requested model as `auto` (`agent_model_requested: "auto"`, `agent_model_auto: true`).
2. Capture the resolved model when an SDK, hook, or session report exposes it.
3. Otherwise mark the resolved model `unknown` and `agent_model_source` as `unknown` (or `sdk` / `hook` / `reported` when that channel supplied the resolution).

Adapters report best-effort identity only — no provider-internal probing for hidden reasoning.

## Statuses

Experiments and candidate runs use lowercase status strings: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `over_budget`, `unavailable`, `cancelled`, `invalid_output`, and `awaiting_evaluation`.

Winner application states are separate from run statuses and human-owned: `selected`, `applied`, `rejected`, `sent-to-review`, `apply-failed`, and `superseded`. See "Winner Application" below.

## Initiation and Headless Workers (queue / drain)

Experiments are initiated in one of two ways, both file-native:

- **Manual command** — `tl experiment queue [ws] <spec>` creates the experiment folder for a TL spec: it hashes the spec at queue time (`spec_hash`), records the source tree (`base_commit`, from `--repo`, default this checkout), selects candidates from explicit config (`--config <file>`) or the deterministic fixture defaults (`fixture-a` primary, `fixture-b` shadow, `fixture-judge` judge), and writes one **queued candidate row** per candidate. The spec itself is never moved — an experiment is a shadow attempt against a snapshot, not a claim.
- **UI request** — the dashboard's queue form drops a request config at `_experiments/queue/<stamp>-<slug>.json`. A drain pass folds pending requests into real experiments (the request file is rewritten `status: "accepted"` with the `experiment_id` — an audit trail, never deleted). Two runtimes bridge:
  - `runtime: "fixture"` — the deterministic proof cohort, no extra fields needed.
  - `runtime: "local"` — a real local adapter run. The request must carry the two bridge fields: `runner` (a registered adapter lane: `codex` | `gemini` | `claude` | `cursor` | `shell`) and `repo` (the repo candidates run against, isolated per run). All named candidates (primary + shadows) land in that runner's lane; per-candidate models ride in `models`; `command` is required for (and only used by) the `shell` runner; optional `prompt`/`profile` pass through as structured config. A **malformed** local request (missing/unknown runner, missing/nonexistent repo, shell without a command) is rewritten `status: "invalid"` with the exact error — **never silently dropped**. Unknown future runtimes (e.g. a cloud slice) are reported `left-queued` and left untouched; an unparseable request file is reported invalid without rewriting it (it may be a corrupted audit record).

The `--config` JSON for explicit cohorts:

```json
{
  "repo": "/path/to/canonical/repo",
  "budget_usd": 2.0,
  "timeout_minutes": 30,
  "judge": { "id": "judge-1", "agent_tool": "fixture" },
  "candidates": [
    { "id": "codex-a", "role": "primary", "agent_tool": "codex", "repo": "/path/to/repo", "profile": "todoapp", "extra_flags": ["--full-auto"] },
    { "id": "shell-b", "role": "shadow", "agent_tool": "shell", "command": "…", "repo": "/path/to/repo" },
    { "id": "fixture-c", "role": "shadow", "agent_tool": "fixture" }
  ]
}
```

### Queue rows and lanes

Queue rows live in `_experiments/queue/<experiment_id>.jsonl` (workspace-relative), **append-only and event-sourced**: every transition appends a full row; the newest row per candidate is the current state. Every row carries at least `experiment_id`, `candidate_id`, `role` (`primary` / `shadow` / `judge`), `agent_tool`, `agent_model_requested`, `status`, `attempt`, `budget_usd`, `timeout_minutes`, and `created` — one row is self-describing without replaying the file. A `config` object (command, repo, env, `estimated_cost_usd`) rides along so a drain is self-contained.

Each worker drains **only its own lane**: `tl experiment drain --agent <tool> [ws]` claims queued candidate rows whose `agent_tool` matches, runs them, and appends terminal transitions. Rows in other lanes are simply left `queued` — that *is* the fault posture for a worker that isn't running. This is what makes shadow runs safe to queue while a different tool or session is active: a Codex row waits for a Codex worker; a Cursor row waits for a Cursor SDK/cloud worker (Cursor's IDE chat cannot drain headlessly — capability data, see below).

**Claim atomicity (local files).** Appends record history; the claim decides races: claiming attempt N creates `_experiments/queue/claims/<exp>--<cand>--<N>.claim` with an exclusive create (`O_EXCL`). Two workers may both read a row as queued, but exactly one wins the marker and appends the `running` row; the loser moves on. Atomic enough for local file use by design — a distributed queue is explicitly out of scope for this slice.

### Fault handling

Every terminal path — fault or not — leaves the same artifact set (`PATCH.diff`, `FEEDBACK.md`, `METRICS.json`, `TRACE.jsonl`) and appends a `candidate-run-log.jsonl` row. Faults are learning data, never dropped:

| Situation | Row status |
|-----------|-----------|
| No worker running for a lane | rows stay `queued` (nothing marks them) |
| Worker drains a tool it cannot execute locally | `unavailable` |
| Estimated cost exceeds `budget_usd` | `over_budget` (stopped **before** execution) |
| Command outlives `timeout_minutes` | `timed_out` |
| Command exits non-zero / runner crashes | `failed` |
| Run "succeeds" but produces no usable patch | `invalid_output` |

A primary failure **never cancels shadows** — `failed` is terminal like any other status, the shadow lanes keep draining, and a shadow can still win at evaluation.

### Judge queueing and drain

One `tl experiment drain --agent <tool>` pass follows this flow:

1. Fold pending request configs into experiments.
2. Claim + run every queued **candidate** row in this agent's lane (up to `--max`).
3. Queue a **judge** row for any experiment whose candidates are all terminal (or that `--evaluate-partial <experiment-id>` forces).
4. Execute queued judge rows in this agent's lane (default) — deterministic hard-gate checks in code; model-judgment dimensions land in a lane-agnostic `JUDGE-BRIEF.md`.

The judge row (role `judge`, lane from the experiment's `judge_tool`) is queued only once **every candidate run is terminal** — whichever lane finishes last queues it, and the experiment flips to `awaiting_evaluation`. A human can force evaluation of partial results with `--evaluate-partial <experiment-id>`; the forced judge row records that it was partial.

**Default vs opt-out.** The CLI turns step 4 on by default (`judges: true`). Pass `--skip-judges` to leave judge rows queued for the interactive `skills/experiment-judge` path instead. Library callers of `drainQueue` keep the older candidate-only contract unless they opt in with `judges: true` — the CLI is what flips the default for operators. A mid-run judge failure marks the row `failed`, releases the claim marker, and leaves the experiment `awaiting_evaluation` for an explicit retry or the skill; evaluations stage then rename so nothing half-writes.

### Isolated runs (the worktree/clone strategy)

Local shell candidates never touch the canonical working tree. The runner creates a **detached git worktree** at the experiment's `base_commit` (`git worktree add --detach`, cheap — shares the object store), falls back to a **sibling clone** when worktrees are unavailable, runs the command inside it, collects `git diff` (intent-to-add first, so new files show) as `PATCH.diff`, and tears the workdir down. Fixture candidates are side-effect-free and need no isolation.

This is also the documented **seam for later orchestration**: `lib/experiment-runner.js` exports `createIsolatedWorkdir` / `removeIsolatedWorkdir` (the isolation strategy) and the `RUNNERS` registry (one entry per `agent_tool`: `fixture`, `shell`, and the provider adapters below). A remote/cloud worker replaces the workdir pair with its own sandbox provisioning — keeping the same promise: **the canonical repo is never mutated by a candidate run**.

### Provider adapters (codex / gemini / claude / cursor)

The `RUNNERS` registry ships turnkey adapters for the four provider CLIs, so a cohort config can say `agent_tool: "codex"` instead of hand-assembling a shell command. Each adapter is a thin wrapper over the same isolation + artifact contract as `shell` — same terminal statuses, same artifact set, no provider SDKs — but **encodes its CLI's invocation shape** so it cannot be misconfigured per-experiment. The quirks themselves (why the flag order matters, sandbox tiers, writable-roots profiles) are ground-truthed in `docs/headless-lanes.md` ("Per-lane invocation quirks") — this table is the encoding, that document is the rationale:

| Adapter | Invocation template | Prompt delivery |
|---------|--------------------|-----------------|
| `codex` | `codex exec --sandbox <mode> [-p <profile>] [extra…] -` | stdin (the trailing `-`); `-p` is a config **profile**, never the prompt |
| `gemini` | `agy --dangerously-skip-permissions [extra…] -p <prompt>` | final argv element; `-p` is always emitted **last** so no flag can be swallowed as the task |
| `claude` | `claude [extra…] -p` | stdin (the `cat brief \| claude -p` shape) |
| `cursor` | `cursor-agent -f [extra…] -p <prompt>` | final argv element; `-f` (trust the directory) is baked in |

**No shell, no quoting.** Adapters spawn the CLI with an **argv array** — the prompt travels on stdin or as one argv element, so the no-nested-quoting rule from `docs/headless-lanes.md` holds by construction. Overrides are **structured config fields** on the candidate (never string concatenation): `repo` (required — the isolation source), `prompt` (default: the tl spec the experiment was queued from — the turnkey path), `profile` and `sandbox` (codex), `extra_flags` (an array of argv elements, inserted in the one slot per adapter where they cannot displace the load-bearing flags), and `env`. Anything structured beyond that (writable roots, TOML/JSON settings) belongs in the provider's own profile file, per the headless-lanes rule — the config field only names the profile.

Budget (`over_budget`, stopped before execution) and `timeout_minutes` behave exactly like `shell`. A provider CLI missing from PATH is `unavailable` — with the full artifact set and log row, so an unequipped machine draining the lane is recorded learning data, not a crash. Note the lane semantics stay unchanged: a `codex` row waits for a worker that drains `--agent codex` on a machine where the CLI exists.

### Worker safety invariants

- Workers **never apply winners**. The queue and runner modules do not import the winner-application library (a test enforces it); `tl experiment apply` remains the explicit human action.
- Workers **never move canonical spec folders**. Queueing reads `SPEC.md`; it does not claim, stage, or advance the spec.
- Queue history is **append-only**; corrections and retries are new rows/attempts, never edits.

## Safety Boundary

Experiments are shadow attempts. They may create artifacts under `_experiments/` and append rows under `_metrics/`, but they do not mutate canonical spec stages or source files as a side effect of judging. Applying a winning patch must be an explicit later action, and normal TL review still owns acceptance into `done/`.

Markdown is the human narrative. JSON and JSONL are the learning surface. This split keeps review readable while allowing routing, replay, and benchmark tools to query outcomes without scraping prose.

## Winner Application (human-controlled)

Judging picks a winner; it does not act on one. Winner application is the explicit later step where a human decides what happens to the winning patch. The invariant: **candidate artifacts are evidence; only an explicit human action applies a winning candidate to the canonical repo.** No queue worker, judge, scheduler, or agent applies a patch automatically — running one of the commands below *is* the explicit action, and the library additionally refuses to apply for any `decision_source` other than `human`.

### States

| State | Meaning |
|-------|---------|
| `selected` | A human named this candidate the winner; nothing has been applied |
| `applied` | The candidate's `PATCH.diff` was applied to the canonical repo working tree |
| `rejected` | The winner was declined with a recorded reason; artifacts are retained |
| `sent-to-review` | The patch was handed to normal TL review as a proposal, without applying |
| `apply-failed` | Application failed; canonical files are unchanged and the error is recorded |
| `superseded` | A later decision named a different candidate; the old decision stays in the log |

### Commands

```text
tl experiment select         [ws] <experiment-id> <candidate-id> [--by <who>]
tl experiment apply          [ws] <experiment-id> <candidate-id> [--by <who>] [--repo <path>]
tl experiment reject         [ws] <experiment-id> <candidate-id> --reason "<why>" [--by <who>]
tl experiment send-to-review [ws] <experiment-id> <candidate-id> [--by <who>]
```

`apply` dry-runs first (`git apply --check`) and only then applies, so a patch that cannot apply cleanly leaves every canonical file untouched and records `apply-failed` with the error summary. `reject` requires a reason and never deletes candidate artifacts. Re-selecting a different candidate supersedes the earlier decision in the log; an `applied` decision can never be silently superseded — reverting an applied patch is a normal git operation a human performs deliberately.

### Artifacts

Every decision is legible and append-only:

- `_experiments/<id>/WINNER.json` — the current state: candidate, state, who decided (`decided_by` / `decision_source`), timestamp, patch path and SHA-256, reason or error summary.
- `_experiments/<id>/APPLICATION.md` — the review artifact, created on `applied` and `sent-to-review`. It points normal TL review back at the experiment, the winning candidate's artifacts, and the judge evaluation.
- `_metrics/winner-log.jsonl` — one row per decision, including supersessions. `WINNER.json` is state; the log is history.

Applying a patch does not move any spec through its lifecycle. The applied change sits in the working tree like any other in-flight work, and the normal human review gate still owns acceptance — `APPLICATION.md` exists exactly so a reviewer can trace the change back to its evidence.

### Future UI affordance

The Experiments detail view's winner panel already reads `WINNER.json` (degrading to the judge's pick). A later dashboard slice may add apply/reject buttons there, but they will follow the UI's existing write discipline: a button only records the human's decision request as a file — the patch application itself remains this explicit CLI/helper path, never a side effect of rendering or judging.

## Replay and benchmark suites

Replay answers "is a newly introduced model / framework / agent tool actually better?" by rerunning historical tasks against the new candidate runtime and comparing the outcome to the prior winner — updating nothing until the evidence clears the promotion policy. `lib/experiment-replay.js` owns the modes, suites, and comparison fold; every replay is a **normal experiment** (created through `queueExperiment`, drained by the same lane workers, judged by the same judge, replay-tagged via `replay_of` / `suite_id` in `EXPERIMENT.md`), so no second execution path exists to drift.

### Replay modes

| Mode | Task identity | Use |
|------|---------------|-----|
| `exact` | Original `spec_hash` **and** original `base_commit` | The fully controlled comparison — same task text, same source tree. Default for `tl experiment replay`. Refused loudly if the spec body has changed since (its hash would differ); the error names the alternative |
| `spec` | Same spec slug, **current** text and repo — rehash now, `base_commit` from the run repo's HEAD | The task drifted and you want the candidate measured on today's version; the comparison is honest that the task moved (`spec_hash_matches: false` in `REPLAY.json`) |
| `auto` | `exact` when the spec still hashes the same, else `spec` | The suite default — one changed spec degrades to a spec replay instead of sinking the whole benchmark pass |

Replay follows a spec through lifecycle stages: an experiment originally queued from `specs/foo/` replays fine after the spec moved to `done/foo/` — *moved* is not *changed*; only the body hash decides exactness.

```text
tl experiment replay [ws] <experiment-id> --candidate <tool>[:<model>]
        [--mode exact|spec|auto] [--repo <path>] [--budget <usd>] [--timeout <min>]
        [--command <cmd>]        # shell-lane candidates only
tl experiment replay report [ws] # fold judged replays into _metrics/replay-log.jsonl
```

The new candidate runs as the replay experiment's sole **primary** in its own lane (a `codex` replay row waits for a codex worker, exactly like any queue row). The original experiment's judge is reused by default. Alongside `EXPERIMENT.md`, replay writes **`_experiments/<id>/REPLAY.json`**: the mode, the original's `tl_spec` / `spec_hash` / `base_commit` / previous winner, and the candidate **runtime fingerprint captured at queue time** — the nine shared fields plus `tl_version` (see "Runtime Fingerprints"). That fingerprint is what lets a later reader say *the candidate changed because of the model / tool / adapter / framework / rules / skills*, not just *something changed*.

### Suites

A suite is a **stored selector query** over judged historical experiments — not a snapshot; selection happens at replay time:

```text
tl experiment suite create [ws] <name> [--spec <path>]… [--tag <tag>]… [--task-type <type>]… [--sample <n>] [--notes "…"]
tl experiment suite list   [ws]
tl experiment suite replay [ws] <name> --candidate <tool>[:<model>] [--mode …] [--sample <n>]
```

Definitions live at `_experiments/suites/<name>.json` (`suite_id`, `created`, `selectors: { specs, tags, task_types }`, `sample_size`, `notes`). Selection rules: **judged originals only** (a benchmark needs a prior verdict; replays of replays never become benchmark sources), selectors ANDed (empty = match all; `tags` reads the spec's frontmatter, following moved specs), deduped to the **newest experiment per `spec_hash`** (one benchmark per task), newest first, capped at the sample size. `suite replay` queues one replay experiment per selected task with `suite_id` set, in `auto` mode by default; an item that fails to queue is reported and skipped, never fatal to the batch.

### Comparison rows and promotion (`replay-log.jsonl`)

`tl experiment replay report` folds **judged** replay experiments into `_metrics/replay-log.jsonl`, appending one row per replay candidate exactly once (keyed by `experiment_id` + `candidate_id`; a rerun of the report appends nothing). Each row carries the SCHEMA fields — `date`, `experiment_id`, `replay_of`, `suite_id`, `candidate_id`, `previous_winner`, `new_winner`, `utility_delta`, `quality_delta`, `cost_delta`, `latency_delta`, `promotion_recommendation` — plus supporting fields: `agent_tool` / `agent_model` (the candidate runtime identity the promotion evidence aggregates by), `replay_status` and `fault`, `fingerprint_changes` (which fingerprint fields differ between the previous winner's run and the new candidate's run), `promotion_reason`, and `promotion_samples`.

Deltas are *new candidate minus previous winner*: utility from the two `SCORES.json` verdicts, quality from mean rubric scores, cost and latency from `candidate-run-log.jsonl`. A missing side yields a **null** delta, never a fake zero — an unjudged original (no prior winner) or a faulted replay compares as far as its evidence goes.

**Faults are reliability signals.** A replay whose run ends `unavailable`, `timed_out`, `over_budget`, or `invalid_output` still gets judged (non-winning), still gets a comparison row (`replay_status` + `fault` set, `new_winner: null` when nothing was eligible), and still counts as evidence about the candidate runtime. A lane with no worker simply stays queued — the report only ever folds judged replays.

**Promotion is threshold-enforced and recommendation-only.** Each row's `promotion_recommendation` (`promote` / `hold`) comes from `shouldPromoteFromReplays` in `lib/experiment-policy.js`, applied to the **cumulative** utility deltas for that candidate runtime (tool + model) across the whole replay log: it requires **both** at least `min_samples_to_promote` comparisons **and** a mean utility delta of at least `promote_utility_delta` (the same `experiments:` dials in `TRIAGE.yml` that govern prior-based promotion) — a new runtime never becomes the recommended default off a single win. As with `shouldPromote`, acting on the recommendation is a human `TRIAGE.yml` edit (`default_primary`); nothing in replay writes config, applies patches, or moves specs. Note the units: replay deltas are judge-utility points, while prior-based `shouldPromote` deltas are weighted-prior-score points; `promote_utility_delta` is the shared configurable bar for both.

## Portable core boundary

TL uses experiments now, but the experiment runtime is meant to spin out later as standalone open-source software — without TL's private learned-routing layer. To keep that path clean, TL treats itself as *one adapter over a generic core*. The core knows only about a small set of concepts; TL supplies the mapping to its own objects.

| TL concept | Generic core concept | Notes |
|------------|---------------------|-------|
| `SPEC.md` | task | Acceptance criteria, scope, allowed files, do-not-touch, base commit, spec hash |
| Intent | objective / campaign | The intent outcome is judge context — why the task matters |
| `FEEDBACK.md` | candidate report | One candidate's narrative artifact |
| `_experiments/` | experiment store | Where shadow attempts live until explicitly applied |
| `TRIAGE.yml` | policy config | Priority/weights inform routing and judging, not correctness gates |

`lib/experiment-adapter.js` is the seam. It defines the adapter interface and ships a TL *source* adapter plus provider-free *runner* proofs, so queue and runner code that grows later cannot bake in TL-specific assumptions.

### Adapter interface

Every agent (runner) adapter is a plain object exposing seven methods (`ADAPTER_METHODS`):

- `prepareTask(task, opts)` — normalize a generic task for this tool
- `startCandidate(prepared, opts)` — begin one candidate attempt, return a handle
- `collectArtifacts(handle, opts)` — gather patch, feedback, metrics, and trace
- `cancelCandidate(handle, opts)` — request cancellation
- `fingerprintRuntime(opts)` — return the runtime fingerprint (see above)
- `supportsHeadless(opts)` — whether the run needs no human/IDE present
- `estimateBudget(task, opts)` — a rough cost / time / token envelope

`isAdapter(x)` verifies all seven are present. The core speaks only this interface, so a shell script and a hosted agent are interchangeable to it.

The generic **task** object (built by `tlSpecToTask` / `tlSpecAdapter.toTask`) carries: `title`, `objective`, `intent_outcome`, `acceptance_criteria`, `scope.allowed_files`, `scope.do_not_touch`, `base_commit`, and a `spec_hash` (a SHA-256 of the spec body). `spec_hash` + `base_commit` are what make comparisons controlled: every candidate is judged against the same task text and the same source tree.

### Adapter capabilities

Capabilities are *data*, not behavior — the core reads them to decide where a candidate can run without probing the provider. Every adapter declares the full flag set (`CAPABILITY_FIELDS`), each coerced to boolean by `normalizeCapabilities`:

| Flag | Meaning |
|------|---------|
| `headless` | Can run with no human present |
| `streams_trace` | Emits observable `TRACE.jsonl` events during the run |
| `reports_model` | Reports the resolved model back (vs. unknown) |
| `supports_cancel` | Can honor a cancellation request mid-run |
| `supports_budget` | Accepts / enforces a cost or time budget |
| `requires_ide` | Needs an editor/IDE open to run at all |

**Cursor headless limitation, encoded as capability data.** `cursorCapabilities(mode)` returns different flags per mode: `'ide'` (default) is `headless: false, requires_ide: true` — Cursor's IDE chat needs the editor open; `'cloud'` is `headless: true, requires_ide: false, supports_budget: true` — the Cursor SDK/cloud worker can run headless when configured. The core routes accordingly with no Cursor API dependency.

`createShellAdapter()` is the provider-free proof: it satisfies the full interface with only Node stdlib, showing the contract is not tied to any Claude / Cursor / Codex SDK. It is headless, streams a trace, supports cancel, and reports no model (a shell command has none).

## TL UI dashboard

The TL cockpit (`ui/`) exposes a read-first **Experiments** view — a fourth top-level mode alongside Human / Split / Agent. It *observes* experiment artifacts; it never executes agents or shells out.

**Read endpoints** (added to `ui/server.js`, all localhost, all path-guarded via `safePath`):

- `GET /api/experiments?ws=<name>` — the queue list: one index-level summary per `_experiments/<id>/` (status, primary/shadow agents, judge, winner, candidate count), newest first.
- `GET /api/experiment?ws=<name>&id=<id>` — full detail for one experiment. The `id` is validated as a single path segment and resolved through `safePath` (no traversal). Returns the `EXPERIMENT.md` index, every candidate's `METRICS.json` fields, a **capped, secret-redacted** trace from `TRACE.jsonl`, optional `REASONING.md`, the judge's `SCORES.json` (hard gates, score dimensions, utility, winner, rationale), and a winner/application block (from an optional `WINNER.json`, degrading to the judge's pick).

**Redaction & capping.** Trace summaries and reasoning pass through a `redact()` filter server-side (API keys, tokens, JWTs, bearer/secret patterns → `[redacted]`) before leaving the server. Traces are capped at `TRACE_CAP` rows; the response carries `trace_total` and `trace_capped` so the UI can show "first N of M (capped)".

**What the detail view shows.** A short **task summary** (1–2 sentences) leads the header — from an optional `summary` field on `EXPERIMENT.md`, falling back to the first body paragraph — with any `labels` shown as chips (a seed for later classification/grouping). Candidate cards render role, status, tool, requested model (or `auto`), resolved model, model source, cost, duration, tokens, tests (task_complete), and fault reason — with the winner card marked. Each card has a collapsible trace timeline plus any reasoning summary. A **"Diffs — side by side"** section places each candidate's `PATCH.diff` in its own column (added/removed/hunk lines colored), capped at `PATCH_CAP` lines and secret-redacted like the trace, so variants can be compared directly on screen. The judge panel shows hard gates, a per-dimension score table, utility, the winner, rationale, and a human-override marker. The winner panel shows the selected candidate, patch artifact, apply/reject state, and any application-error summary.

**Variant (spin off a shaped repeat).** A **variant** button (a split-arrows glyph) in the detail header opens the queue form **pre-filled** from this experiment (runtime, tl spec, primary, shadows, judge) so you can *evolve what you're testing* before it runs — override per-role **models** (e.g. move the primary lane to a smaller model, swap the judge model) and add free-text **changes to instill** (`variant_notes`). Submitting writes a fresh `POST /api/experiment-queue` request tagged `replay_of: <id>`, carrying `variant_notes` and a `models` map. An experiment created this way is marked with a **variant** badge in the queue list (any summary whose `replay_of` is set). Like every UI write it only drops a config file into `_experiments/queue/` — a worker runs it; the UI never spawns anything, and the original run is untouched.

**Headless reality.** The view surfaces the headless caveats from the capability model: `queued` experiments show a "waiting for a worker" note, and any candidate whose `agent_tool` is Cursor shows a note that an IDE-closed run needs Cursor SDK/cloud/worker support.

**Write path (the only mutation).** `POST /api/experiment-queue` writes exactly one config file under `_experiments/queue/<stamp>-<slug>.json` (via `safePath`), capturing runtime (`fixture`/`local`), tl spec, primary + shadow candidates, judge, budget, and timeout. Queue workers pick this up and advance its `status`; the UI only *requests* a run. It never spawns a process. The form is reachable from the Experiments panel's **+ new** button and from a spec drawer's **experiment →** action (pre-filled with the spec path).

The whole surface follows the existing UI discipline: single-file zero-build `ui/index.html`, zero-dependency `ui/server.js`, all output `esc()`-escaped, all writes `safePath`-guarded. It degrades to an empty state when no `_experiments/` data exists yet.

### Private routing stays out of the core

Learned routing is explicitly *not* a core requirement. The open core's shipping transparent policy is `lib/experiment-policy.js` — the sole writer/selector for `_metrics/routing-priors.jsonl` (SCHEMA row shape: `date`, `context_key`, aggregates, `source`, …). Portable-core code reaches it through `createLocalRoutingPolicy` in `lib/experiment-adapter.js`, a thin `{ name, choose, record }` (plus `formatPriorRow`) adapter seam that *delegates* to that policy; it does not invent a second prior-row shape. A future private or hosted learned model implements the same seam and swaps in without the core ever depending on it.

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

Candidate folders contain `PATCH.diff`, `FEEDBACK.md`, `METRICS.json`, and optionally `TRACE.jsonl` and `REASONING.md`. `TRACE.jsonl` is for observable action events such as tool calls, file reads/writes, commands, tests, retries, and status changes. `REASONING.md` is optional and only for deliberate summaries a runtime exposes; private chain-of-thought is never required or stored.

Judge folders contain `EVALUATION.md` and `SCORES.json`. The markdown explains the comparison for humans. The JSON records hard gates, score dimensions, utility, winner, and rationale in a shape later routing logic can read.

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

## Statuses

Experiments and candidate runs use lowercase status strings: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `over_budget`, `unavailable`, `cancelled`, `invalid_output`, and `awaiting_evaluation`.

Winner application states are separate from run statuses and human-owned: `selected`, `applied`, `rejected`, `sent-to-review`, `apply-failed`, and `superseded`. See "Winner Application" below.

## Initiation and Headless Workers (queue / drain)

Experiments are initiated in one of two ways, both file-native:

- **Manual command** — `tl experiment queue [ws] <spec>` creates the experiment folder for a TL spec: it hashes the spec at queue time (`spec_hash`), records the source tree (`base_commit`, from `--repo`, default this checkout), selects candidates from explicit config (`--config <file>`) or the deterministic fixture defaults (`fixture-a` primary, `fixture-b` shadow, `fixture-judge` judge), and writes one **queued candidate row** per candidate. The spec itself is never moved — an experiment is a shadow attempt against a snapshot, not a claim.
- **UI request** — the dashboard's queue form drops a request config at `_experiments/queue/<stamp>-<slug>.json`. A drain pass folds pending `runtime: "fixture"` requests into real experiments (the request file is rewritten `status: "accepted"` with the `experiment_id` — an audit trail, never deleted). `runtime: "local"` requests need explicit candidate config (a command, a repo) the form doesn't collect yet, so they stay queued for a later slice.

The `--config` JSON for explicit cohorts:

```json
{
  "repo": "/path/to/canonical/repo",
  "budget_usd": 2.0,
  "timeout_minutes": 30,
  "judge": { "id": "judge-1", "agent_tool": "fixture" },
  "candidates": [
    { "id": "shell-a", "role": "primary", "agent_tool": "shell", "command": "…", "repo": "/path/to/repo" },
    { "id": "fixture-b", "role": "shadow", "agent_tool": "fixture" }
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

### Judge queueing

The judge row (role `judge`, lane from the experiment's `judge_tool`) is queued only once **every candidate run is terminal** — whichever lane finishes last queues it, and the experiment flips to `awaiting_evaluation`. A human can force evaluation of partial results with `tl experiment drain --agent <tool> --evaluate-partial <experiment-id>`; the forced judge row records that it was partial. Drain never *runs* judge rows in this slice — judging is the `skills/experiment-judge` procedure, and a judge worker is a later spec.

### Isolated runs (the worktree/clone strategy)

Local shell candidates never touch the canonical working tree. The runner creates a **detached git worktree** at the experiment's `base_commit` (`git worktree add --detach`, cheap — shares the object store), falls back to a **sibling clone** when worktrees are unavailable, runs the command inside it, collects `git diff` (intent-to-add first, so new files show) as `PATCH.diff`, and tears the workdir down. Fixture candidates are side-effect-free and need no isolation.

This is also the documented **seam for later orchestration**: `lib/experiment-runner.js` exports `createIsolatedWorkdir` / `removeIsolatedWorkdir` (the isolation strategy) and the `RUNNERS` registry (one entry per `agent_tool`; this slice ships `fixture` and `shell`). A real Claude/Codex/Cursor-SDK adapter registers one `RUNNERS` entry that wraps its prepare/start/collect cycle (per `lib/experiment-adapter.js`), and a remote/cloud worker replaces the workdir pair with its own sandbox provisioning — keeping the same promise: **the canonical repo is never mutated by a candidate run**.

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

Learned routing is explicitly *not* a core requirement. The open core ships only a local, file-backed policy (`createLocalRoutingPolicy`) that reads and appends priors to `routing-priors.jsonl` (`ROUTING_PRIORS_FILE`) and picks by a trivial observed win-rate baseline. A future private or hosted learned model is just another policy adapter satisfying the same `{ name, choose, record/formatPriorRow }` shape, so it can be swapped in without the core ever depending on it.

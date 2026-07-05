---
title: "Key routing priors on (agent_tool, agent_model, task_type)"
created: 2026-07-05
project: "throughline"
repo: "."
intent: ""                      # design context: docs/agent-experiments.md, "Private routing stays out of the core"
type: "feature"
status: "ready"
priority: "p2"
priority_set_by: "human"
size: "small"
depends_on: []
blocks: []
tags: [experiments, routing]
---

# Key routing priors on (agent_tool, agent_model, task_type)

## Objective

`createLocalRoutingPolicy().choose()` prefers the candidate with the best observed win-rate for the *task at hand* — keyed on `(agent_tool, agent_model, task_type)` — instead of a single global tally per `agent_tool`.

## Context

The local routing policy in `lib/experiment-adapter.js` is the open core's baseline for picking which agent runs a task. `formatPriorRow` already records `task_type`, `agent_tool`, and `agent_model` on every prior row, but `choose()` tallies wins by `agent_tool` alone — so "codex wins" is all the policy can ever learn, when the useful signal is "codex wins **on bug specs**". Agent runs are not commodities: result quality varies by harness *and* model *and* task type. The runtime-fingerprint fields every candidate record carries are exactly the join keys for this.

This stays inside the policy seam: deterministic, model-free, file-backed. A private learned policy remains just another adapter satisfying the same `{ name, choose, formatPriorRow }` shape.

## Acceptance criteria

- [ ] `choose(candidates, priors, context)` accepts an optional task context (at minimum `task_type`) and, when task-typed priors exist, ranks candidates by win-rate within that `task_type`
- [ ] The tally key includes `agent_model` when a candidate declares one (candidates may be `"name"` strings or `{ name, model }` objects); two models of the same tool tally separately
- [ ] Cold-start fallback is tiered and deterministic: no priors for `(tool, model, task_type)` → fall back to the tool-level tally → fall back to the first candidate (current behavior preserved when no context is given)
- [ ] Existing prior rows missing `task_type` or `agent_model` still count in the tool-level tier; malformed rows never throw
- [ ] `npm test` passes, with new cases covering: task-typed priors overriding the global tally, model-level separation, tiered fallback, and legacy rows
- [ ] `docs/agent-experiments.md` ("Private routing stays out of the core") notes the `(agent_tool, agent_model, task_type)` key and the fallback tiers

## Scope

### Files to touch

- `lib/experiment-adapter.js` — `createLocalRoutingPolicy`: extend `choose()` with the context parameter and tiered tally; `formatPriorRow` shape unchanged
- `test/experiment-adapter.test.js` — new cases for the criteria above
- `docs/agent-experiments.md` — one short paragraph on the prior key and fallback tiers

### Do not touch

- `ui/` — the cockpit only observes experiment artifacts; routing has no UI surface yet
- `bin/tl.js`, `skills/` — no verb changes; this is a library-level policy improvement
- `routing-priors.jsonl` row shape — append-only log; new keys come from fields already recorded

## Hints

Keep `choose()` backward compatible: the third parameter is optional, and `choose(candidates, priors)` must behave exactly as today. Treat an empty or unknown `task_type` in context as "no task tier" rather than a distinct bucket. Ties within a tier resolve by candidate order (first wins), so the result stays deterministic for the same inputs.

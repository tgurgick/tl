---
name: bench
description: The model bench — one place to benchmark models and run experiments in a clean, reactive notebook. Build agent loops, run eval grids, design metrics and judges, generate synthetic golden sets, and annotate results (HITL). Use when the user wants to compare models or prompts, build an eval, benchmark agents, create a golden/test set, or open the bench notebook UI.
---

# /tl bench

One place to benchmark models and run experiments: a reactive notebook (marimo's
model — cells form a dependency graph, edits dirty the downstream) whose cells
are typed nodes (n8n's model — data, prompt, agent loop, metric, judge, golden
set, eval grid, annotation). The notebook is one markdown file under the
workspace's `_bench/`; every output is a file.

The bench is a standalone package under `bench/` (own CLI, tests, README —
slated for its own repo); `tl bench` is the thin workspace-aware wrapper. Full
reference: `bench/README.md`; TL integration and split plan: `docs/bench.md`.

## The verbs

```
tl bench demo [workspace]                      # scaffold the demo notebook (offline, fixture provider)
tl bench list [workspace]                      # notebooks + golden sets
tl bench run  [workspace] <notebook> [cell]    # run headless (add --force to re-run fresh cells)
node bench/server.js --open                    # the notebook UI → http://localhost:4460
```

## Steps

1. **Resolve the workspace** the same way every skill does: the argument names
   a workspace under `projects/`; if exactly one exists, use it.

2. **If the user wants the UI** — check `curl -s --max-time 1
   http://localhost:4460/api/state`; if it answers, open the browser, else
   start `nohup node <tool-root>/bench/server.js --port 4460 --root
   <workspace-root> >/dev/null 2>&1 &` and open `http://localhost:4460`.
   Never auto-open a browser the user didn't ask for.

3. **If there is no notebook yet**, scaffold the demo (`tl bench demo <ws>`)
   and run it (`tl bench run <ws> model-compare`) — it proves the whole loop
   offline on the `fixture` provider. Then edit cells toward the user's real
   task: swap `provider:`/`model:` on agent and judge cells (`anthropic` needs
   `ANTHROPIC_API_KEY`; `openai` covers any OpenAI-compatible endpoint,
   including local ones via `BENCH_OPENAI_BASE_URL`).

4. **Author cells for the user's ask.** A benchmark needs at minimum: a `data`
   cell (inline rows, a workspace file, or `golden: <set>`), one `agent` cell
   per candidate (same shared `prompt` cell keeps the comparison controlled),
   and an `eval` cell binding them; add `metric` cells (code — free) before
   `judge` cells (LLM — costs). Cell configs are YAML inside ` ```tl-cell `
   fences; multi-line strings use `key: |` block scalars.

5. **Respect the HITL gates.** Synthetic rows a `golden` cell generates are
   `draft` until a human approves them (annotate cell with `golden: <set>`, or
   the UI); only `approved` rows flow into `data` cells by default. Never
   approve golden rows or write annotation labels yourself — those are human
   judgments; point the user at the annotate cell instead.

6. **Read results from files**, not memory: eval artifacts land under
   `_bench/runs/<notebook>/evals/<run>/` (`results.jsonl`, `summary.json`) and
   one summary row per candidate is appended to `_metrics/bench-log.jsonl`.
   Quote the summary table (winner, judge mean, metric means, tokens) when
   reporting a comparison.

## Rules

- The bench never mutates specs, intents, or source files — it writes only
  under `_bench/` and `_metrics/`. Applying a conclusion ("model X wins, use
  it") is normal TL work: capture a thread or spec.
- Runs are reactive: only stale cells re-run. `--force` re-runs the named
  cell; editing a cell's config dirties everything downstream of it.
- Deterministic first: prove a notebook's wiring on `provider: fixture`
  before pointing it at a paid provider.

# The Bench

The bench — one place to benchmark models and run experiments in a clean,
reactive notebook (marimo's cell graph × n8n's typed nodes) — is a
**standalone package incubating in this repo** under [`bench/`](../bench/),
slated to split into its own repository (the same public-tool trajectory as
`docs/repo-split.md` describes for the rest of the system).

The full reference lives with the package: [`bench/README.md`](../bench/README.md)
— notebook format, cell types (data, prompt, agent loops, metrics, judges,
golden sets, eval grids, HITL annotation), providers, and file layout.

## Independence

`bench/` is fully self-contained by design so the split is mechanical
(`git subtree split -P bench`, or a copy):

- **No imports from tl's `lib/`.** The two small helpers it needs — the
  YAML-subset parser and the `safePath` traversal guard — are vendored as
  `bench/lib/yaml.js` and `bench/lib/fsutil.js`. tl's copies stay canonical
  for tl; the bench's copies are canonical for the bench.
- **Own CLI** (`bench/bin/bench.js`: `demo` / `list` / `run` / `serve`), own
  `package.json`, own tests (`bench/test/`), own README.
- **No workspace assumption.** The engine takes any directory; the server
  treats a root without a `projects/` folder as a single workspace (standalone
  mode) and a root with one as a tl checkout (workspace-per-project mode).

## TL integration (what stays in this repo)

While the bench lives in-tree, tl wraps it thinly:

- `tl bench demo|list|run [workspace]` — the same verbs, workspace-resolved
  (`bin/tl.js` requires `bench/lib/*`; nothing bench-side knows about tl).
- `skills/bench/SKILL.md` — the `/tl bench` skill.
- Notebooks live per workspace at `projects/<ws>/_bench/`, and eval summary
  rows land in that workspace's `_metrics/bench-log.jsonl`, alongside the
  other metric logs.
- `npm test` at the repo root runs the bench's suite too.

After the split, `bin/tl.js` will require the published package (or a git
submodule/vendored copy) instead of `../bench/` — the seam is those two
`require` lines.

## Relationship to agent experiments

`docs/agent-experiments.md` defines the heavyweight harness: candidate
*agents producing patches* against a TL spec, judged as a cohort, with runtime
fingerprints and routing priors. The bench is the lightweight, interactive end
of the same spectrum — *model/prompt-level* comparison with instant feedback —
and shares its vocabulary (candidates, judges, hard verdicts, JSONL learning
surface) so results from either can feed the same downstream analysis.

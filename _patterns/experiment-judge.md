# Experiment judge rubric

The rubric a judge applies when comparing an experiment's candidate outputs — the guidelines a judge agent (or a human at `/tl experiment judge`) runs each candidate against, so that the verdict is repeatable, comparable across experiments, and structured enough to update priors later. Where `_patterns/review-gates.md` is what a *verifier* checks at the TESTS gate for one spec, this is what a *judge* checks across the two-or-more candidate runs of one experiment.

Run it against each candidate's `PATCH.diff`, the task's **acceptance criteria** (the mapped spec plus its parent intent's **Outcome**), `_patterns/review-gates.md`, the candidate's `TRACE.jsonl` (how it got there), and its `METRICS.json` (what it cost). The judge produces `EVALUATION.md` and `SCORES.json` per `_templates/SCHEMA.md`, and one `judge-log.jsonl` line.

The judge is an adapter — human, Claude, Codex, Cursor, or another tool — but the output contract is the same regardless of who judges. **The judge must differ from the primary candidate** (the same different-eyes discipline as the cross-model alignment check) unless the experiment explicitly sets `self_judge: true`; when it does, note it in the evaluation, because a self-judged winner is weaker evidence.

## Hard gates

Pass/fail, checked first. A candidate that fails **any** hard gate cannot win — it is scored, logged as learning data, and set aside (see Fault handling). Gates are not scores: they are the floor a candidate must clear to be eligible.

- **Patch applies.** `PATCH.diff` applies cleanly against the experiment's `base_commit`. A patch that won't apply is `invalid_output`, not a low score.
- **Acceptance criteria met.** Every acceptance criterion on the mapped task is actually satisfied — verified against the diff's behavior, not "looks done."
- **Tests pass or declared unavailable.** The task's tests run green, or the candidate explicitly declares no test suite exists / it was unavailable and says why. Silent absence of tests is a fail, not a pass.
- **No scope violations.** The patch stayed within the task's `Files to touch` and respected `Do not touch`; no unrelated refactors rode along (the `review-gates.md` **In scope** gate).
- **No security or code-standard failures.** The diff clears the security and code-standard gates in `_patterns/review-gates.md` — no secrets, no injection surface, no surprise network, no new dependencies, scoped writes, no leftovers, no regression.
- **Valid output.** Artifacts are present and parseable: `PATCH.diff`, `FEEDBACK.md`, and `METRICS.json` exist and can be read; the run did not terminate in a fault.

## Score dimensions

Each dimension is scored **1–5** on eligible candidates (those that cleared the hard gates). Scores are the comparative signal *above* the floor — two candidates can both pass every gate and still differ in quality. Anchor every score to the diff and trace, never to prose confidence.

| Dimension | 1 | 3 | 5 |
|-----------|---|---|---|
| `correctness` | Wrong or broken; introduces defects | Works for the happy path; edge cases shaky | Provably correct, edge cases handled, no regressions |
| `completeness` | Major acceptance criteria unaddressed | All criteria technically met, some thinly | Every criterion fully satisfied, nothing left implicit |
| `scope_discipline` | Wandered well outside declared files | Stayed in scope with minor incidental churn | Surgical — only what the task required, nothing extra |
| `maintainability` | Hard to follow; would rot fast | Readable, roughly matches house style | Clear, idiomatic, reads like the code around it |
| `test_quality` | No meaningful tests, or tests that don't test | Tests cover the main path | Tests cover edges and failure paths; would catch a regression |
| `explanation_quality` | `FEEDBACK.md` opaque or misleading | `FEEDBACK.md` states what changed and caveats | Clear asked-vs-delivered, honest gaps, useful handoff notes |

The score set is fixed so results are comparable across experiments and feed `SCORES.json`. A dimension a task genuinely can't exercise (e.g. `test_quality` where tests are legitimately unavailable) is scored against what *was* possible and noted in the evaluation, not silently dropped.

## Utility

Utility is the single comparable number the winner selection ranks on. It is **configurable per experiment** — the weights below are the starting defaults, tuned later from `judge-log.jsonl` and `routing-priors.jsonl` evidence — but the *shape* is fixed: a quality score, minus the costs of getting there.

```
utility = quality_score
        − cost_penalty        # cost_usd / tokens_used, normalized
        − latency_penalty     # duration_minutes, normalized
        − feedback_penalty    # review burden: how much a human must still do
        − failure_penalty     # tests flaky, retries, partial faults short of a hard fail
        − scope_penalty       # incidental churn short of a hard scope violation
```

- `quality_score` is the weighted mean of the six score dimensions (default: equal weights).
- Each penalty is normalized so no single term dominates; a candidate that is slightly better but far more expensive should not automatically win.
- The penalties are *soft* — they separate eligible candidates. A hard gate failure is not a penalty; it removes eligibility entirely.
- A judge records the weights it used in `EVALUATION.md`, so a replay with different weights is reproducible and comparable.

## Fault handling

A candidate run can end without a clean patch. Faults are **scored as non-winning but still logged** — a candidate that timed out or ran out of budget is evidence about that runtime on that task type, and it feeds priors just like a success does. Never discard a faulted run; that is the learning data.

| Fault | Meaning | Judge treatment |
|-------|---------|-----------------|
| `over_budget` | Stopped at the cost/token budget | Non-winning; log partial progress and where the budget went |
| `timed_out` | Stopped at the time limit | Non-winning; log how far it got and the last observable action |
| `unavailable` | Runtime/worker never ran | Non-winning; no patch expected; log the unavailability |
| `invalid_output` | Patch wouldn't parse, apply, or judge | Non-winning; a hard-gate fail; log the parse/apply error |
| `cancelled` | Stopped by a human or policy | Non-winning; log who/what cancelled and why |

A faulted candidate still gets a `judge-log.jsonl` line with `hard_gates_passed: false` and its fault recorded, so faults aggregate over time.

## Winner selection and tie-breaks

Among eligible candidates, rank by utility and apply tie-breaks in order — each only consulted when the previous is a tie:

1. **Hard-gate pass beats fail.** A candidate that cleared every gate always outranks one that didn't, regardless of scores.
2. **Higher utility.** The configured utility number.
3. **Lower review burden.** How much a human must still do before the patch is trustworthy — the `explanation_quality` / `feedback_penalty` signal.
4. **Lower cost.** `cost_usd`, then `tokens_used`.
5. **Human decides.** A genuine tie past this point goes to a person; the judge records `winner: null` with a note, and a human sets the winner.

**Human override.** A person can always overrule the judge. When they do, `SCORES.json` and the `judge-log.jsonl` line carry `winner_set_by: human` (vs. `judge`) with the human's rationale — the override is preserved and logged as its own signal, exactly like a `priority_set_by: human` triage override. The judge never silently discards a human's winner.

## How this is used

- **In `/tl experiment judge`** (see `skills/experiment-judge/SKILL.md`). A judge agent — different from the primary candidate — applies the hard gates, scores the dimensions, computes utility, picks a winner, and writes `EVALUATION.md`, `SCORES.json`, and the `judge-log.jsonl` line.
- **By a human.** The rubric is readable enough to judge by hand: the same gates, the same 1–5 dimensions, the same tie-break order. A human judge fills the same artifacts, or overrides an agent judge's winner.
- **For later learning.** Winner, utility, scores, and faults flow into `routing-priors.jsonl` and replay comparisons, so "what good looked like" on this task type updates future routing.
- **Extending.** Per-experiment weight overrides and per-workspace additions (extra gates, task-type-specific dimensions) can live alongside this; keep this file the shared baseline.

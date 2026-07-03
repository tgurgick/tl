---
name: experiment-judge
description: Judge an agent experiment's candidate outputs — apply the hard gates, score each candidate against the rubric, compute utility, and select a winner with a logged rationale. Use when the user wants to judge, evaluate, compare, or pick a winner among an experiment's candidate runs, or when an experiment is awaiting_evaluation.
---

# /tl experiment judge

The comparison gate for an experiment. Candidate runs are shadow attempts that never touch canonical `specs/`, `in-progress/`, `tests/`, `in-review/`, or `done/` — this skill reads their outputs and decides which one, if any, is the winner. It applies `_patterns/experiment-judge.md` (the rubric) the way `/tl review` applies `_patterns/review-gates.md`: the criteria are shared, so the machine judge and a human judge run the same check.

A winner here is a *nomination*, not an application — a winning patch becomes source-of-truth work only through the later explicit apply/review path (`experiment-winner-application`). This skill stops at the verdict.

## Resolve the experiment

Find the `_experiments/<experiment_id>/` folder. If none is named and one is `awaiting_evaluation`, take that one; if several are, list them and ask. If the candidates aren't terminal yet (still `queued`/`running`), say so and stop — there's nothing complete to judge.

**Check the judge is eligible.** Read `EXPERIMENT.md`. The judge agent **must differ from the primary candidate** unless the experiment sets `self_judge: true`. If they'd be the same and `self_judge` isn't set, stop and say so — a candidate can't judge itself into winning. If `self_judge: true`, proceed but flag it in the evaluation as weaker evidence.

## Steps

**1. Assemble the task contract.** The acceptance criteria to judge against: the mapped `tl_spec` plus its parent intent's **Outcome**, the allowed files, and the `base_commit`. This is the same contract every candidate was given.

**2. For each candidate, assemble the evidence:**
- `PATCH.diff` — what it actually changed, against `base_commit`
- `FEEDBACK.md` — the candidate's own report (a claim to verify, not a fact)
- `METRICS.json` — status, fault, cost, tokens, duration, runtime fingerprint
- `TRACE.jsonl` if present — how it got there: tool calls, test iterations, retries, scope violations
- `REASONING.md` if present — the deliberate rationale summary (never private chain-of-thought)

**3. Apply the hard gates** (`_patterns/experiment-judge.md`). Patch applies, acceptance criteria met, tests pass or declared unavailable, no scope violations, no security/code-standard failures, valid output. A candidate that fails any gate is ineligible to win — but you still score and log it. Note each gate result per candidate in `EVALUATION.md`.

**4. Score the eligible candidates** on the six dimensions, 1–5 each: `correctness`, `completeness`, `scope_discipline`, `maintainability`, `test_quality`, `explanation_quality`. Anchor each score to the diff and trace. A faulted candidate (`over_budget`, `timed_out`, `unavailable`, `invalid_output`, `cancelled`) is non-winning but still scored where possible and logged as learning data — never discarded.

**5. Compute utility** per the configurable formula: quality score minus cost, latency, feedback (review burden), failure, and scope penalties. Record the weights you used in `EVALUATION.md` so a replay is reproducible.

**6. Select the winner** by utility, then tie-breaks in order: hard-gate pass beats fail; higher utility; lower review burden; lower cost; then a human decides (`winner: null` with a note). If a human has already overridden, honor it: `winner_set_by: human` with their rationale, never silently replaced.

**7. Write the artifacts** (schema in `_templates/SCHEMA.md`):
- `evaluation/<judge_id>/EVALUATION.md` — the human-readable comparison: per-candidate hard-gate notes, scores, the utility weights used, the winner and why, and the review burden of the winning patch
- `evaluation/<judge_id>/SCORES.json` — machine-readable scores, utility, winner, `winner_set_by`, rationale, and per-candidate `hard_gates_passed`
- one `judge-log.jsonl` line under `_metrics/` — `date`, `experiment_id`, `judge_id`, `judge_agent`, `judge_model`, `status`, `winner`, `winner_set_by`, `rationale`, `scores_path`, `evaluation_path`, `utility`, `hard_gates_passed`, plus the cost signals

**8. Advance the experiment.** Set `EXPERIMENT.md` status past `awaiting_evaluation` (to `succeeded` when a winner is chosen, or record the no-winner outcome), and log the transition to `experiment-log.jsonl`.

**9. Report — the verdict.** The winner (or "no winner, human decides"), the utility ranking, which candidates failed which hard gates, and any fault-logged runs. Point to the evaluation artifacts.

## Guardrails

- **Different eyes.** The judge must not be the primary candidate unless `self_judge: true` — and a self-judged winner is flagged as weaker evidence.
- **Judge the diff, not the FEEDBACK.** A candidate's self-report is a claim to verify against `PATCH.diff` and `TRACE.jsonl`.
- **Never mutate source-of-truth.** Judging is read-only over the candidates and writes only under `_experiments/` and `_metrics/`. A winner is a nomination; application is a separate, explicit, human-gated path.
- **Log the faults.** Timed-out, over-budget, unavailable, invalid, and cancelled runs are still scored non-winning and logged — that's the learning data, not noise to drop.
- **Human override wins.** A person can always set `winner_set_by: human`; record it and its rationale rather than overwriting it.
- **Record the weights.** Utility is configurable; a verdict is only reproducible if the weights it used are written down.

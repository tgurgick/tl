# Canonical Throughline operating path

_Final operator contract — 2026-07-31. One operating story; product behavior is unchanged by this doc alone._

## Purpose

Throughline’s “E2E” had overlapping stories (interactive run, headless workers, verify drains, experiment fixtures, skill-only loop). This doc is the **canonical** path so operators and reviewers share one mental model. Everything else is a recovery tool, an advanced escape hatch, or a separate product.

## Naming — three different proofs

| Name | What it is | What it is not |
|------|------------|----------------|
| **Canonical operating path** (this doc) | Unattended (or lightly attended) work that moves a real-repo spec `ready → in-progress → tests → in-review`, then a **human** accepts `in-review → done` | A Playwright suite; agents promoting to `done/` |
| **Experiment fixture proof** | Shadow compare / research under `_experiments/` | “E2E” or the happy path |
| **Browser / CI E2E** | Optional product UI or CI agent-lifecycle suites | The default operating story |

Proof that the operating path works: `projects/throughline/done/headless-e2e-todo-app/` (GO) and `docs/headless-lanes.md`.

## The one happy path

```
steer → tl up → builder tick → manifest-backed tests/ queue → independent read-only verifier → human review → done/
```

| Step | Who | What |
|------|-----|------|
| 1. Steer | Human | Shape intents / specs (`new`, `decompose`, `groom`, …) until something is in `specs/` |
| 2. Start | Human | **`tl up <workspace>`** — cockpit + automation schedule from `TRIAGE.yml` + next human action (`open` is an **alias only**) |
| 3. Build | Headless lane | `tl-worker <ws> --agent <lane>` ticks: claim → build → finalize under lease → stop at `tests/` with a valid `outcome/HANDOFF.json` |
| 4. Verify | Other lane | **One scheduled** `tl-worker --mode verify` tick (primary) — independent, read-only; advances a clean pass to `in-review` |
| 5. Review | Human | `/tl review` or cockpit accept → `done/` (or kick back → `_dispatch/` continuation) |

Human verbs: **steer → run → review → learn**.  
Run’s happy-path command is **`tl up`**.

```
┌─────────┐     ┌──────────────┐     ┌────────────────┐     ┌───────────┐     ┌──────┐
│  steer  │ ──► │ tl up + ticks│ ──► │ verify (≠ bld) │ ──► │  review   │ ──► │ done │
│ (human) │     │ (automation) │     │  read-only     │     │  (human)  │     │      │
└─────────┘     └──────────────┘     └────────────────┘     └───────────┘     └──────┘
```

## Stage contract (folder = status)

| Folder | Meaning | Who may advance |
|--------|---------|-----------------|
| `specs/` | Ready queue | Builder claim → `in-progress/` |
| `in-progress/` | Claimed build | Builder finalize → `tests/` (after valid `HANDOFF.json`) |
| `tests/` | Code complete; verify gate | Verifier ≠ `claimed_by` → `in-review/` |
| `in-review/` | Awaiting human | **Human only** → `done/` |
| `done/` | Accepted | **Human only** — no agent path |

**Verifier eligibility** is a spec in `tests/` with a **valid handoff manifest**. Frontmatter flags, `VERIFY.md`, and cockpit verify-request files are **not** a second source of queue truth.

## Recovery vs artifacts

**Prepared-handoff recovery** (`tl recover`) finishes an interrupted `in-progress → tests` move only when:

1. A **valid, committed** `outcome/HANDOFF.json` is present (digests match), and  
2. The builder lease is **expired** (or the documented no-lease grace path applies).

**Artifacts alone are insufficient.** `FEEDBACK.md` + `BUILDER.diff` without a valid manifest is **legacy / no-manifest** — reclaim or repair by hand, never inferred completion. Recovery reuses the terminal manifest byte-identically (`reuse_only`); it never stamps or overwrites around an invalidated manifest.

## Interactive verbs = same contract, recovery launchers

| Surface | Role |
|---------|------|
| Interactive `/tl run` | Same procedure as a worker tick, human-driven — **supported** manual / recovery launcher |
| Interactive `/tl verify` / `tl verify --execute` | Same read-only lease + ALIGNMENT contract as the scheduled verify tick — **supported** recovery drain |
| Cockpit “Request verify” / `_metrics/verify-requests/*.json` | **Routing hints only** — do not execute a verifier and are not queue truth |
| `/tl loop` | Skill-only orchestration — advanced; overlaps `tl up` + workers |
| `tl open` | **Alias of `tl up`** — footnote only; do not teach as a separate product |
| Hand-rolled cron / launchd | Advanced escape hatch; prefer `TRIAGE.yml` `automation:` + `tl up` |
| Experiment queue / drain / apply | Orthogonal product — **experiment fixture proof**, not this path |

Prefer **one** configured verify tick (`automation.verify: true`). Other verify launchers stay available with **identical** contracts when you need to recover by hand.

## Verifier mutation proposals

The verifier is **read-only**. Any desired source change is `human-decision-required` in `ALIGNMENT` + `NOTES` — never applied by the verifier. Fix-forward requires **human authorization** and a **separate agent** continuation. The human gate to `done/` is never removed.

## Gates (why three checks exist)

1. **Tests folder** — builder’s acceptance checks green; terminal `HANDOFF.json` bound.
2. **Independent verify** — second agent/model; writes `ALIGNMENT`; ceiling `in-review`.
3. **Human review** — only path to `done/`; `auto_review` may lighten review, never skip it.

## Related reading

- `README.md` — four-verb quick start (`tl up`)
- `docs/headless-lanes.md` — worker ticks, lane config
- `docs/agent-experiments.md` — experiment loop (not this path)
- `_templates/SCHEMA.md` — handoff, verification, automation
- `skills/run/SKILL.md`, `skills/verify/SKILL.md` — interactive equivalents of the ticks
- `projects/throughline/done/headless-e2e-todo-app/` — GO proof on a real repo
- `projects/throughline/done/prepared-handoff-recovery/` — recovery = manifest + expired lease
- `test/canonical-e2e.test.js` + `test/fixtures/canonical-e2e/` — deterministic lifecycle / failure regression (fake lanes; no paid agents)

## Optional dogfood validation

CI and `npm test` use the deterministic suite above (injected seams, temporary git repos, no network or credentials). Optional live dogfood — two real headless lanes on a workspace after `tl up`, humans only at review — remains the proof in `projects/throughline/done/headless-e2e-todo-app/` and the recipes in `docs/headless-lanes.md`. That path is **not** required for the regression suite to stay green.

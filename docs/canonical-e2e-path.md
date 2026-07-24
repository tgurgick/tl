# Canonical Throughline E2E path

_Draft for review — 2026-07-24. Proposes one operating story; does not change product behavior._

## Purpose

Throughline’s “E2E” has grown several overlapping stories (interactive run, headless workers, verify drains, experiment fixtures, skill-only loop). This doc picks **one** path as canonical so operators and reviewers share the same mental model. Everything else is advanced or orthogonal.

## What E2E means here

**Canonical E2E** = unattended (or lightly attended) work that moves a real-repo spec:

```
ready → in-progress → tests → in-review
```

…with **builder ≠ verifier**, then a **human** accepts `in-review → done`.

It is **not**:

- A Playwright / browser CI suite
- Agents promoting work to `done/` (that hop is human-only)
- The experiment fixture / shadow-compare loop under `_experiments/` (valuable, separate product — call it **experiment fixture proof**, not E2E)

Proof that this path works: `projects/throughline/done/headless-e2e-todo-app/` (GO) and `docs/headless-lanes.md`.

## The one happy path

| Step | Who | What |
|------|-----|------|
| 1. Steer | Human | Shape intents / specs (`new`, `decompose`, `groom`, …) until something is in `specs/` |
| 2. Start | Human | **`tl up <workspace>`** — cockpit + automation schedule from `TRIAGE.yml` + next human action |
| 3. Build | Headless lane | `tl-worker <ws> --agent <lane>` ticks: claim → build → stop at tests with verify hand-off (`FEEDBACK`, `BUILDER.diff`, `awaiting_verifier`) |
| 4. Verify | Other lane | Scheduled verify tick **or** `tl verify` — independent of builder; advances to `in-review` |
| 5. Review | Human | `/tl review` or cockpit accept → `done/` (or kick back → `_dispatch/` continuation) |

Human verbs (already shipped): **steer → run → review → learn**.  
Run’s happy path command is **`tl up`** (`open` is only an alias).

```
┌─────────┐     ┌──────────────┐     ┌────────┐     ┌───────────┐     ┌──────┐
│  steer  │ ──► │ tl up + ticks│ ──► │ verify │ ──► │  review   │ ──► │ done │
│ (human) │     │ (automation) │     │ (≠bld) │     │  (human)  │     │      │
└─────────┘     └──────────────┘     └────────┘     └───────────┘     └──────┘
```

## Stage contract (folder = status)

| Folder | Meaning | Who may advance |
|--------|---------|-----------------|
| `specs/` | Ready queue | Builder claim → `in-progress/` |
| `in-progress/` | Claimed build | Builder → `tests/` |
| `tests/` | Code complete; verify gate | Verifier (≠ `claimed_by`) → `in-review/` |
| `in-review/` | Awaiting human | Human only → `done/` |
| `done/` | Accepted | Human only |

Incomplete handoff smell: `FEEDBACK` / `VERIFY` / `BUILDER.diff` present under `in-progress/` without `tests/` + `awaiting_verifier`. That work is invisible to verify until advanced — a known throughput leak.

## What is *not* on the canonical path

Keep these; stop teaching them as the default E2E story.

| Surface | Role | Why demoted |
|---------|------|-------------|
| Interactive `/tl run` | Same procedure as a worker tick, human-driven | Optional; automation is the default motion after `tl up` |
| Cockpit “Request verify” | Writes a verify-request **file** only | Does not run a verifier; ticks/skills drain it |
| `tl verify --execute` / skill verify | Valid drains | Prefer **one** configured verify tick in automation when possible |
| `/tl loop` | Skill-only orchestration | No CLI; overlaps `tl up` + workers — advanced |
| `tl open` | Alias of `tl up` | Footnote only |
| Hand-rolled cron copy-paste | Pre-`automation:` era | Prefer `TRIAGE.yml` `automation:` + `tl up` |
| Experiment queue/drain/apply | Shadow compare / research | Orthogonal product; do not call it “E2E” |

## Gates (why three checks exist)

1. **Tests folder** — builder’s acceptance checks green (or blocked with reason).
2. **Independent verify** — second agent/model; writes `ALIGNMENT`; ceiling `in-review`.
3. **Human review** — only path to `done/`; `auto_review` may lighten review, never skip it.

These are intentional for multi-lane safety. Streamlining should target **operator surface and stuck handoffs**, not collapsing human `done/` into agents.

## Known complexity (candidates to simplify later)

Ordered by leverage — proposals only; not commitments:

1. Teach a single operating path: `tl up` + scheduled run/verify ticks.
2. One primary verify drain (automation tick); treat other launchers as recovery tools.
3. Detect incomplete handoffs (artifacts in `in-progress/`) and advance into the verify queue without a 24h stall wait.
4. Naming: “headless dogfood loop” vs “experiment fixture proof.”
5. Retire dual naming in docs (`open` → alias footnote; TRIAGE KRs that still say agent → `done/`).
6. Avoid adding CI agent-lifecycle E2E until (1)–(3) are calm — unit tests + one dogfood workspace remain the proof bar.

## Related reading

- `README.md` — four-verb quick start
- `docs/headless-lanes.md` — worker ticks, lane config, E2E validation pointer
- `docs/agent-experiments.md` — experiment loop (not this E2E)
- `projects/throughline/done/verb-collapse-four-surfaces/` — human surface collapse
- `projects/throughline/done/headless-e2e-todo-app/` — GO proof on a real repo
- `projects/throughline/threads/2026-07-24-incomplete-handoff-stalls-queue.md` — stuck mid-handoff risk
- `projects/throughline/specs/incomplete-handoff-advance/` — proposed fix for (3)

## Review asks

When reviewing this draft, please comment on:

1. Is **`tl up` + worker ticks + human review** the right single happy path?
2. Should **interactive `/tl run`** stay first-class or become “advanced”?
3. Is demoting **experiment** out of the E2E label clear enough?
4. Which streamline item (1–6) should ship first — or is something missing?
5. Anything here that contradicts how you actually operate day to day?

---

_Status: draft for multi-reviewer feedback. No skills or product behavior changed by this file alone._

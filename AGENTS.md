# AGENTS.md

Standing instructions for **any** coding agent (Codex, Cursor, Gemini, Claude, …) working in this repo. If you have never seen Throughline (`tl`) before, this file plus the skills it points to are enough to drive a spec correctly with zero new tooling.

> **Intended test (cross-agent PoC).** The point of this file is that a non-Claude agent, given only this AGENTS.md, can pick up one ready spec and carry it to `in-review/` — no `tl`-specific tools, no plugin, just files and git. If you are that agent: follow the quickstart below. A human runs the live validation with Codex/Cursor separately.

## What tl is

Throughline is markdown-native project management for agent-driven work. Human **intents** (why) decompose into agent-ready **specs** (what to do now); **threads** capture what not to lose. There is no database and no server-of-record: **the markdown files are the database, git is the history, and a spec's folder is its status.** A zero-dependency local cockpit (`ui/server.js`) reads and writes these exact same files — nothing you do here is hidden from it, and nothing it does is hidden from you.

## Workspace layout

The tool lives in this repo. Actual work lives in **workspaces** under `projects/<name>/` (gitignored, private). One workspace per project:

```
projects/<name>/
├── TRIAGE.yml       # goals (weighted), allocation targets, priority rules
├── PRIORITIES.md    # generated ranked backlog (by /tl triage)
├── PROJECT.md       # project index / context map
├── intents/         # human objectives, outcome language
├── specs/           # agent-ready, not started  ← the READY QUEUE
├── in-progress/     # being worked
├── tests/           # code complete, at the test/verification gate
├── in-review/       # tests green, awaiting human sign-off (has outcome/FEEDBACK.md)
├── done/            # reviewed and accepted (human only)
├── threads/         # parked ideas, decisions, open questions, risks, cleanup
└── _metrics/        # append-only JSONL logs from skill runs
```

Each spec is a **folder**, self-contained:

```
specs/<slug>/
├── SPEC.md      # Objective, Acceptance criteria, Scope (Files to touch / Do not touch), hints
├── context/     # crash logs, code excerpts — things not derivable from the repo
├── outcome/     # FEEDBACK.md (+ agent notes), written when work completes
└── NOTES.md     # optional: human feedback left in the cockpit mid-flight — binding
```

The frontmatter contract for every file (`SPEC.md`, intents, threads, `FEEDBACK.md`) is defined in **`_templates/SCHEMA.md`** — read it before writing frontmatter. Enums are lowercase; dates are ISO (`YYYY-MM-DD`); parsers preserve unknown fields.

## The verbs — source of truth is the skills, not this file

Don't re-derive the procedures; follow them:

- **Work the queue** → read **`skills/run/SKILL.md`** and follow it step by step.
- **Orient / catch up on a workspace** → **`skills/resume/SKILL.md`**.
- **Sign off finished work** → **`skills/review/SKILL.md`** (human gate).

Supporting verbs, same pattern (one skill = one `skills/<name>/SKILL.md`): `triage`, `capture`, `promote`, `groom`, `decompose`, `map`, `goal`, `reflect`, `dedup`, `bug-capture`, `new`. Each `SKILL.md` is the algorithm; this file only orients you toward them.

## Critical rules — do not get these wrong

1. **Status IS the folder.** To change a spec's stage, **move its directory**. The stage chain is `specs/ (ready) → in-progress/ → tests/ → in-review/ → done/`. If a `status:` field and the folder ever disagree, the folder wins.
2. **Claim by moving.** To start a spec, move `specs/<slug>/ → in-progress/<slug>/` and set `status: in-progress`. The move is the claim — once it's out of `specs/`, no other agent can pick it up.
3. **Stop at `in-review/` — never write `done/`.** When work is complete and verification is green, write `outcome/FEEDBACK.md` (template: `_templates/FEEDBACK.md`) and move the spec to `in-review/` (`status: in-review`). An agent does **not** sign off its own work. Only a human accepts it to `done/` — via the cockpit's accept button or `/tl review`. This gate is what makes parallel fan-out safe.
4. **Honor each spec's scope.** Do the work only within `Files to touch`; treat `Do not touch` as a hard boundary. If a spec has `NOTES.md`, treat it as binding as the acceptance criteria.
5. **Capture discoveries as threads.** Anything worth not losing but out of scope — a decision, a follow-up, a risk, a discovery — becomes a file in `threads/` (see `skills/capture/SKILL.md`). An undocumented discovery is a leak; it does **not** justify widening the current spec.
6. **Files only.** Every change is a markdown/JSONL edit plus a folder move. No hidden state, no separate queue — `specs/` **is** the queue, the folders **are** the status.

## Quickstart: work one spec

You can follow this literally. (`skills/run/SKILL.md` is the full version — read it too.)

1. **Pick the workspace.** If `projects/` holds exactly one workspace, use it; otherwise the human names it.
2. **Pick a spec.** Look in `projects/<name>/specs/` (the ready queue). Prefer the highest priority per `PRIORITIES.md`; ties broken by oldest. Pick one whose `depends_on` are all already in `done/`.
3. **Claim it.** `git mv projects/<name>/specs/<slug> projects/<name>/in-progress/<slug>` and set `status: in-progress` in its `SPEC.md` frontmatter.
4. **Assemble the brief.** Read that spec's Objective, Acceptance criteria, Scope, any `NOTES.md`, its `context/`, the parent intent's Outcome, and the goal it ladders to (`TRIAGE.yml`).
5. **Do the work** in the spec's `repo`, strictly within `Files to touch`. Out-of-scope find → write a `threads/` file, keep going.
6. **Test gate.** Move to `tests/` (`status: tests`) and run the acceptance-criteria checks. If red, leave it in `tests/` as `status: blocked` with what broke, and stop.
7. **Hand to review.** On green, write `outcome/FEEDBACK.md`, then move `tests/<slug> → in-review/<slug>` and set `status: in-review`. **Stop here.** Do not move it to `done/`.
8. **Report** what you did: the spec's final state, any threads captured, and note that it now waits in `in-review/` for a human to accept via the cockpit or `/tl review`.

---
name: new
description: Guided setup of a new tl project workspace — interviews for goals, allocation targets, priority rules, and first intents, then scaffolds projects/<name>/ and runs the first triage. Use when the user wants to start, create, bootstrap, or set up a new project or workspace in tl.
---

# /tl new

Creates a working workspace through a short interview. Generate real content from the user's answers — never copy the sample project's content, only its shape.

Templates referenced below live in `_templates/`, resolved relative to this skill file (`../../_templates/`) — that path holds in a clone and in a plugin install.

## Where the workspace goes

Workspaces live in `projects/` under the current directory. If `projects/` doesn't exist, confirm before creating it — and if the directory is a git repo where `/projects/` isn't ignored, offer to add it to `.gitignore` (workspaces are usually private).

## The interview

One group of questions at a time. Offer concrete defaults with every question so a fast user can just accept them. Don't move on while an answer is vague enough to break triage later.

**1. Identity and repo.** Project name (becomes the folder — kebab-case), a one-line description, and the project's **repo identity**, recorded in PROJECT.md frontmatter:

- `repo:` — the local checkout path where the project's code lives, or will live. State the model plainly to the user: workspaces under `projects/` only *track* work — a project's code always lives in its own repo, never inside the workspace. If no repo exists yet, still interview for and record the intended path; creating the repo (`git init` at that path, push to the recorded remote) becomes part of the bootstrap spec below — tracked work with acceptance criteria, not a manual aside.
- `remote:` — the repo's remote URL, or explicitly `"none yet"`. An explicit `"none yet"` is an answer; a blank left by omission is a hole the preflight can't reason about.

**The tl checkout is never a project's repo.** Reject a `repo:` that is the tl root or any path inside it, and suggest a sibling directory instead (e.g. `~/Documents/GitHub/<name>` next to the tl checkout). The one exception — the workspace that tracks work on tl itself — requires the user's explicit confirmation that tl is the project, and is exactly that: the called-out exception, never a fallback when the real repo is missing.

**Repo preflight.** If a repo path or remote was given, check that it resolves. Keep it cheap and offline-tolerant:

- A local `repo:` path must exist and be a git repo; when `remote:` is also set, the checkout's `origin` must match the recorded remote.
- A `remote:` must answer `git ls-remote` with at least one ref beyond an empty/init-only state.
- An unreachable remote (offline, auth) is a **warning**, not a hard stop — `/tl new` must still work on a plane. Treat it like a failed preflight: the bootstrap spec carries the verification.

State the result to the user either way ("repo verified — origin matches, refs present" / "preflight failed: <what>"). The gate's durable output is always a file the board can see — the recorded mapping in PROJECT.md, and on failure the bootstrap spec — never just a console message.

**2. Goals (2–4).** "What matters for this project in the next 4–8 weeks?" For each goal: an id, a one-line description, a weight (weights sum to ~1.0 — propose the split, let them adjust), and 2–4 key results. Key results must be observable — push back gently on vague ones ("better UX" → "what would you see when it's true?").

**3. Allocation and rules.** Propose the defaults — bugs 0.30, features 0.50, tech_debt 0.10, research 0.10, drift_threshold 0.15 — and the three standard rules (widespread bug → p0, blocks > 2 → boost, stale bug → flag). Take tweaks; write the result.

**4. Error tracking.** Sentry, Datadog, or Bugsnag project to poll? Write the `error_tracking` block either way; default `enabled: false`.

**5. First intents (1–3).** "What outcomes do you want first?" Draft each from `_templates/intent.md` — outcome language, why it matters, one or two success metrics, in/out scope. For each intent, set its `goals` to the goal id(s) from step 2 that it serves — this is the top of the throughline, and `/tl map` flags any intent left without one. Show each draft and revise from feedback before writing the file.

**6. First spec (optional).** Offer to decompose the highest-priority intent into one spec from `_templates/spec/` — objective, testable acceptance criteria, file scope. Fine to skip; say specs can be written when the work starts. If a bootstrap spec exists (below), this spec gets `depends_on: ["<name>-bootstrap"]`.

## The bootstrap gate

External code is a spec, not an assumption. When the preflight **failed or was skipped** — no repo yet, empty or init-only repo, unreachable remote, origin mismatch — scaffold `specs/<name>-bootstrap/` from `_templates/spec/`:

- `priority: p0`, `priority_set_by: human`, `type: feature`.
- Objective: the project's code exists in its own repo and a fresh clone works.
- Acceptance criteria, concretely: `git ls-remote <remote>` shows the project's branch with commits beyond an empty/init-only state; a fresh clone passes the project's test command; the required entry files exist (name them from the interview). When no repo exists at all, creating it is part of this spec — `git init` at the recorded `repo:` path, push to the recorded `remote:`.
- Every other spec written at setup gets `depends_on: ["<name>-bootstrap"]`, and the bootstrap spec lists them in `blocks:`. Sequencing lives in frontmatter that `lib/batch.js` enforces — intent prose holds nothing back.

**Remote handoff rule.** Artifacts authored outside this machine land via a pushed git ref — verifiable with `git ls-remote` — never via bundle or tarball drops; the receiving spec's acceptance criterion checks the ref.

## Scaffold

Create, populating from the interview (frontmatter contract: `_templates/SCHEMA.md`):

```
projects/<name>/
├── TRIAGE.yml              # goals, allocation, rules, error_tracking
├── PROJECT.md              # from _templates/PROJECT.md — repo: + remote: from step 1, context map filled
├── intents/                # the drafted intents
├── specs/                  # the first spec, if drafted — plus <name>-bootstrap/ on a failed/skipped preflight
├── threads/
├── triage/
├── in-progress/
├── done/
└── _metrics/
```

## Finish

Run the `/tl triage` algorithm (`../triage/SKILL.md`) on the new workspace so it starts with a real `PRIORITIES.md` and its first `triage-log.jsonl` line. Then report: the workspace path, the top of the priority stack, and the two next actions — decompose remaining intents into specs, and schedule the daily triage/dedup runs.

## Guardrails

- Never overwrite an existing `projects/<name>/` — if it exists, stop and ask.
- Don't invent goals, metrics, or intents the user didn't express — defaults are for structure (allocation, rules), not for substance.
- Everything written must parse against `_templates/SCHEMA.md`.
- Never accept a `repo:` inside the tl checkout without the explicit tl-is-the-project confirmation; never skip recording `remote:` (`"none yet"` is the explicit form of "no remote").
- A failed or skipped preflight always leaves a bootstrap spec on the board — the gate's output is a file, not a warning that scrolls away.

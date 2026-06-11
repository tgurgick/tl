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

**1. Identity.** Project name (becomes the folder — kebab-case), a one-line description, and the path to the code repo if one exists.

**2. Goals (2–4).** "What matters for this project in the next 4–8 weeks?" For each goal: an id, a one-line description, a weight (weights sum to ~1.0 — propose the split, let them adjust), and 2–4 key results. Key results must be observable — push back gently on vague ones ("better UX" → "what would you see when it's true?").

**3. Allocation and rules.** Propose the defaults — bugs 0.30, features 0.50, tech_debt 0.10, research 0.10, drift_threshold 0.15 — and the three standard rules (widespread bug → p0, blocks > 2 → boost, stale bug → flag). Take tweaks; write the result.

**4. Error tracking.** Sentry, Datadog, or Bugsnag project to poll? Write the `error_tracking` block either way; default `enabled: false`.

**5. First intents (1–3).** "What outcomes do you want first?" Draft each from `_templates/intent.md` — outcome language, why it matters, one or two success metrics, in/out scope. Show each draft and revise from feedback before writing the file.

**6. First spec (optional).** Offer to decompose the highest-priority intent into one spec from `_templates/spec/` — objective, testable acceptance criteria, file scope. Fine to skip; say specs can be written when the work starts.

## Scaffold

Create, populating from the interview (frontmatter contract: `_templates/SCHEMA.md`):

```
projects/<name>/
├── triage.yml              # goals, allocation, rules, error_tracking
├── PROJECT.md              # from _templates/project.md — context map filled with known docs
├── intents/                # the drafted intents
├── specs/                  # the first spec, if drafted
├── triage/
├── in-progress/
├── done/
└── _metrics/
```

## Finish

Run the `/tl triage` algorithm (`../triage/SKILL.md`) on the new workspace so it starts with a real `priorities.md` and its first `triage-log.jsonl` line. Then report: the workspace path, the top of the priority stack, and the two next actions — decompose remaining intents into specs, and schedule the daily triage/dedup runs.

## Guardrails

- Never overwrite an existing `projects/<name>/` — if it exists, stop and ask.
- Don't invent goals, metrics, or intents the user didn't express — defaults are for structure (allocation, rules), not for substance.
- Everything written must parse against `_templates/SCHEMA.md`.

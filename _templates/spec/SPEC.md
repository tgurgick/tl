---
title: ""
created: YYYY-MM-DD
project: ""
repo: ""                        # path to the project repo
intent: ""                      # path to parent intent
type: "feature"                 # feature | bug | tech_debt | research
status: "ready"                 # ready | in-progress | blocked | done
priority: ""                    # p0 | p1 | p2 | p3
size: ""                        # small (< 1hr) | medium (1-3hr) | large (3-8hr)
depends_on: []
blocks: []
tags: []
---

# {title}

## Objective

{One sentence. What does "done" look like?}

## Context

{Why this matters, what the agent needs to know. Reference shared docs in the repo by path. Reference files in context/ for story-specific material.}

## Acceptance criteria

- [ ] {Specific, testable outcome}
- [ ] {Include test commands where possible}
- [ ] {Update shared docs if architecture changed}

## Scope

### Files to touch

- `path/to/file` — {what and why}

### Do not touch

- `path/to/file` — {why}

## Hints

{Suggested approach, edge cases, platform gotchas. Optional.}

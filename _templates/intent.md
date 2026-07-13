---
title: ""
created: YYYY-MM-DD
project: ""
status: "draft"                 # draft | approved | decomposed | done
goals: []                       # TRIAGE.yml goal id(s) this intent serves — the top of the throughline
priority: ""                    # p0 | p1 | p2 | p3
tags: []
specs: []                       # paths to specs derived from this intent
jira_key: ""                    # optional — JIRA epic key this intent mirrors; set by /tl sync
---

# {title}

## Outcome

{What does the world look like when this is done? Write in human language — outcomes, not implementation. "Users can sign up with one tap and their session persists across app restarts." Not "implement Cognito auth with JWT refresh."}

## Why this matters

{Who feels the pain? How do we know this is real? What happens if we don't do this?}

## Success metrics

| Metric | Target | How measured |
|--------|--------|-------------|
| | | |

## Scope

### In

- {What's included}

### Out

- {What's explicitly excluded}

## Constraints

- {Technical, timeline, cost, regulatory}

## Approach

{High-level phasing. Not implementation — that goes in specs.}

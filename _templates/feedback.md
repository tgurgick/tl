---
spec: ""                        # path to the completed spec
completed: YYYY-MM-DD
agent_model: ""                 # which model executed this (e.g., claude-fable-5)
scores:
  correctness: 0                # 1-5 — did it work?
  completeness: 0               # 1-5 — were all acceptance criteria met?
  scope_discipline: 0           # 1-5 — stayed within bounds, or drifted?
priority_was_right: true        # was this worth doing when we did it?
---

# Feedback: {spec title}

## Asked vs. delivered

{One or two sentences: what the spec asked for, what the agent produced, and the gap between them if any.}

## What went well

- {Decisions the agent made that were good.}

## What went wrong

- {Mistakes, misunderstandings, scope drift.}

## Pattern candidates

{Anything reusable for `_patterns/PATTERNS.md` — phrasing that worked, context that should have been included, a gotcha worth recording. Leave empty if nothing generalizes.}

## Carry-forward

{Anything the next spec or agent session should know based on this outcome.}

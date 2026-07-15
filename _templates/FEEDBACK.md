---
spec: ""                        # path to the completed spec
completed: YYYY-MM-DD
agent_model: ""                 # which model executed this (e.g., claude-fable-5)
agent_tool: ""                  # optional — which tool ran it: claude-code | cursor | codex | windsurf | other
duration_minutes:               # optional — wall-clock minutes to carry the spec to in-review
cost_usd:                       # optional — estimated API cost in USD
tokens_used:                    # optional — total tokens consumed
scores:
  correctness: 0                # 1-5 — did it work?
  completeness: 0               # 1-5 — were all acceptance criteria met?
  scope_discipline: 0           # 1-5 — stayed within bounds, or drifted?
priority_was_right: true        # was this worth doing when we did it?
---

# Feedback: {spec title}

## What shipped

{One to three sentences of outcome language: the value delivered, in human terms — not a file inventory. Resume reads this for its value line.}

## Asked vs. delivered

{One or two sentences: what the spec asked for, what the agent produced, and the gap between them if any.}

## What went well

- {Decisions the agent made that were good.}

## What went wrong

- {Mistakes, misunderstandings, scope drift.}

## Captured threads

{Discoveries that are out of scope but worth keeping — each becomes a file in `threads/`. List the paths, or "none". This is how agent discoveries avoid becoming scope creep or getting lost.}

## Pattern candidates

{Anything reusable for `_patterns/PATTERNS.md` — phrasing that worked, context that should have been included, a gotcha worth recording. Leave empty if nothing generalizes.}

## Carry-forward

{Anything the next spec or agent session should know based on this outcome.}

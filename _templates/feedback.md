---
story: ""               # path to the completed story
completed: YYYY-MM-DD
agent_model: ""         # which model executed this (e.g., claude-opus-4-6)
execution_time: ""      # rough duration
project: ""
tags: []
---

# Feedback: {story title}

## What was the story?

{One-line summary of what the story asked for.}

## What was delivered?

{One-line summary of what the agent actually produced.}

## Quality assessment

| Dimension | Score (1-5) | Notes |
|-----------|------------|-------|
| Correctness | | Did it work? |
| Completeness | | Were all acceptance criteria met? |
| Code quality | | Clean, idiomatic, maintainable? |
| Scope discipline | | Did it stay within bounds or drift? |
| Decision making | | Were autonomous decisions reasonable? |

## The gap

{What was the difference between what was asked and what was delivered? Be specific.}

### What went well

- {Decisions the agent made that were good.}

### What went wrong

- {Mistakes, misunderstandings, scope drift.}

### Surprises

- {Anything unexpected — good or bad — that's worth learning from.}

## Template improvements

{Based on this experience, what should change about how we write stories?}

- **Add to template:** {Fields, sections, or context that would have helped.}
- **Remove from template:** {Things that were ignored or caused confusion.}
- **Reword in template:** {Phrasing that was misinterpreted.}

## Context improvements

{What context was missing that the agent needed?}

- **Codebase knowledge:** {Patterns, conventions, or files the agent didn't know about.}
- **Domain knowledge:** {Business logic, user behavior, or constraints that weren't stated.}
- **History:** {Previous decisions or failed approaches that would have helped.}

## Carry-forward

{Anything the next story or agent session should know based on this outcome.}

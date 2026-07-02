---
name: decompose
description: Fold an accepted research recommendation or an approved intent into build specs — read the recommendation/outcome, draft testable, file-scoped implementation specs under the right intent, and write them on approval. Use when the user wants to turn a research recommendation into work, decompose an intent into specs, break down a plan into buildable tickets, or "fold research back into specs."
---

# /tl decompose

The missing rung between *deciding* and *building*. `/tl promote` turns a thread into an intent; `/tl decompose` turns an **intent** (or an **accepted research recommendation**) into the `ready` specs that implement it. It **proposes**; it writes only on approval; the result is specs an agent can pick up cold.

## Resolve the workspace

Same as `/tl triage`. The argument may also name a source: a `done/research-*/` spec (with an `outcome/RECOMMENDATION.md`) or an intent. With none, list the candidates and ask:
- **done research** whose recommendation has no build specs yet (the "research not folded back" case), and
- **starving intents** — `approved`/`decomposed` intents with no `ready`/active specs.

## 1. Read the source

- **Research spec** → read its `outcome/RECOMMENDATION.md` — the recommended direction, the options, and especially any "smallest first step / phasing." That's the spec plan.
- **Intent** → read its Outcome, Scope, and Approach.

## 2. Find the parent intent

Every drafted spec must ladder to an intent (never an orphan — `/tl map` flags orphans).
- Source is an intent → that's the parent.
- Source is a research spec with `intent:` set → use it.
- Source is an **orphan** research spec (`intent: ""`) → it needs a home. If an existing intent fits, use it; if the recommendation is a genuinely new direction, **stop and send the user to `/tl promote` or `/tl goal` first** — don't invent a goal-less intent.

## 3. Draft the specs

From the recommendation/intent, draft one spec per coherent unit of work (from `_templates/spec/`). Lead with the recommendation's **smallest-first-step** if it names one — a proof spec before the build-out. Each spec must have:
- an **Objective** (one sentence, what "done" looks like);
- **Acceptance criteria** that are testable — pull the concrete, checkable claims straight from the recommendation;
- a declared **`Files to touch`** scope. This is non-negotiable: undeclared scope is what forces `/tl run` to serialize everything. Naming the files is how decompose *earns* parallel fan-out downstream.
- a realistic `size`.

Keep specs small and independently shippable; prefer several narrow specs over one broad one, and give them **disjoint file scopes** where the work naturally splits, so they can run in parallel.

## 4. Propose, then write

1. **Show the drafted specs** — for each: title, objective, acceptance criteria, file scope, size, and the parent intent.
2. **Get explicit approval.** On "no", adjust and re-propose.
3. **Write** each spec under `specs/<slug>/`, `status: ready`, `priority` blank (triage ranks). Add each to the parent intent's `specs:` list. In a build spec derived from research, reference the source recommendation in Context (`done/research-<slug>/outcome/RECOMMENDATION.md`) so the agent has the reasoning.
4. The **research spec stays `done`** — it's a completed investigation; decompose reads it, never moves it.

## 5. After

Point at the next rung: `/tl triage` to rank the new specs, then `/tl run` to build (declared scopes mean run can fan out the disjoint ones in parallel). Note that `/tl map` should now show the intent laddering to real work — the throughline is whole from goal down to spec.

## Guardrails

- Never write a goal-less or intent-less spec. No home → `/tl promote` / `/tl goal` first.
- Every spec declares its `Files to touch` — decompose is where scope gets set, so fan-out works later.
- Draw scope from the recommendation/intent; don't invent work the source doesn't support.
- Decompose only — never implement. Building is `/tl run`.
- Propose → approve → write. No silent specs.
- Priority blank — triage owns ranking.

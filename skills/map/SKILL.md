---
name: map
description: Paint the throughline — the contribution ladder showing what every spec ladders up to (goal → intent → spec → outcome), overlaid with dependencies, and where the chain breaks. Use when the user asks what's this contributing to, what ladders up to this goal, show the roadmap/map, or where work has drifted from intent (learn).
---

# /tl map

Renders the **throughline** — the traceability ladder that is the product's whole premise: every spec traces up through an intent to a goal. Where `/tl triage` ranks and `/tl resume` orients, `map` shows the *structure*: what's delivering what, and where the chain is broken. Read-only.

## Resolve the workspace

Same as `/tl triage`: argument is a workspace name under `projects/` or a path; exactly one workspace → use it; otherwise ask.

## The ladder

The chain is `goals → intents → specs → code`:
- `TRIAGE.yml` defines **goals** (id, weight).
- each **intent** declares the `goals` it serves.
- each **spec** names its parent `intent`, and may `depends_on` / `block` other specs.

## Steps

**1. Read** `TRIAGE.yml` (goals), `intents/` (with their `goals` and `specs`), all specs across stages (frontmatter: `intent`, `status`, `priority`, `size`, `depends_on`, `blocks`).

**2. Build the ladder.** For each goal in `TRIAGE.yml`, ordered by weight:
- list the intents whose `goals` include it
- under each intent, its specs grouped by stage (done / in-progress / ready / triage), each with priority and size
- within an intent, note the dependency order (what `depends_on` what) — the local critical path

**3. Find the breaks** — every missing rung is a throughline gap, and the most useful thing on the map:
- **orphan specs** — a spec with no `intent` (work with no stated reason)
- **goal-less intents** — an intent with empty `goals` (an outcome serving nothing measured)
- **starving goals** — a goal with no intents, or whose intents are all `done` (a stated priority with nothing delivering it)
- **dangling dependencies** — a `depends_on` pointing at a spec that doesn't exist

**4. Render** the ladder as an indented tree (goal → intents → specs with status), then a **Breaks** section listing every gap. For any single node the user names, state its throughline in one line: *"spec X → intent Y → goal Z (weight W)."*

**5. Offer**, don't perform: for each break, the obvious repair (link this intent to a goal, decompose this starving goal, give this orphan an intent) — but `map` never edits. Fixing a break is a `/tl capture`, an intent edit, or a `/tl new`-style decomposition the human chooses.

## Guardrails

- Read-only — `map` reads and draws, never writes.
- An intent may serve more than one goal; show it under each.
- The breaks are the point. A map with no breaks is a complete throughline; a map full of orphans is work that has drifted from intent — say so plainly.

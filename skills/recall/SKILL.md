---
name: recall
description: Unified retrieval across a tl workspace's memory — search intents, specs (all stages), threads, and done outcomes to answer "didn't we already discuss this?". Use when the user asks whether something was already considered, wants prior discussion on a topic, or before drafting a new intent/spec to check for overlap (learn). Read-only.
---

# /tl recall

Answers **"didn't we already discuss this?"** — one query across a workspace's whole memory: intents, specs at every stage, threads, and done outcomes. It surfaces the prior discussion so you don't re-decide what's already decided or re-open what's already closed. Read-only; needs no network, no index, no embeddings — the markdown files are the corpus.

## Resolve the workspace

Same as `/tl resume`: the argument names a workspace under `projects/`; exactly one workspace → use it; otherwise ask.

## The corpus

Search every markdown file that holds a decision, a plan, or a record:

- `intents/` — the human objectives.
- **all spec stages** — `specs/` (ready), `in-progress/`, `tests/`, `in-review/`, `done/`, `triage/` — each spec's `SPEC.md` (and `NOTES.md`).
- `threads/` — parked ideas, decisions, open questions, risks, follow-ups.
- `done/*/outcome/` — `FEEDBACK.md` and `ALIGNMENT.md`, where completed work recorded what actually happened and what to carry forward.

## Search and rank

Use simple, transparent text search — no fuzzy magic. Split the query into terms; a file matches if its title/frontmatter or body contains them (case-insensitive). Score by:

1. **Title / frontmatter hit** — highest signal; the file is *about* the topic.
2. **Body hit** — the topic is discussed inside.
3. **Recency** — newer files break ties, so the freshest discussion floats up.

`tl recall <workspace> <query>` prints this deterministic snapshot for you: the matching files, their kind, and a short snippet of the matched context. That is your read — you don't need to re-grep.

## Group by kind

Present the matches grouped so the answer reads as *where the topic lives*, not a flat list:

- **decision** — threads of `type: decision` (and decision-flavored notes in outcomes). "This was already decided."
- **open thread** — threads still `status: open` / `parked` (questions, risks, follow-ups). "This is still unresolved."
- **ready / active spec** — specs in `specs/`, `in-progress/`, `tests/`, `in-review/`, `triage/`. "Work already exists for this."
- **done outcome** — `done/` specs and their `outcome/` files. "This was already built; here's what happened."
- **recommendation** — completed `type: research` specs whose outcome recommends a direction. "There's already a recommendation on this."

Where a match's kind isn't detectable from frontmatter, place it under the closest stage-based bucket and say so.

## Answer

Lead with the verdict, then the evidence:

1. **Have we discussed this?** — yes / partially / no, in one line.
2. **Prior discussion** — the grouped matches, most relevant first, each as `kind: title (path)` plus the one-line snippet that matched. Enough context that the reader doesn't re-open the files.
3. **Next action** — the concrete move: reuse the existing spec, answer the open thread, adopt the recommendation, or (if truly nothing) proceed and note that recall found no prior art.

## Guardrails

- **Read-only.** `recall` searches and reports; it never creates, edits, moves, or deletes a file. Acting on what it surfaces (open a spec, resolve a thread, promote an idea) is a separate, explicit verb.
- **Local and zero-dependency.** No external search, no embedding store, no server — plain text search over the workspace files. If the corpus outgrows this, that's a new spec, not a silent dependency.
- **Cite paths.** Every claim of prior discussion names the file that backs it, so the reader can verify.
- If nothing matches, say so plainly — "no prior discussion found" is a first-class, useful answer.

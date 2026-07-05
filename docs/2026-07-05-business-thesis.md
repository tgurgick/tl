---
title: "Business thesis: observe, judge, prove — routing falls out"
created: 2026-07-05
project: "throughline"
origin: "conversation on agent execution vs OpenRouter/OpenClaw"
status: "working"                # working — iterate here before anything becomes an intent
tags: [business, positioning, routing, experiments, enterprise]
explored:
  - "Layer distinction: routing tokens (OpenRouter) vs routing tasks (tl)"
  - "Individual multi-sub segment — why routing value is weak there"
  - "Enterprise multi-stack: three budgeted pains, only one is routing"
  - "Wedge sequencing: governance → eval data → routing"
  - "Neutrality as the structural moat vs platform orchestrators"
unexplored:
  - "Pricing shape (per-seat vs per-repo vs per-report)"
  - "Consultancy/agency segment sizing"
  - "How stale priors get with model churn — decay policy for the data moat"
  - "Whether the cockpit UI needs to lead the commercial story"
---

# Business thesis: observe, judge, prove — routing falls out

Working doc. Not an intent, not a spec — the place to iterate on positioning
before anything is promoted. The repo-split doc names agent routing as "the
monetizable edge"; this doc argues for a re-sequencing. When a position here
hardens, promote it (intent) and cross-reference back.

## The one-line thesis

**tl is "Datadog for agent-driven development" — observe, judge, prove — with
routing as the feature that falls out of the accumulated evidence, not the
headline product.** "OpenRouter for agents" is a fair elevator pitch for the
mechanism, but it points the business at the weakest of the three assets.

## The layer distinction (why we are not OpenRouter)

OpenRouter routes **tokens per request** — synchronous, commodity completions,
selected on price and uptime, failover mid-request. tl routes **tasks per
run** — asynchronous jobs measured in minutes-to-hours, producing artifacts
(patch, feedback, trace) that land in a review queue. Two consequences:

1. Agent runs are not commodities. Result quality varies by harness × model ×
   task type, so the routing signal has to be *judged outcomes*, not latency.
   That is what the experiments layer produces and what OpenRouter structurally
   cannot have.
2. The reliability story is "re-run the task elsewhere," not "fail over
   mid-request." tl is a dispatcher over heterogeneous runners — closer to a CI
   system than an API gateway — and stays complementary to OpenRouter (a
   runner's model traffic can flow through it).

## Segments

**Individuals with multiple agent subs — adoption channel, not revenue.**
The segment exists (Claude Code + Cursor + Copilot stacks are common) but
routing barely helps them: choices are made by habit, the marginal gain
doesn't cover the overhead, and a solo backlog never accumulates
statistically significant priors. Free tool, word of mouth, nothing more.

**Enterprises with multi-stack — real, but read *why* they're multi-stack.**
Usually organizational accident, not optimization: Copilot bought org-wide by
procurement, Cursor adopted team-by-team, Claude Code smuggled in by power
users. That shape produces three budgeted pains:

| Pain | Budget exists? | tl's asset |
|------|----------------|------------|
| **Governance/audit** — which agent changed what, under whose sign-off, traceable to what business reason | Yes — compliance, platform eng | Intent → spec → outcome ladder, human-only `done` gate, runtime fingerprints, append-only file trail |
| **Procurement intelligence** — which of our four agent products earns its seats *on our codebase* | Yes — renewal decisions | Experiments layer: internal SWE-bench on your own backlog, judged outcomes with evidence artifacts |
| **Routing/orchestration** — dispatch the backlog to the best agent | No line item; contested ground | Adapter contract + priors — but platforms give orchestration away free |

**Two segments to add to the map:** consultancies/agencies running client work
across whatever stack each client mandates (multi-stack by necessity, buy
tools rather than build), and platform-engineering teams at ~200–2,000-dev
companies being asked "what's our agent strategy" with no measurement
instrument at all.

## The wedge is neutrality

GitHub's Agent HQ is the platform version of the orchestration play — mission
control over multiple third-party agents, bundled into Copilot. Every vendor
wants to be the orchestrator. Competing head-on means fighting platforms that
give the mechanism away. The structurally defensible position is the one the
platforms *cannot* take:

- **A vendor-neutral judge.** GitHub will never tell you Copilot loses to
  Claude on your refactors; Cursor won't benchmark itself against Codex.
- **Protocol over plugin.** tl rides `AGENTS.md` and files-plus-git, not any
  vendor's integration surface.
- **Local-first, no daemon.** A real story for regulated buyers who won't pipe
  their SDLC through a hosted orchestrator.

## Sequencing

1. **Governance/traceability is the wedge.** Budget exists, no incumbent owns
   it, and the file-native design is the moat.
2. **Evaluation data is the accumulating asset.** Generated as exhaust from
   normal use — the data-gravity moat. (Repo-split already says it: "the
   aggregate *is* the paid product.")
3. **Routing is the autopilot feature** unlocked once priors exist — not the
   product. This ordering also solves routing's cold-start problem: the
   governance and eval layers are what generate the outcome data routing needs
   to be any good.

## Risks

- **Prior staleness.** Agent/model churn makes win-rates stale in months. The
  fingerprint discipline mitigates (you know exactly what a prior measured)
  but doesn't solve it — needs a decay policy. (Unexplored.)
- **"Not a product" perception.** Markdown-and-git is a developer aesthetic;
  enterprise buyers may need the cockpit UI to lead the commercial story more
  than the repo currently treats it.
- **Copyability.** If the wedge works, platforms copy the visible mechanism.
  The moat must be the accumulated judged-outcome corpus and the
  neutral-arbiter position, not the mechanism itself.
- **Sample size.** Even enterprise backlogs may be thin per (task_type ×
  agent × model) cell. Cross-customer aggregation is the fix and is already
  the planned private layer — but it raises the privacy bar.

## Open questions

- Pricing shape: per-seat (governance buyer) vs per-repo (platform team) vs
  per-report (procurement intelligence at renewal time)?
- Does the eval report stand alone as a product ("agent renewal audit") before
  any continuous deployment of tl?
- How much of Agent HQ's surface overlaps in practice once it ships broadly —
  where exactly does neutrality bite?
- Minimum evidence bar for a procurement claim: how many judged runs before
  "A beats B on bug specs here" is defensible?

## Log

- **2026-07-05** — Created from the OpenRouter/OpenClaw comparison
  conversation. Core move: demote routing from headline to feature; promote
  governance + procurement intelligence. Related in-repo work: routing-priors
  task-keying spec (`specs/routing-priors-task-keyed/`).

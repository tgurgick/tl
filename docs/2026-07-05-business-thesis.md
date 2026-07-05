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
  - "The trade: transparent method, private evidence — where the edge relocates"
  - "Contribution accounting: the agent-group ledger tied to goals/KRs"
unexplored:
  - "Pricing shape (per-seat vs per-repo vs per-report)"
  - "Consultancy/agency segment sizing"
  - "How stale priors get with model churn — decay policy for the data moat"
  - "Whether the cockpit UI needs to lead the commercial story"
  - "How KRs bind to live metric sources (per-goal adapters in TRIAGE.yml?)"
  - "Agent group: first-class schema concept vs aggregation over fingerprints"
  - "Claim language: contribution accounting vs causal ROI"
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

Refinement (see "Contribution accounting" below): the concrete product at the
center is a **ledger** — per agent group, what was produced, what it cost, and
what business goal it laddered to — with governance and procurement
intelligence as two views over that same ledger.

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

## The trade: transparent method, private evidence

The neutrality play does not mean giving up proprietary protection of the
tool — repo-split already open-sourced the tool deliberately. What it changes
is **where the proprietary edge lives**.

Given up:

- **The mechanism as moat.** Protocol, adapter contract, judge rubrics — open
  and copyable. Platforms can imitate every visible part once it works.
- **Lock-in as a retention lever.** A files-and-git protocol any
  `AGENTS.md`-reading agent can drive means customers can leave cheaply.
- **The routing algorithm as the sellable secret.** Thin IP anyway — a few
  hundred lines anyone can approximate.

Gained, and where the edge relocates:

- **The credibility to be the judge at all.** Transparency is not a trait
  traded away for protection — it is the *entry requirement* for the arbiter
  position. A judge whose methodology is closed isn't neutral; nobody stakes a
  renewal decision on a black box, and vendor-run orchestrators fail exactly
  this test. Open method is what makes "Copilot loses to Claude on your
  refactors" an actionable claim.
- **The asset becomes the data and the position, not the code.** The
  judged-outcome corpus (per-customer and cross-customer aggregate), the
  accumulated priors, and the arbiter reputation. A competitor can clone the
  harness in a quarter; they can't clone years of judged runs.

The formulation: **transparent method, private evidence.** The judge, the
protocol, the fingerprint discipline — public and auditable; that openness is
the credibility. The aggregate outcomes flowing through it — private; that is
what's sold. Standard-setter play: everyone trusts the ruler, one party holds
all the measurements.

Tension to manage: the more open the method, the easier for a platform to run
it internally and claim equivalence. The defense — a vendor grading itself is
structurally not credible regardless of rubric — only holds if the arbiter
position is taken *first* and the corpus compounds.

## Contribution accounting: the ledger is the product

The sharpest version of the thesis: the real value is a way for an
organization to measure **what each agent group produces and what it's worth
to the business** — an accounting layer nobody has built.

**Why tl is unusually positioned.** The hard part isn't measuring, it's the
**attribution chain** — and tl forces one to exist as a side effect of how
work enters the system. Every measurement product today (Copilot dashboards,
DX, Jellyfish, LinearB) works from exhaust — commits, PRs, cycle time — so it
can report *activity* but structurally cannot report *value*: by the time
work hits git, the "why" is gone. tl never loses the why. The chain
`agent run → spec → intent → weighted goal → key result` is the spine the
tool already makes you build, not something bolted on for measurement.

**What already exists in-repo:**

- *Agent groups, primordial form* — the `agent:` fan-out lanes, `claimed_by`,
  runtime fingerprints. A "group" is an aggregation key over fields already
  recorded per run.
- *Cost capture* — `FEEDBACK.md` cost-signal fields; `_metrics/*.jsonl` as the
  append-only substrate.
- *The metric-hook precedent* — `bug-capture` already binds to external
  systems (Sentry/Datadog); the `loop` skill already checks key results per
  iteration. Binding KRs to live metric sources is the same integration
  pattern pointed at the other end of the pipeline.

**What's missing:** the aggregation layer — roll-ups across workspaces and
teams, per-lane accounting ("the codex lane consumed $X and shipped 14
accepted specs under the retention goal, whose KR moved by Y"), and the
executive surface. Real product work, but a reporting layer over data the
protocol already emits — exactly the open-core/private-extension shape
repo-split planned.

**The causal-ROI trap.** A KR moving after specs ship is confounded by
everything — market, lag, other teams, seasonality. Claim "this agent group
generated $Z of business value" and a sharp CFO dismantles it in one meeting.
The defensible claim is **contribution accounting**: this spend, through these
agent groups, produced this accepted work, laddered to these weighted goals,
and the KRs moved alongside — auditable from the file trail, honest about
causation, and still a category beyond "PRs merged."

**What this does to the thesis:** it collapses pains #1 and #2 into one
product — governance (the audit trail) and procurement intelligence (which
agent earns its seats) become *views over the same ledger* — and the buyer
moves up, from platform engineering to the VP/CFO currently approving seven
figures of agent spend with no P&L visibility. Bigger market, emptier.

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

With contribution accounting in the picture, steps 1 and 2 converge: the
ledger *is* the governance trail and the eval dataset at once. The sequencing
becomes: ship the ledger, sell its two views, let routing fall out.

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
- How do KRs bind to live metric sources — per-goal adapters declared in
  `TRIAGE.yml`, following the `bug-capture` provider pattern?
- Does "agent group" become a first-class schema concept, or stay an
  aggregation over fingerprint/lane fields?
- Claim language: where exactly is the line between contribution accounting
  (defensible) and causal ROI (a trap)?

## Log

- **2026-07-05** — Created from the OpenRouter/OpenClaw comparison
  conversation. Core move: demote routing from headline to feature; promote
  governance + procurement intelligence. Related in-repo work: routing-priors
  task-keying spec (`specs/routing-priors-task-keyed/`).
- **2026-07-05 (later)** — Two refinements from continued discussion. (1)
  "The trade" — the edge relocates from mechanism to data + arbiter position;
  transparent method, private evidence. (2) "Contribution accounting" — the
  product core is a per-agent-group ledger tied to weighted goals/KRs;
  governance and procurement intelligence become views over it; buyer moves up
  to VP/CFO. Causal ROI explicitly rejected as claim language.

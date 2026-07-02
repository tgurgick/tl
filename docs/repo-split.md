# Repo split: public tool, private everything else

Throughline is two things kept apart on purpose: a **tool** and the **work** done with it. The tool is public and project-agnostic. The work — your workspaces, your metrics, your notes — is private and never leaves your machine unless you push it somewhere yourself. A second boundary sits further out: the open-source tool versus the **proprietary extensions** (agent routing, benchmark aggregation, JIRA sync) that will live in a separate private repo and depend on the tool's *data format*, never its code.

This doc draws both lines and says where new things go, so the split stays legible and enforced rather than eroding one convenient exception at a time.

## The two boundaries

1. **Tool vs. workspace** — inside *this* repo. The tool (`skills/`, `ui/`, `bin/`, `_templates/`, packaging) is committed and public. Workspaces (`projects/<name>/`) are gitignored and private. One `.gitignore` line enforces it.
2. **Public tool vs. private extensions** — *across* repos. The public tool emits structured data (JSONL, frontmatter). The private repo consumes that data and layers on monetizable features. The public repo never imports, references, or knows about the private one. The connection is a data contract, not a code dependency.

Boundary 1 is already live and enforced. Boundary 2 is a design target for the enterprise offering (`intents/enterprise-offering.md`); this doc defines it so the specs that follow — JIRA sync, benchmark analytics — know where their code belongs.

## What's public (the tool)

Everything the tool needs to run, and nothing about any particular project.

| Path | What it is |
|------|-----------|
| `.claude-plugin/` | Plugin + marketplace manifest — installs as `tl` |
| `skills/` | The verbs: new, resume, capture, promote, groom, decompose, run, review, map, triage, reflect, dedup, bug-capture, goal, ui |
| `_templates/` | `SCHEMA.md` (the frontmatter contract), `intent.md`, `spec/`, `thread.md`, `bug.md`, `FEEDBACK.md` |
| `_patterns/` | `PATTERNS.md` — the spec-authoring guide |
| `examples/sample-project/` | A populated workspace to copy from — synthetic, no real work |
| `ui/` | The local cockpit — zero-dependency node, Human / Split / Agent |
| `bin/tl.js` | The CLI — deterministic file work, then prints the matching SKILL as a prompt |
| `AGENTS.md` | Standing instructions for any coding agent (Codex, Cursor, Gemini, Claude) — the cross-agent contract |
| `README.md`, `docs/`, `assets/` | Explanation, design process, the wordmark |
| `package.json` | The `tl` bin entry |

The test for public: **would this file be identical for every user of the tool?** If it carries nothing about *your* projects, it's tool. Skills, templates, and UI are project-agnostic by construction — each reads a workspace's own `TRIAGE.yml` at runtime rather than baking any project's config in.

## What's private (the workspace)

Everything under `projects/<name>/` — the actual work — plus the private extensions repo (below). Inside a workspace:

| Path | What it is | Why private |
|------|-----------|-------------|
| `intents/`, `specs/`, `in-progress/`, `tests/`, `in-review/`, `done/`, `triage/` | Your objectives and the specs that deliver them | Real product plans, roadmap, and code paths |
| `threads/` | Parked ideas, decisions, open questions, risks | Unfiltered thinking — the messiest, most sensitive layer |
| `TRIAGE.yml`, `PROJECT.md`, `PRIORITIES.md` | Per-project goals, weights, context map, ranked backlog | Your prioritization and product-leadership calls |
| `_metrics/*.jsonl` | Append-only logs from every skill run | Cycle times, override reasons, feedback scores — your operating data |
| `_dispatch/` | Queue files the cockpit writes | Ephemeral, machine-local |

The naming convention doubles as a boundary tell: ALL-CAPS files are tl's (fixed names, tool-shaped), lowercase files are yours (you name them). But *location* is what decides public vs. private — anything under `projects/` is private regardless of case.

## The .gitignore boundary

One line does the enforcement:

```gitignore
# Private per-project workspaces — the tool is public, the work is not
/projects/
```

The whole `projects/` tree is untracked. You can clone the public repo, create workspaces under `projects/`, and commit tool changes without ever risking a workspace leak — git simply doesn't see them. `examples/sample-project/` lives *outside* `projects/` on purpose: it's a synthetic workspace that ships with the tool as a worked example, so it's committed while every real workspace is not.

This is the calm version of a hard rule: there's no allowlist to maintain and no per-file decision at commit time. Private-by-default, one glob.

## The private extensions repo (boundary 2)

The proprietary side lives in a **separate private repository** — not a subfolder of this one. It holds what the open-source tool deliberately doesn't:

- **Agent routing** — which agent/model to send which spec type to, and why
- **Benchmark aggregation** — cross-agent, cross-workspace analytics rollups
- **JIRA sync service** — bidirectional epic↔intent, story↔spec, status↔folder
- **Hosted API** — the service that exposes the above

**The contract is data, not code.** The private repo depends on:

- **JSONL schemas** — `_metrics/*.jsonl` shapes defined per skill (and in `SCHEMA.md`). The benchmark pipeline reads `cycle-log.jsonl`, `triage-log.jsonl`, etc.
- **Frontmatter fields** — the `SCHEMA.md` contract: spec fields (`type`, `status`, `priority`, `depends_on`, a future `jira_key`), intent `goals`, `FEEDBACK.md` scores. Parsers preserve unknown fields, so the private repo can read public data and the public tool can carry private-added fields without either breaking the other.
- **A REST API spec** (placeholder at this stage) — the hosted service's surface: submit anonymized cycle/feedback records, request routing suggestions, sync JIRA. To be specified when Phase 2/3 of the enterprise intent lands. Until then the shape is "the private service reads the same JSONL and frontmatter the tool writes."

### Direction of dependency

```
public tool  ──writes──▶  JSONL + frontmatter  ──read──▶  private service
public tool  ◀──features via MCP / API / npm──            private service
```

- **Public → private:** one-way, and only through emitted data. The tool writes files; the service reads them. The public repo has no line of code that names the private repo.
- **Private → public:** the private service exposes features *back* to the local tool the same way any third-party capability arrives — as an **MCP server**, a **hosted API**, or an optional **npm package** the user installs. None of these are imports of private *source* into public source; they're runtime integrations the user opts into.

### Graceful degradation

The private service is always optional. If it's unavailable — offline, not subscribed, never installed — **the local tool still works, fully.** Triage, dedup, capture, run, review, map: none require network. `bug-capture` is the one skill that needs a provider, and it degrades to a no-op when `error_tracking.enabled` is false. Routing suggestions, aggregated benchmarks, and JIRA sync simply don't appear; nothing breaks. Local-only is the floor, and the floor is a complete product.

## Where new things go — the decision table

When you add something, ask which repo it belongs in:

| Adding X… | Goes | Because |
|-----------|------|---------|
| A new skill / verb | **Public** (`skills/`) | Tool capability, project-agnostic |
| A template or schema field | **Public** (`_templates/`) | Part of the data contract everyone shares |
| A UI view or cockpit feature | **Public** (`ui/`) | Reads the same files locally, no project data baked in |
| A CLI subcommand | **Public** (`bin/tl.js`) | Same verbs as skills, tool-side |
| A pattern / authoring guide | **Public** (`_patterns/`) | Helps write specs, ships with the tool |
| A design/process doc | **Public** (`docs/`) | Explanation of the tool — see the open item on privacy docs below |
| A real intent, spec, or thread | **Private** (`projects/<name>/`) | Your actual work |
| A workspace's `TRIAGE.yml` / metrics | **Private** (`projects/<name>/`) | Your config and operating data |
| Agent-routing logic | **Private repo** | Proprietary — the monetizable edge |
| Benchmark aggregation / analytics pipeline | **Private repo** | Built on aggregated data across users |
| JIRA sync service / daemon | **Private repo** | Hosted proprietary integration |
| The hosted API | **Private repo** | Commercial surface |
| A synthetic example workspace | **Public** (`examples/`) | Ships as a worked example, no real data |

Two smell tests, in order:

1. **Is it about a specific project's work?** → private workspace (`projects/`).
2. **Is it a proprietary/monetizable service built on aggregated data?** → private repo. Otherwise it's the tool → public.

## What must NOT be in the public repo

Beyond "anything under `projects/`", these never land in the public tree even in disguised form:

- **Aggregated benchmark data** — cross-agent, cross-user rollups. That aggregate *is* the paid product.
- **Agent performance comparisons with real numbers** — "model A beats model B by X% on bugs." Fine as a private analytic; never a public claim baked into the repo.
- **Customer / real workspace data** — anyone's `projects/` content, metrics, or feedback. Examples must be synthetic.
- **API keys and secrets** — provider tokens, JIRA credentials, service keys. These live in the user's environment or the private service, never committed.

## The GitHub org question

Today the tool installs from a personal namespace:

```
/plugin marketplace add tgurgick/tl
```

The move to an org (`throughline-dev/tl` or similar) is a *when*, not an *if*:

- **When to create the org:** before the first external contributor or the first private-repo repo. An org gives a home for both `tl` (public) and the private extensions repo under one owner, with team access controls the private side will need.
- **When to transfer the public repo:** once the org exists and the install path is ready to change. GitHub redirects the old `tgurgick/tl` path after transfer, so existing installs keep working, but the README and marketplace source should be updated to the org path in the same change.
- **Install path after transfer:** `/plugin marketplace add throughline-dev/tl` (final org name TBD). Until then `tgurgick/tl` is canonical, and cloning + `/plugin marketplace add .` from the repo root works regardless of namespace.
- **The private repo** is created directly in the org, private from birth. It never transfers *from* a public namespace, so there's no window where proprietary code is briefly public.

## Open items

- **LICENSE is missing.** The repo is described as open source but has no `LICENSE` file. The split above assumes the tool is openly licensed and the private repo is all-rights-reserved; that assumption needs a real license committed to the public repo before it's genuinely open source. This is a prerequisite for the org transfer, not a follow-up.
- **`docs/2026-04-16-share-scope-privacy-model.md` — public status unresolved.** This doc is a `checksout` project design decision (GDPR/CCPA sharing model, `home_members` schema, channel rules) — by the tool/workspace boundary it is *workspace* content that happens to sit in the tool's `docs/`. It predates the boundary being enforced. Decision needed: move it into the relevant private workspace (it's project work, not tool explanation), or keep it as a public worked example of design-doc capture with the project details genericized. It should not stay as-is in the public tool repo carrying a specific project's privacy-law analysis. Track and resolve before the repo is made public / transferred.

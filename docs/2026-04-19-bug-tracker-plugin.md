---
title: "Throughline Bug Tracker Plugin"
created: 2026-04-19
project: "throughline"
origin: "checksout-voice-crash-discussion"
status: "exploring"
tags: [plugin, sentry, bugs, triage, automation, skill-design]
explored:
  - "Crash log capture via Sentry MCP vs Xcode manual"
  - "Scheduled polling vs webhook triggers"
  - "Plugin bundling of MCPs, skills, and triggers"
unexplored:
  - "Sentry MCP setup and API surface"
  - "Plugin packaging format for distribution"
---

# Throughline Bug Tracker Plugin

A plugin that connects error monitoring (Sentry, Datadog, etc.) to Throughline's story pipeline. Crashes become bug stories automatically. A triage skill prioritizes the backlog against team goals. A dedup skill keeps the pipeline clean.

---

## Plugin overview

```yaml
name: throughline-bug-tracker
description: Auto-captures crashes as Throughline stories, deduplicates errors, and triages the backlog against configurable team goals.
requires:
  - mcp: sentry           # or datadog, bugsnag — error monitoring MCP
  - skill: throughline     # core Throughline skill for story creation
provides:
  - skill: bug-capture     # monitors for crashes, creates bug stories
  - skill: bug-dedup       # daily cleanup of duplicate/related errors
  - skill: triage          # periodic prioritization against team config
config: triage.yml         # team goals, allocation targets, priority rules
```

---

## Skill 1: bug-capture

### What it does

Polls the error monitoring service for new unresolved crashes. When it finds one, it creates a Throughline story folder with the crash details, stack trace, affected code, and device context — ready for an agent or human to pick up.

### Trigger

Scheduled task, default every 15 minutes. Falls back to manual invocation ("check for new crashes").

```
schedule: "*/15 * * * *"
```

### Flow

1. Query Sentry MCP for issues created since last check, filtered to the configured project
2. For each new issue:
   - Pull full stack trace, breadcrumbs, device info, OS version, affected user count
   - Read the relevant source files from the repo to identify the crash location
   - Create a story folder in `3-stories/`:

```
3-stories/bug-voice-mode-crash-2026-04-19/
├── STORY.md
├── context/
│   ├── crash-report.md     # Full Sentry error: stack trace, breadcrumbs, device info
│   ├── affected-code.md    # Excerpts of the files in the stack trace
│   └── sentry-link.md      # Direct URL to the Sentry issue
└── outcome/
```

3. STORY.md is auto-generated from a bug template:

```markdown
---
title: "Bug: Voice mode crash on tap"
created: 2026-04-19
project: "checksout"
repo: "~/Documents/Claude/Projects/checksOut"
type: "bug"
priority: ""                  # left blank — triage skill fills this in
source: "sentry"
sentry_issue: "CHECKSOUT-42"
sentry_url: "https://sentry.io/issues/..."
affected_users: 1
first_seen: "2026-04-19T14:23:00Z"
project_context:
  architecture: "ARCHITECTURE.md"
---

# Bug: Voice mode crash on tap

## Error summary

{One-line summary from Sentry issue title}

## Repro steps

{If Sentry breadcrumbs suggest a user flow, reconstruct it here.
Otherwise: "Repro steps not yet determined — see crash report in
context/ for stack trace and breadcrumbs."}

## Stack trace (abridged)

{Top 5-10 frames from the stack trace, formatted for readability}

## Acceptance criteria

- [ ] The crash no longer occurs under the conditions described
- [ ] Root cause identified and documented in outcome/agent-notes.md
- [ ] If a missing permission or config issue: add to PATTERNS.md platform gotchas

## Before you start

- Read `context/crash-report.md` for the full Sentry error
- Read `context/affected-code.md` for the source files involved
- Check the Sentry issue at `context/sentry-link.md` for comments or user reports

## Scope

### Likely files

{Auto-populated from stack trace: the files that appear in the crash}

### Files to NOT touch

{Left blank — triage or human fills in if needed}
```

4. Update `_meta/priorities.md` — append the new bug to the "Untriaged" section
5. Notify the user: "New crash detected: Voice mode crash on tap. Story created at 3-stories/bug-voice-mode-crash-2026-04-19/"

### Deduplication at capture time

Before creating a new story, check if a story already exists for the same Sentry issue ID. If so, update the existing story's crash count and last-seen date instead of creating a duplicate.

---

## Skill 2: bug-dedup

### What it does

Daily cleanup pass across all bug stories in `3-stories/` and `4-in-progress/`. Finds duplicates, merges related crashes, and closes stories for errors that have auto-resolved.

### Trigger

Scheduled task, daily at a configured time (default 6am local).

```
schedule: "0 6 * * *"
```

### Flow

1. Read all bug-type stories in `3-stories/` and `4-in-progress/`
2. For each story with a `sentry_issue` field:
   - Query Sentry for current status (resolved, ignored, ongoing)
   - If resolved in Sentry: move story to `5-done/`, note auto-resolution in outcome/
   - If issue was merged in Sentry: merge the corresponding stories (keep the older one, append context from the newer one, delete the duplicate)
3. Cross-reference stories without Sentry IDs (manually created bugs):
   - Compare error descriptions and affected files
   - If two stories describe the same root cause, flag for human review: "These two stories may be duplicates: [story A] and [story B]. Merge them?"
4. Generate a daily dedup report appended to `_meta/dedup-log.md`:

```markdown
## 2026-04-19

- Merged: bug-voice-mode-crash-2026-04-17 ← bug-audio-permission-2026-04-18 (same root cause: missing NSMicrophoneUsageDescription)
- Auto-closed: bug-metro-timeout-2026-04-15 (resolved in Sentry, no recurrence in 72hr)
- Flagged for review: bug-s3-upload-fail and bug-presigned-url-expired may be related
```

---

## Skill 3: triage

### What it does

Periodic prioritization pass that reads team goals from a config file and sorts the backlog accordingly. Acts like a product and engineering lead reviewing the board together — balancing bugs vs. features, aligning work to current goals, and surfacing blockers.

### Trigger

Scheduled task, configurable (default: daily at 8am local, plus on-demand).

```
schedule: "0 8 * * *"
```

### Config: triage.yml

Lives at `throughline/triage.yml`. This is the team's operating agreement — what matters right now, how to allocate effort, and what rules override default prioritization.

```yaml
# Throughline Triage Configuration
# This file controls how the triage skill prioritizes work.
# Edit this when goals change — the triage skill reads it fresh each run.

project: checksout

# Current goals — what the team is trying to achieve right now.
# Ordered by importance. Triage uses these to evaluate whether
# a story moves the needle or is a distraction.
goals:
  - id: mvp-launch
    description: "Ship MVP to TestFlight by end of May 2026"
    weight: 0.6          # 60% of prioritization weight
    key_results:
      - "Auth flow works end-to-end"
      - "Voice + text capture functional"
      - "Basic list UI with AI categorization"
      - "Share flow sends push notification with deep link"

  - id: revenue-validation
    description: "Validate unit economics assumptions before fundraise"
    weight: 0.2
    key_results:
      - "Premium tier purchasable via RevenueCat"
      - "At least one affiliate integration live"

  - id: stability
    description: "No crash-on-launch or data-loss bugs in TestFlight build"
    weight: 0.2
    key_results:
      - "Zero P0 bugs open"
      - "Crash-free rate > 99%"

# Allocation targets — how to split effort between work types.
# Triage flags when the backlog drifts from these targets.
allocation:
  bugs: 0.30              # 30% of stories should be bug fixes
  features: 0.50           # 50% new feature work
  tech_debt: 0.10          # 10% cleanup, refactoring, test coverage
  research: 0.10           # 10% spikes, prototypes, exploration

# Priority rules — overrides that trump goal-based scoring.
rules:
  - condition: "type == 'bug' AND affected_users > 10"
    action: "set priority p0"
    reason: "Widespread crashes are always top priority"

  - condition: "type == 'bug' AND sentry_status == 'regression'"
    action: "set priority p0"
    reason: "Regressions indicate a broken deploy"

  - condition: "type == 'bug' AND age_days > 14 AND priority != 'p0'"
    action: "flag for review"
    reason: "Stale bugs should be closed or escalated"

  - condition: "blocks_count > 2"
    action: "boost priority by 1 level"
    reason: "Blockers should be cleared to unblock downstream work"

  - condition: "depends_on contains stories in '5-done/'"
    action: "set status ready"
    reason: "Dependencies resolved — this story is unblocked"

# Notification preferences
notify:
  on_priority_change: true
  on_unblocked: true
  on_allocation_drift: true   # warn when actual mix drifts >15% from targets
  summary: "daily"             # daily | weekly | on-change
```

### Flow

1. Read `triage.yml` for current goals, allocation targets, and rules
2. Read all stories in `3-stories/` (backlog) and `4-in-progress/` (active)
3. For each untriaged story (no priority set):
   - Score against goals: how much does completing this story advance each goal? Weight by goal importance.
   - Apply priority rules: check for overrides (high affected_users, regressions, blockers)
   - Assign a priority (p0–p3) and write it to the story's frontmatter
4. For triaged stories: re-evaluate if context has changed (new crash data, dependency completed, goal weights updated)
5. Check allocation balance:
   - Count stories by type (bug/feature/tech_debt/research) in `3-stories/` and `4-in-progress/`
   - Compare to allocation targets in config
   - If drift > 15%, flag it: "Current mix is 45% bugs / 35% features / 20% tech debt. Target is 30/50/10/10. Consider deprioritizing some bug fixes or pulling in more feature work."
6. Check for newly unblocked stories:
   - If a story's `depends_on` entries are all in `5-done/`, update its status to `ready`
   - Notify: "signup-home-creation is now unblocked — signup-apple-auth completed"
7. Rewrite `_meta/priorities.md`:
   - Active section: stories in `4-in-progress/`
   - Next up: sorted by priority, then by goal alignment score
   - Backlog: lower priority stories
   - Untriaged: any stories the skill couldn't confidently prioritize (flags for human review)
8. Generate triage summary:

```markdown
## Triage Summary — 2026-04-19

### Priority changes
- bug-voice-mode-crash: → p1 (blocks MVP launch, auth works but capture is broken)
- signup-revenuecat-integration: → p2 (revenue-validation goal, but auth must land first)

### Newly unblocked
- signup-home-creation (signup-apple-auth completed)

### Allocation check
- Current: 40% bugs / 40% features / 20% tech debt / 0% research
- Target:  30% bugs / 50% features / 10% tech debt / 10% research
- ⚠️ Over-indexed on bugs (+10%), under-indexed on features (-10%)
  Consider: are all open bugs blocking MVP? If not, defer lower-priority
  bugs and pull in the next feature story.

### Stale items
- bug-metro-timeout (created 2026-04-05, 14 days old, p3) — close or escalate?

### Goal progress
- mvp-launch (60% weight): 1/4 key results done (auth). Next: voice capture.
- revenue-validation (20%): 0/2 done. Blocked until auth + capture land.
- stability (20%): 1 P1 bug open (voice crash). Crash-free rate unknown (Sentry not yet connected).
```

---

## How the three skills work together

```
Crash happens on phone
        │
        ▼
Sentry captures it
        │
        ▼
bug-capture (every 15 min)
        │
        ├── Creates story folder with crash details
        ├── Deduplicates against existing stories
        └── Adds to "Untriaged" in priorities.md
                │
                ▼
triage (daily at 8am)
        │
        ├── Scores story against goals in triage.yml
        ├── Assigns priority based on rules + goal alignment
        ├── Checks allocation balance (bugs vs features vs debt)
        ├── Unblocks stories whose dependencies completed
        └── Rewrites priorities.md with sorted backlog
                │
                ▼
bug-dedup (daily at 6am)
        │
        ├── Merges duplicate crash stories
        ├── Auto-closes resolved issues
        └── Flags potential duplicates for human review
                │
                ▼
Human or agent picks up the top story
```

---

## Config-driven product management

The `triage.yml` config is the key design choice. It makes product and engineering leadership decisions explicit and machine-readable:

**Goals with weights** replace vague notions of "what's important." When the team shifts focus (e.g., "fundraise prep is now top priority"), they change the weights and the triage skill immediately reorders the backlog.

**Allocation targets** replace gut-feel sprint planning. Instead of arguing about how many bugs to fix vs. features to build, the config says "30% bugs, 50% features" and the triage skill flags when reality drifts. The team adjusts the targets, not individual stories.

**Priority rules** encode the non-negotiable policies. "Regressions are always P0" shouldn't require a human to remember and enforce. The rule fires automatically.

**When goals change:** edit `triage.yml`, run triage manually or wait for the next scheduled run. The entire backlog re-sorts. No meeting required.

---

## Implementation path

**Phase 1 (now):** Add Sentry to ChecksOut app. Connect Sentry MCP. Create a scheduled task for bug-capture polling. Stories get created automatically; triage is still manual.

**Phase 2 (next):** Build the triage skill with `triage.yml` config. Scheduled daily run rewrites priorities.md. Human reviews and adjusts.

**Phase 3 (later):** Build bug-dedup skill. Package all three as a Throughline plugin. Add webhook trigger as an alternative to polling.

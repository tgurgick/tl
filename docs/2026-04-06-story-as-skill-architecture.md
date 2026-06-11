---
title: "Story-as-Skill Architecture"
created: 2026-04-06
project: "throughline"
origin: "skill-system-research"
status: "synthesizing"
tags: [architecture, skills, feedback-loop, agent-workflow]
explored:
  - "How Claude skills use progressive disclosure (3-level loading)"
  - "Skill folder anatomy (SKILL.md + scripts/ + references/ + assets/)"
  - "Skill-creator evaluation and iteration loop"
  - "How pptx/docx skills delegate to reference files"
  - "Three-layer context model (project shared, live codebase, story-scoped)"
  - "PATTERNS.md as authoring guide vs. agent runtime"
  - "When to snapshot vs. reference live files"
  - "How project context stays current (verified-against dates, story acceptance criteria)"
unexplored:
  - "Story size boundaries (when is a story too big for one agent session?)"
  - "Parallel story conflict resolution"
  - "Automated PATTERNS.md updates from feedback corpus"
---

# Story-as-Skill Architecture

How Throughline stories should work, modeled on how Claude skills work.

---

## 1. The File System

```
throughline/
│
├── README.md                          # System docs
├── .gitignore
│
├── 0-inbox/                           # Raw ideas (flat files)
│   └── 2026-04-07-voice-ux-idea.md
│
├── 1-research/                        # Explored ideas (flat files)
│   └── 2026-04-06-story-as-skill-architecture.md   ← you are here
│
├── 2-prd/                             # Scoped requirements (flat files)
│   ├── 2026-04-06-user-logging-flow.md
│   ├── 2026-04-06-user-signup-payments.md
│   ├── 2026-04-06-onboarding-magic-moments.md
│   └── 2026-04-06-upsell-conversion.md
│
├── 3-stories/                         # Agent-actionable work (FOLDERS, not files)
│   │
│   ├── signup-apple-auth/             # ← each story is a folder
│   │   ├── STORY.md                   #    the story itself (compact, < 500 lines)
│   │   ├── context/                   #    reference material (loaded on demand)
│   │   │   ├── cognito-pattern.ts     #    example code to follow
│   │   │   ├── schema.sql             #    relevant data model excerpt
│   │   │   └── decisions.md           #    settled decisions, don't re-litigate
│   │   └── outcome/                   #    filled in AFTER completion
│   │       ├── feedback.md            #    quality assessment + template improvements
│   │       └── agent-notes.md         #    what the agent learned during execution
│   │
│   ├── signup-home-creation/
│   │   ├── STORY.md
│   │   ├── context/
│   │   │   └── schema.sql
│   │   └── outcome/
│   │
│   └── capture-voice-input/
│       ├── STORY.md
│       ├── context/
│       │   ├── whisper-api.md
│       │   ├── s3-presigned-pattern.ts
│       │   └── enrichment-pipeline.md
│       └── outcome/
│
├── 4-in-progress/                     # Stories being worked (moved here from 3-stories/)
│   └── signup-apple-auth/             #    same folder, just moved
│
├── 5-done/                            # Completed stories (moved here from 4-in-progress/)
│   └── signup-apple-auth/
│       ├── STORY.md
│       ├── context/
│       └── outcome/
│           ├── feedback.md            #    ← now filled in
│           └── agent-notes.md         #    ← now filled in
│
├── _patterns/                         # Accumulated learnings (the evolving "system prompt")
│   ├── PATTERNS.md                    #    master file — agents read this before starting
│   ├── code-style.md                  #    extracted pattern: how we write TypeScript
│   └── common-mistakes.md             #    extracted pattern: things agents get wrong
│
├── _templates/                        # Templates for each stage
│   ├── inbox.md
│   ├── research.md
│   ├── prd.md
│   ├── story/                         #    story template is now a FOLDER
│   │   ├── STORY.md                   #    template for the story file
│   │   └── context/                   #    empty, to be populated
│   └── feedback.md                    #    template for outcome/feedback.md
│
└── _meta/
    ├── priorities.md                  # Ordered stack of what to work on next
    └── projects/
        └── checksout.md               # Project index linking to all its PRDs/stories
```

### Key structural decisions

**Inbox, research, and PRDs stay as flat files.** They're written and read by humans. No agent picks them up and executes them. Progressive disclosure isn't needed — the human reads what they need.

**Stories become folders.** This is the big change. A story folder is the unit an agent receives. Like a skill folder, it has a manifest (STORY.md), reference material (context/), and a place for results (outcome/). The folder IS the context window.

**Movement between folders is the state machine.** `mv 3-stories/signup-apple-auth 4-in-progress/` is the only state transition needed. No status fields to update.

---

## 2. How a Story Gets Created

### Step 1: Human (or AI) decomposes a PRD

Starting from `2-prd/2026-04-06-user-signup-payments.md`, which covers auth, home creation, payments, and token refresh. This is too big for one agent session. It splits into stories:

| Story | Size | Depends on |
|-------|------|------------|
| `signup-apple-auth` | medium (1-3hr) | nothing |
| `signup-home-creation` | small (< 1hr) | signup-apple-auth |
| `signup-token-refresh` | small (< 1hr) | signup-apple-auth |
| `signup-revenuecat-integration` | medium (1-3hr) | signup-apple-auth |

### Step 2: Create the story folder

```bash
cp -r _templates/story/ 3-stories/signup-apple-auth/
```

### Step 3: Write STORY.md

The human (or AI assistant) fills in STORY.md. This is the highest-leverage writing in the system. The quality of this file directly determines the quality of agent output.

Here's what a real one looks like:

```markdown
---
title: "Apple Sign In + Email Auth"
created: 2026-04-06
project: "checksout"
prd: "2-prd/2026-04-06-user-signup-payments.md"
status: "ready"
priority: "p0"
size: "medium"
depends_on: []
blocks:
  - "3-stories/signup-home-creation"
  - "3-stories/signup-token-refresh"
  - "3-stories/signup-revenuecat-integration"
---

# Apple Sign In + Email Auth

## Objective

A user can sign up and sign in via Apple Sign In or email/password. Auth
state persists across app restarts. The app gates all content behind auth.

## Context

ChecksOut is an Expo React Native app. The backend uses AWS CDK with
Cognito for auth. The mobile app uses Zustand for state management.

Apple Sign In is required for App Store submission (any app offering
third-party auth must also offer Apple Sign In).

Read `context/cognito-pattern.ts` for an example of how we wire Cognito
in Lambda handlers. Read `context/schema.sql` for the users table schema.

## Acceptance criteria

- [ ] Apple Sign In works on iOS (expo-apple-authentication)
- [ ] Email/password signup and signin work via Cognito
- [ ] Auth state persists in secure storage (expo-secure-store)
- [ ] App shows auth screen when not signed in, main tabs when signed in
- [ ] Cognito user pool and identity pool deployed via CDK
- [ ] Lambda authorizer validates JWT on all API endpoints
- [ ] getUserId() throws 401 on missing/invalid claims (not empty string)

## Scope

### Files to create or modify

- `checksout-app/app/_layout.js` — auth gate (show login vs tabs)
- `checksout-app/src/store/auth.ts` — Zustand auth store
- `checksout-app/app/login.js` — login screen (new)
- `checksout-infra/lib/auth-stack.ts` — Cognito CDK stack
- `checksout-infra/lambda/api/auth.ts` — signup/signin handlers

### Files to NOT touch

- `checksout-app/app/(tabs)/*` — tab screens are out of scope
- `checksout-infra/lib/database-stack.ts` — DB is a separate story

## Implementation hints

Start with the CDK auth stack (Cognito user pool with Apple as identity
provider). Then wire the Lambda authorizer. Then build the client auth
flow.

For the client, use expo-apple-authentication for Apple Sign In and
amazon-cognito-identity-js for email/password. Store tokens with
expo-secure-store, not AsyncStorage.

### Edge cases

- Handle "Sign In with Apple" email relay (Apple hides real email)
- Handle Cognito's annoying FORCE_CHANGE_PASSWORD state for new users
- getUserId() must throw 401, not return empty string (security fix from dev plan)

### Testing

- `cdk synth` produces valid CloudFormation for auth stack
- Sign up with email → verify → sign in → JWT is valid
- Apple Sign In flow completes (requires physical device or TestFlight)
- Unauthenticated API request returns 401
- App restart preserves auth state

## Read before starting

1. `_patterns/PATTERNS.md` — accumulated learnings from previous stories
2. `context/cognito-pattern.ts` — example Lambda auth pattern
3. `context/schema.sql` — users table, home_members table
```

### Step 4: Populate context/

Copy or write the reference files that STORY.md points to. These are excerpts, not full files — just enough for the agent to understand the pattern without loading the entire codebase.

```
context/
├── cognito-pattern.ts    # 30-line example of JWT validation in a Lambda
├── schema.sql            # Just the users + home_members tables (not the whole schema)
└── decisions.md          # "We use Cognito (not Auth0). We use expo-secure-store
                          #  (not AsyncStorage). These are settled."
```

The context folder is the "Level 3" of progressive disclosure. STORY.md tells the agent what's here and when to read it. The agent loads these files into its context only when it needs them.

---

## 3. How an Agent Works Through a Story

### Step 1: Story moves to in-progress

```bash
mv 3-stories/signup-apple-auth 4-in-progress/
```

A Claude Code session is started against the ChecksOut repo with the story folder provided as context.

### Step 2: Agent reads STORY.md

The agent reads the story manifest. This gives it:
- **What** to build (objective, acceptance criteria)
- **Where** to work (files to create/modify, files to avoid)
- **How** to approach it (implementation hints, edge cases)
- **What to read next** (pointers to context/ files and PATTERNS.md)

### Step 3: Agent reads PATTERNS.md

Before writing any code, the agent reads `_patterns/PATTERNS.md`. This file contains accumulated learnings from previous stories:

```markdown
# Throughline Patterns

Learnings accumulated from completed stories. Read this before starting
any story. These patterns are earned from experience, not theory.

## Code patterns

### Lambda handlers
Always validate auth first. Extract userId with getUserId() which
throws 401 on missing claims. Never return empty string for missing
auth — this was a security bug we caught in Sprint 2.

### Zustand stores
Follow the pattern in src/store/items.ts: state + actions in one
create() call. Don't split into separate slices until we have 5+ stores.

## Process patterns

### What agents get wrong
- Scope creep: agents tend to "improve" adjacent code. Stay within the
  files listed in STORY.md. If you see a bug elsewhere, note it in
  agent-notes.md, don't fix it.
- Over-abstracting: don't create utility libraries for one-off logic.
  Inline is fine for MVP.
- Missing error handling: every Lambda needs try/catch with structured
  error responses. Agents skip this ~40% of the time.

### What agents get right
- Test coverage: when acceptance criteria include specific test commands,
  agents reliably run them.
- Following code patterns: when context/ includes an example file,
  agents match the style well.
```

### Step 4: Agent reads context files (as needed)

The agent reads `context/cognito-pattern.ts` when it starts building the auth stack, and `context/schema.sql` when it writes the signup handler that inserts into the users table. It doesn't read everything upfront — only what STORY.md pointed it toward for the current sub-task.

### Step 5: Agent executes

The agent writes code, runs tests, iterates. Standard Claude Code workflow. The story's acceptance criteria give it clear exit conditions.

### Step 6: Agent writes agent-notes.md

Before finishing, the agent fills in `outcome/agent-notes.md`:

```markdown
# Agent Notes: signup-apple-auth

## Decisions made
- Used @aws-cdk/aws-cognito L2 constructs (not L1 CloudFormation).
  The L2 API is cleaner for user pool configuration.
- Added FORCE_CHANGE_PASSWORD handling in the signin Lambda — Cognito
  creates users in this state by default when using adminCreateUser.
- Used expo-auth-session for the Apple Sign In flow rather than
  expo-apple-authentication directly, because it handles the redirect
  URI more cleanly with Expo Go.

## Surprises
- Cognito requires email verification even for Apple Sign In users.
  Had to add a pre-signup trigger Lambda to auto-confirm Apple users.
- expo-secure-store has a 2KB limit per key. JWT tokens can exceed
  this. Split into access_token and refresh_token keys.

## For next stories
- signup-home-creation will need the userId from the auth store.
  It's available via useAuthStore.getState().userId.
- The Lambda authorizer is deployed but not yet attached to non-auth
  routes. signup-token-refresh or the first CRUD story should wire it.

## Bugs noticed (out of scope, didn't fix)
- items.ts still returns empty string for missing auth (the security
  fix from the dev plan). Separate story should address this.
```

---

## 4. How Feedback Gets Provided and Applied

### Step 1: Human reviews the work

The story is in `4-in-progress/` (or moved to `5-done/`). The human reviews the code the agent produced — the PR, the diff, the deployed result. They assess: did it work? Was it clean? Did the agent stay in scope?

### Step 2: Human writes outcome/feedback.md

```markdown
# Feedback: signup-apple-auth

## What was the story?
Implement Apple Sign In + email/password auth via Cognito.

## What was delivered?
Auth works end-to-end. Apple Sign In, email/password, token persistence,
auth-gated navigation. CDK stack deploys cleanly.

## Quality assessment

| Dimension | Score (1-5) | Notes |
|-----------|------------|-------|
| Correctness | 5 | Everything works, including the tricky Cognito pre-signup trigger |
| Completeness | 4 | All acceptance criteria met except physical device Apple test |
| Code quality | 4 | Clean, but the auth store is 180 lines — could be split |
| Scope discipline | 5 | Stayed within listed files, noted out-of-scope bug properly |
| Decision making | 5 | expo-auth-session choice was smart, well-reasoned in notes |

## The gap

Minor: auth store is getting long. Not a problem now but will be
when token refresh is added.

### What went well
- Pre-signup trigger for Apple users was a good autonomous decision
- expo-secure-store split for large tokens — agent caught the 2KB
  limit before it became a bug
- Agent notes are genuinely useful for the next story

### What went wrong
- Nothing significant this time

## Template improvements

- **Add to story template:** "If you create a new CDK stack, also update
  bin/app.ts to include it" — the agent did this but only because the
  error told it to. Should be in the hints.
- **Add to PATTERNS.md:** "expo-secure-store has a 2KB limit per key.
  Split large values across multiple keys."

## Context improvements

- **Codebase knowledge:** Next story should include a context file showing
  the bin/app.ts stack registration pattern.
- **Domain knowledge:** None missing — the Cognito decisions doc was
  sufficient.

## Carry-forward

The pre-signup trigger Lambda needs to be in the auth stack's outputs
so other stacks can reference it. The agent did this correctly.
```

### Step 3: Move story to done

```bash
mv 4-in-progress/signup-apple-auth 5-done/
```

### Step 4: Update PATTERNS.md (the critical step)

This is where the feedback loop closes. The human (or an AI assistant) reads the feedback and distills actionable patterns into `_patterns/PATTERNS.md`:

**Before this story, PATTERNS.md said:**
```markdown
### What agents get wrong
- Scope creep: agents tend to "improve" adjacent code...
- Over-abstracting: don't create utility libraries...
- Missing error handling: every Lambda needs try/catch...
```

**After this story, PATTERNS.md gets updated:**
```markdown
### What agents get wrong
- Scope creep: agents tend to "improve" adjacent code...
- Over-abstracting: don't create utility libraries...
- Missing error handling: every Lambda needs try/catch...
- CDK stack registration: when creating a new CDK stack, also update
  bin/app.ts to register it. Agents miss this until the deploy fails.

### Platform gotchas
- expo-secure-store has a 2KB limit per key. Split large values
  (like JWT tokens) across multiple keys.
- Cognito auto-creates users in FORCE_CHANGE_PASSWORD state.
  Handle this in the signin flow.
- Apple Sign In users still need email verification in Cognito.
  Use a pre-signup trigger Lambda to auto-confirm them.
```

### Step 5: Improve context for the next story

The feedback said "next story should include a context file showing bin/app.ts." So when `signup-home-creation` is being prepared:

```
3-stories/signup-home-creation/
├── STORY.md
└── context/
    ├── schema.sql
    ├── bin-app-pattern.ts       ← NEW, added because of feedback
    └── auth-store-exports.md    ← NEW, from agent-notes carry-forward
```

---

## 5. Context Layers: What's Shared, What's Scoped, What's Live

The hardest problem isn't structuring stories — it's structuring context so that every story has an accurate picture of both the vision (what we want to build) and the reality (what actually exists right now).

### The three layers

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: PROJECT CONTEXT (shared, lives in the repo)   │
│                                                         │
│  The source-of-truth docs that define the vision and    │
│  architecture. These exist once and are referenced by   │
│  every story in the project.                            │
│                                                         │
│  Lives at: the project repo (e.g. ~/Projects/checksOut) │
│  Examples:                                              │
│    - ARCHITECTURE.md (tech stack, system design)        │
│    - Design principles doc                              │
│    - Data model / schema                                │
│    - PRDs in Throughline (the "why" and "what")         │
│                                                         │
│  Updated: when architecture decisions change            │
│  Referenced by: every story via project_context in      │
│                 STORY.md frontmatter                    │
├─────────────────────────────────────────────────────────┤
│  LAYER 2: CURRENT STATE (live, is the codebase itself)  │
│                                                         │
│  What actually exists right now. Not a doc — the agent  │
│  reads the real files in the real repo. This is why     │
│  stories run inside Claude Code against the actual      │
│  working directory.                                     │
│                                                         │
│  Lives at: the repo (agent reads it directly)           │
│  Examples:                                              │
│    - What code exists in src/store/auth.ts              │
│    - What CDK stacks are deployed                       │
│    - What endpoints the API exposes                     │
│    - What packages are in package.json                  │
│                                                         │
│  Updated: automatically (it IS the code)                │
│  Referenced by: agent reads live files during execution │
├─────────────────────────────────────────────────────────┤
│  LAYER 3: STORY CONTEXT (scoped, lives in the story)    │
│                                                         │
│  Things only this story needs that don't exist in the   │
│  repo or are too buried to find. Curated excerpts,      │
│  examples, gotchas. This is what goes in context/.      │
│                                                         │
│  Lives at: story-folder/context/                        │
│  Examples:                                              │
│    - A code pattern to follow (30-line excerpt)         │
│    - A settled decision doc ("we chose X over Y, why")  │
│    - An API response format from a third-party service  │
│    - Carry-forward notes from the previous story        │
│                                                         │
│  Updated: when the story is authored                    │
│  Referenced by: STORY.md points to specific files       │
└─────────────────────────────────────────────────────────┘
```

### How STORY.md references each layer

The story frontmatter includes a `project_context` field that points to shared docs the agent should read. These are NOT copied into the story — they're live references to files in the repo.

```yaml
---
title: "Apple Sign In + Email Auth"
project: "checksout"
repo: "~/Documents/Claude/Projects/checksOut"
project_context:                          # ← Layer 1: shared project docs
  architecture: "ARCHITECTURE.md"         #    read for tech stack + system design
  architecture_sections:                  #    only read these sections (not the whole file)
    - "Stack Decisions"
    - "Data Model > Core Tables > users"
  prd: "2-prd/2026-04-06-user-signup-payments.md"
  design_principles: "ChecksOut_Design_Principles.docx"  # optional, for brand/UX context
---
```

The story body then points to Layer 3 context for story-specific material:

```markdown
## Context

This story implements auth for the ChecksOut app.

**For architecture decisions:** Read the Stack Decisions and users table
sections from ARCHITECTURE.md (referenced in frontmatter). Don't
re-litigate the choice of Cognito over Auth0 — that's settled.

**For implementation patterns:** Read `context/cognito-pattern.ts` for
how we validate JWTs in Lambda handlers.

**For carry-forward from previous work:** Read `context/auth-store-exports.md`
for what the auth store should expose to downstream stories.
```

Layer 2 (current state) doesn't need explicit references — the agent is running in the repo and can read any file. But the story should tell it where to look:

```markdown
## Before you start

Check what already exists:
- Look at `checksout-app/src/store/` for existing Zustand store patterns
- Look at `checksout-infra/lib/` for existing CDK stack patterns
- Run `cat checksout-infra/bin/app.ts` to see how stacks are registered
```

### How project context stays current

This is the critical question. ARCHITECTURE.md says "we use Aurora Serverless v2" but what if we migrated to DynamoDB after Story #12? The architecture doc would be wrong.

**Rule: project context docs are living documents, not artifacts.**

When a story changes something architectural, the story's acceptance criteria should include updating the relevant project doc:

```markdown
## Acceptance criteria

- [ ] Auth works end-to-end via Cognito
- [ ] ...
- [ ] ARCHITECTURE.md updated if any stack decisions changed
```

And when a story author is writing a new story, the first step is:

1. Read the project context docs (Layer 1)
2. Scan the actual codebase (Layer 2)
3. If Layer 1 and Layer 2 disagree, **update Layer 1** before writing the story

This means project context docs have a "last verified" date in their frontmatter:

```yaml
---
title: "ChecksOut Architecture"
last_verified: 2026-04-06
verified_against: "commit abc1234"
---
```

If the last verified date is old, the story author should re-verify before trusting it.

### What goes in the project index

The `_meta/projects/checksout.md` file becomes the bridge between Throughline and the project repo. It maps where all the shared context lives:

```markdown
## Project context map

| Doc | Location | What it covers | Last verified |
|-----|----------|----------------|---------------|
| Architecture | `repo:ARCHITECTURE.md` | Tech stack, system design, data model | 2026-04-06 |
| Design Principles | `repo:ChecksOut_Design_Principles.docx` | UX framework, share mechanic, anti-patterns | 2026-04-06 |
| Revenue Strategy | `repo:ChecksOut_Network_Revenue_Strategy.docx` | Fix referrals, Get affiliate, phased rollout | 2026-04-06 |
| Dev Plan | `repo:ChecksOut_Dev_Plan.md` | Sprint-level plan, known bugs, blockers | 2026-04-06 |
| Unit Economics | `repo:ChecksOut_Unit_Economics.xlsx` | Tier costs, revenue model, funnel math | 2026-04-06 |
| PRD: Logging | `tl:2-prd/2026-04-06-user-logging-flow.md` | Capture intents, enrichment pipeline | 2026-04-06 |
| PRD: Signup | `tl:2-prd/2026-04-06-user-signup-payments.md` | Auth, tiers, payments | 2026-04-06 |
| PRD: Onboarding | `tl:2-prd/2026-04-06-onboarding-magic-moments.md` | Magic moments, share flow, retention | 2026-04-06 |
| PRD: Upsell | `tl:2-prd/2026-04-06-upsell-conversion.md` | Conversion triggers, revenue flywheel | 2026-04-06 |
```

When an agent starts a story, it can check this map to understand what docs exist and where. `repo:` means it's in the project repo. `tl:` means it's in Throughline.

### When to snapshot vs. reference

**Reference (don't copy) when:**
- The doc is in the same repo the agent is working in (it can read it live)
- The doc changes frequently (a copy would go stale immediately)
- The doc is large (copying wastes story context space)

**Snapshot (copy into context/) when:**
- The doc is in a different repo or system the agent can't access
- You only need a 20-30 line excerpt, not the whole doc
- The pattern you're showing is from a specific point in time ("this is what auth.ts looks like NOW, match this style")
- It's carry-forward notes from a previous story's agent-notes.md

### Example: how a story sees the full picture

When an agent picks up `signup-apple-auth`, here's its complete context:

```
What it reads                         Where it comes from          Layer
─────────────────────────────────────────────────────────────────────────
STORY.md                              story folder                 —
ARCHITECTURE.md (sections only)       project repo (live)          1
PRD: user-signup-payments.md          Throughline (live)           1
context/cognito-pattern.ts            story folder (snapshot)      3
context/schema.sql                    story folder (snapshot)      3
context/decisions.md                  story folder (snapshot)      3
src/store/items.ts                    project repo (live)          2
checksout-infra/bin/app.ts            project repo (live)          2
```

The agent gets vision (PRD + architecture), reality (live codebase), and focused guidance (story context). No duplication, no staleness for the things that matter most.

---

## 6. PATTERNS.md as Story-Authoring Guide (not Agent Runtime)

PATTERNS.md is read by the **story author** when writing new stories, not by the **executing agent** at runtime. It answers: "based on what we've learned, how should I write this story so the agent does a good job?"

### What PATTERNS.md contains

```markdown
# Throughline Patterns

A guide for writing effective stories. Updated after every completed
story based on feedback. Read this when creating new stories.

## Story-writing patterns

### Acceptance criteria
- Include specific test commands ("run `cdk synth`") — agents execute
  these 95% of the time. Vague criteria ("should work correctly") get
  skipped ~60% of the time.
- Include "update ARCHITECTURE.md if decisions changed" for any story
  that touches infrastructure.

### Context files
- Always include a code pattern file when the story creates something
  new (new store, new Lambda, new stack). Agents that have an example
  match the project style 90% of the time vs 40% without.
- Schema excerpts should include just the tables the story touches,
  not the whole schema. Agents get confused by irrelevant tables.

### Scope boundaries
- Explicitly list "files to NOT touch" — agents scope-creep into
  adjacent files ~30% of the time. This section cuts that to ~5%.
- For CDK stories: always mention bin/app.ts in either "files to
  modify" or implementation hints. Agents miss the stack registration.

### Implementation hints
- "Start with X, then Y, then Z" ordering helps. Agents that get
  a suggested sequence produce cleaner code than those told to "build
  auth" without sequencing.
- Call out platform gotchas explicitly. Known ones:
  - expo-secure-store 2KB limit per key
  - Cognito FORCE_CHANGE_PASSWORD default state
  - Apple Sign In still requires email verification in Cognito

## What good feedback looks like

When reviewing a completed story, focus on:
1. Would better story-writing have prevented the issues?
2. What context was missing that the agent needed?
3. What context was provided but ignored (wasted space)?
```

### How PATTERNS.md gets updated

After every story completion:

1. Read `outcome/feedback.md`
2. Extract anything that generalizes — patterns that would help write better stories in the future
3. Add to PATTERNS.md under the appropriate section
4. Remove patterns that turn out to be wrong (occasionally an early pattern is disproven by later evidence)

The question "who updates this?" — it can be either:
- **Human:** reads feedback, manually adds to PATTERNS.md
- **AI assistant (e.g. Cowork):** reads all feedback files in `5-done/`, proposes PATTERNS.md updates, human approves

---

## 7. Updated File System (with context layers)

```
throughline/
│
├── README.md
├── .gitignore
│
├── 0-inbox/                           # Raw ideas (flat files)
├── 1-research/                        # Explored ideas (flat files)
├── 2-prd/                             # Scoped requirements (flat files)
│
├── 3-stories/                         # Agent-actionable work (FOLDERS)
│   └── signup-apple-auth/
│       ├── STORY.md                   # Manifest: objective, criteria, scope
│       │   └── frontmatter includes:
│       │       project_context:       # ← pointers to Layer 1 (shared docs)
│       │         architecture: "ARCHITECTURE.md"
│       │         architecture_sections: ["Stack Decisions", "Data Model > users"]
│       │         prd: "2-prd/2026-04-06-user-signup-payments.md"
│       │   └── body includes:
│       │       "Before you start" section pointing to live repo files (Layer 2)
│       │       "Read context/" pointers for story-specific material (Layer 3)
│       ├── context/                   # Layer 3: story-scoped snapshots
│       │   ├── cognito-pattern.ts     #   code pattern to follow
│       │   ├── schema.sql             #   relevant table excerpt
│       │   └── decisions.md           #   settled decisions
│       └── outcome/                   # Filled after completion
│           ├── feedback.md
│           └── agent-notes.md
│
├── 4-in-progress/                     # Stories being worked
├── 5-done/                            # Completed stories with feedback
│
├── _patterns/                         # Story-AUTHORING guide (not agent runtime)
│   └── PATTERNS.md                    #   "how to write good stories" based on
│                                      #   accumulated feedback
│
├── _templates/
│   ├── inbox.md
│   ├── research.md
│   ├── prd.md
│   ├── story/                         # Story template (folder)
│   │   ├── STORY.md
│   │   └── context/
│   └── feedback.md
│
└── _meta/
    ├── priorities.md
    └── projects/
        └── checksout.md               # Project index with CONTEXT MAP:
                                       #   what shared docs exist, where they
                                       #   live, when they were last verified
```

---

## 8. The Flywheel

```
Write story → Agent executes → Review output → Write feedback
     ↑                                              │
     │                                              ▼
     │                                    Distill into PATTERNS.md
     │                                              │
     │                                              ▼
     └──────── Next story is better ←── Improve templates + context
```

Each revolution:
- **PATTERNS.md gets richer** — agents start with more institutional knowledge
- **Context folders get better** — we learn which reference files actually help
- **Story templates evolve** — sections get added/removed based on what agents use
- **Stories get more precise** — we learn which level of detail produces the best output

The system doesn't improve the agents. It improves the instructions the agents receive. Same model, better prompts, better results.

---

## 9. Open Questions

1. **Who updates PATTERNS.md?** Human only? Or can an AI assistant read feedback files and propose updates? The skill-creator has an automated eval loop — should Throughline?

2. **Context file freshness.** Code excerpts in `context/` can drift from the actual codebase. Should stories reference live files instead of snapshots? Tradeoff: snapshots are stable but stale; live refs are current but could change mid-execution.

3. **Story size heuristic.** "Small/medium/large" is vague. Should we define: small = one file changed, medium = 2-5 files, large = new module/stack? The skill-creator caps SKILL.md at 500 lines — should STORY.md have a similar cap?

4. **Parallel stories.** Two agents working on overlapping files will conflict. Should the dependency graph enforce this, or is it the human's job to avoid collisions?

5. **When does a pattern graduate?** A pattern in PATTERNS.md is a hypothesis. After it's validated across 5+ stories, should it move into the story template itself?

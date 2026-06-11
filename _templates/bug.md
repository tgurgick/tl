---
title: "Bug: "
created: YYYY-MM-DD
project: ""
repo: ""
type: "bug"
priority: ""                    # left blank — triage skill fills this in
priority_set_by: ""             # triage | human — set "human" if you set priority yourself
size: ""
source: ""                      # sentry | datadog | manual
source_id: ""                   # issue ID from error tracking provider
source_url: ""                  # direct link to issue
affected_users: 0
first_seen: ""
status: "ready"
depends_on: []
blocks: []
tags: []
project_context:
  architecture: ""
---

# Bug: {title}

## Error summary

{One-line description of what's broken.}

## Repro steps

1. {Step to reproduce}
2. {Step}
3. {Crash / unexpected behavior}

## Stack trace (abridged)

```
{Top frames from the crash, or "see context/crash-report.md for full trace"}
```

## Acceptance criteria

- [ ] The crash/error no longer occurs under the described conditions
- [ ] Root cause identified and documented in outcome/agent-notes.md
- [ ] If a config or permission issue: add to _patterns/PATTERNS.md platform gotchas
- [ ] If an architecture change: update ARCHITECTURE.md

## Before you start

- Read `context/crash-report.md` for the full error report
- Read `context/affected-code.md` for source files involved
- Check the source issue for comments or related reports

## Scope

### Likely files

- {Files from the stack trace}

### Files to NOT touch

- {Out of scope}

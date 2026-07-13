---
name: ""
created: YYYY-MM-DD
status: "active"                # active | paused | archived
repo: ""                        # path to the project's code repo — never the tl checkout or inside it
remote: ""                      # the repo's remote URL, or explicitly "none yet" — this workspace only *tracks* the work; the code lives in the repo above, and the remote is how its existence is verified (git ls-remote)
description: ""
---

# {name}

## Context map

Where the durable project knowledge lives. Skills and agents resolve `repo:` against the `repo` path above.

| Doc | Location | Covers | Last verified |
|-----|----------|--------|---------------|
| Architecture | `repo:ARCHITECTURE.md` | | YYYY-MM-DD |

## Intents

- {linked as they're written — `intents/...` (pN)}

## Notes

{Anything about this project that isn't an intent or spec: standing constraints, people, history.}

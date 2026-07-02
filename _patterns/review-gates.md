# Review gates

The checklist a verifier applies at the **TESTS gate** — the guidelines the checking model (or a human at `/tl review`) runs the work against, beyond "the acceptance criteria are met." A builder is worst at catching its own blind spots; these gates are what a second set of eyes (ideally a *different* model — see the `alt-model-alignment-check` spec) looks for.

Run them against the **diff**, the spec's **acceptance criteria**, and the parent intent's **outcome**. Each gate is pass / concern-with-specifics.

## Security gates

- **No secrets.** No keys, tokens, passwords, or credentials added to code, config, logs, or committed files.
- **Input validation.** Any external/user input is validated; path inputs are traversal-guarded (the `safePath` pattern — never resolve outside the workspace/repo).
- **Output escaping.** No injection surface — HTML/output is escaped (the `esc` / tokenize-then-escape pattern), no SQL/command/template injection.
- **No surprise network.** No new outbound calls, endpoints, or data exfiltration the spec didn't call for. Data never goes to a recipient the spec didn't name.
- **No new dependencies.** The zero-dependency constraint *is* a security control (supply-chain surface). A new dep is a concern to justify, not a default.
- **Scoped writes.** File writes stay inside the workspace/repo via `safePath`; no writing outside the declared scope.
- **Permissions unchanged.** Auth, access, or sharing behavior isn't altered unless the spec explicitly says so.

## Code-standard gates

- **In scope.** Stayed within `Files to touch`; respected `Do not touch`; no unrelated refactors riding along.
- **No leftovers.** No dead code, debug prints (`console.log`), commented-out blocks, or TODOs masquerading as done.
- **Idiom match.** Matches the surrounding style, naming, and conventions — reads like the code around it (comment density, error-handling shape, single-file/zero-dep discipline).
- **Errors handled.** No silent failures; failure paths are explicit (surface or capture, don't swallow).
- **Criteria genuinely met.** Each acceptance criterion is actually satisfied — verified against behavior, not "looks done."
- **No regression.** Adjacent behavior the spec didn't intend to touch still works (the classic: a same-file edit that breaks a sibling feature).

## How this is used

- **In the TESTS gate.** After the acceptance tests pass, run these gates. Where the cross-model verifier exists (`alt-model-alignment-check`), a *different* model than the builder applies them, its concerns go back to the builder to remediate (bounded), and the alignment record captures each round. Until then, the building agent self-checks against these gates before moving to `in-review`.
- **At `/tl review`.** The human (or `/code-review`) uses the same gates when signing off — so the machine check and the human check are the same rubric.
- **Extending.** Per-workspace additions (a project's own security posture, style rules) can live alongside this; keep this file the shared baseline.

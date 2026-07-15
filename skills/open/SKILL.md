---
name: open
description: Start a project's operating path in one command (`tl up`; `open` is a short-lived alias) — bring up the cockpit, install or refresh the workspace's automation schedule from TRIAGE.yml, and surface the one next human action. Use when the user says up, spin it up, open a project, start my day on a project, or wants UI plus headless lanes plus a next step without assembling them by hand. Belongs under the run surface.
---

# /tl up

The day-to-day entry point under **run**. `/tl new` interviews once per project; `tl up` is what you run every time after: cockpit up, automation ticking, one next action. (`tl open` is a short-lived synonym of the same command.) It **never claims or moves specs** — the schedule's worker ticks spawn run sessions, and finished work still pools at `in-review/` for the human gate.

The deterministic half is the CLI: `node bin/tl.js up <workspace>` resolves the workspace, starts or reuses the UI, installs/refreshes the schedule from the `automation:` profile (contract: `_templates/SCHEMA.md`; generator: `lib/automation.js`), and prints the automation status plus the next human action.

## Steps

1. **Resolve the workspace** like every other verb: an argument names one under `projects/`; exactly one existing workspace is used implicitly; otherwise list and ask.

2. **Preview before side effects.** Run `node bin/tl.js up <ws> --dry-run` first and show the user the plan: whether the UI would start or be reused, what schedule would be written/loaded, and the next human action. Dry run writes nothing, loads nothing, and spawns nothing.

3. **Prefer print-for-paste for the install.** `launchctl load` (and anything touching `crontab`) can trigger a macOS permission prompt that an agent session cannot answer — a hang, not an error. So:
   - If the user is at their own terminal, tell them to run `node bin/tl.js up <ws>` themselves — the real install path.
   - Otherwise run `node bin/tl.js up <ws> --print-schedule` and hand them the complete paste-able cron line / launchd plist plus the one `launchctl load` command. **Never run `crontab -` / `crontab <file>` / `launchctl load` from an agent session.**

4. **Read the output back to the user, briefly:** cockpit URL, automation state (`off` / `misconfigured` / `paused` / `installed` / `not-installed`), any stuck-at-tests count (that is the verifier gate working — point at `tl verify`), and the one next human action. If the state is `misconfigured`, the CLI already printed the fix hint (a listed lane missing `lanes.<name>.command`) — relay it, don't improvise a schedule around it.

## Guardrails

- An absent `automation:` section is a calm default, not an error — UI + next action still work; say that automation is available and where the contract lives.
- `PAUSE` at the workspace root outranks everything: report paused, never "fix" it by deleting the file unless the human asks.
- `automation.verify: true` schedules an isolated verify tick (`bin/tl-worker.js <ws> --mode verify`): each tick claims at most one awaiting-verifier spec through `verification.verifier_lanes` — never the builder's own lane, under a per-spec lock at `_metrics/verify-locks/` — and runs the isolated verifier. A clean pass advances `tests/ → in-review/` only; mutation proposals stay held at `tests/` for an explicit human decision. No verify tick, and no agent, ever moves a spec to `done/`.
- `automation.experiment` dial: `off` (default, inert) or `drain` (wired via `lib/automation.js` — appends one per-lane drain tick after lane/verify ticks using the existing `tl experiment` queue/drain path; folds pending queue requests, never selects or applies winners). Queueing new cohorts stays explicit (`tl experiment queue`, UI request, or `experiments.auto_initiate`); unsupported values fail loudly at `tl open` time.
- `up` never claims, moves, or edits specs, and never touches `done/`.

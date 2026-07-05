# Headless lanes — cron owns the interval, the worker owns one tick

`bin/tl-worker.js` is the last mile of cross-agent dispatch: every handoff
mechanism already exists — `agent:` lanes with folder-move claims, the
active-conflict guard, continuation dispatches for kickback resume — but
nothing *schedules* the sessions. The worker closes that gap with the dumbest
possible loop body:

```
tl-worker <workspace> --agent <lane> [--dry-run]
```

One invocation = one tick: is there run work for `<lane>` right now? If yes,
launch the lane's configured agent CLI **once** with the `tl run` brief as its
prompt, wait for the session to exit, log one line, exit. If no, exit quietly.
Put one tick per lane on a schedule and the throughline drains headlessly,
with agents handing work back and forth and everything pooling at the human
review gate.

The driver never reasons, never edits specs, never moves folders. The spawned
session does everything under the existing run procedure — the driver is the
worker's alarm clock, not its brain. The prompt is exactly the stdout of
`node bin/tl.js run <ws> --agent <lane>`, so the driver can never drift from
what an interactive run would say.

## Configure the lanes (`TRIAGE.yml`)

A lane is any shell command; tl ships no provider integrations. See
`_templates/SCHEMA.md` ("Headless lanes") for the full contract. Lane names
must be path-safe lowercase keys: letters, numbers, dots, underscores, and
hyphens only.

```yaml
lanes:
  claude:
    command: "claude -p {prompt_file}"
  codex:
    command: "codex exec --sandbox workspace-write -"
    lock_timeout_minutes: 90    # optional; default 120
```

Prompt delivery: `{prompt_file}` → shell-escaped path to the brief (written to
`_metrics/worker-prompts/<lane>-<timestamp>.txt`); `{prompt}` → shell-escaped
single-line brief (lossy — prefer `{prompt_file}`); neither placeholder → the
brief arrives on stdin. Try it without side effects first:

```
node bin/tl-worker.js throughline --agent claude --dry-run
```

Exit codes are cron-friendly: `0` no work / child ok, `1` misconfig / spawn
failure / child non-zero, `2` paused or lock held (an alerting hook for
launchd or monitoring if you want one).

## cron recipes

One line per lane. Ticks are cheap when there's no work (exit 0, one log
line), so a short interval is fine — the per-lane lock prevents overlap even
if a session runs longer than the interval.

```cron
# claude run lane, every 15 minutes
*/15 * * * * cd $HOME/Documents/GitHub/throughline && /usr/local/bin/node bin/tl-worker.js throughline --agent claude >> /tmp/tl-worker-claude.log 2>&1

# codex run lane, offset so the lanes don't tick at the same instant
7,22,37,52 * * * * cd $HOME/Documents/GitHub/throughline && /usr/local/bin/node bin/tl-worker.js throughline --agent codex >> /tmp/tl-worker-codex.log 2>&1
```

(Agent CLIs need credentials — make sure the cron environment carries the
same auth as your shell, or wrap the command in a login shell:
`bash -lc '... tl-worker ...'`.)

## launchd recipe (macOS)

`~/Library/LaunchAgents/com.tl.worker.claude.plist`, one plist per lane:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tl.worker.claude</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>bin/tl-worker.js</string>
    <string>throughline</string>
    <string>--agent</string>
    <string>claude</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/Documents/GitHub/throughline</string>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/tmp/tl-worker-claude.log</string>
  <key>StandardErrorPath</key><string>/tmp/tl-worker-claude.log</string>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.tl.worker.claude.plist`.
Duplicate with `codex` substituted for the codex lane.

## The operational model

**Stop-at-review guarantee.** The driver never moves a spec folder and never
advances a stage; the session it spawns follows the run SKILL, which carries
work at most to `in-review/` (or leaves it blocked at `tests/` when
independent verification is required). Everything a headless day produces
pools at the human gate — `/tl review` is where you sign it off. No schedule,
however aggressive, changes who is allowed to touch `done/`.

**PAUSE kill switch.** Touch a `PAUSE` file at the workspace root
(`projects/<name>/PAUSE`) and every lane's tick exits `2` without spawning.
Remove it to resume. This is the one-gesture "stop all agents" control.

**Locks.** Each tick writes `_metrics/locks/<lane>.lock` (JSON: date,
workspace, lane, pid, picked, prompt_path) just before spawning and removes it
when the session exits. A lock younger than `lock_timeout_minutes` (default
2h) makes the next tick exit `2` — one session per lane at a time. An older
lock is presumed crashed and taken over (logged as `stale_lock_takeover`).

**Continuations wake a lane after kickback.** When a human kicks a spec back
(`in-review/ → in-progress/`), the kickback writes `_dispatch/<slug>.json`
(`mode: continuation`, `status: pending`). The next tick of the *owning* lane
— `claimed_by` is binding; `agent: any` never overrides an existing claim —
picks the continuation before any fresh ready work, and the `tl run` brief
walks the session through the resume. No human has to re-assemble context: the
kickback note itself is what wakes the right agent.

**Observability.** Every non-dry tick appends one line to
`_metrics/worker-log.jsonl` (schema in `_templates/SCHEMA.md`). `--dry-run`
writes nothing anywhere — it only prints what would happen.

## The v1 verifier gap

This worker schedules the **run lane only**. With
`verification.require_independent_verifier: true`, a builder session stops at
`tests/` with `awaiting_verifier: true` — and no cron here will pick that up:
verification is `tl verify`, deliberately not this worker's job (the driver
must not invent verifier scheduling). Until a verifier worker ships (follow-up
after `enforce-independent-verifier-gate`; e.g. `tl-worker --mode verify` or a
sibling `tl-verify-worker`), run `tl verify` sessions by hand or on their own
schedule. Expect headless work to accumulate at `tests/` in the meantime —
that's the gate working, not a bug.

## Stranded-continuation recovery

A continuation is owned by its spec's `claimed_by` lane. If that lane's cron
stops running (agent uninstalled, credentials expired, machine gone), its
kickbacks wait forever — every other lane's tick correctly reports
`no_continuation`. Recovery is a human call, and human direction outranks the
lane filter:

- **Reassign the claim:** edit the spec's frontmatter — clear `claimed_by` (the
  continuation becomes claimable by the routing lane, `agent: <lane>` or
  `any`) or set it to the lane that should take over. The next tick of that
  lane resumes it.
- **Hand it over directly:** start an interactive session yourself —
  `node bin/tl.js run <ws>` prints the same resume brief to whatever agent you
  give it to.

Watch for the signature in `worker-log.jsonl`: every lane logging
`no_continuation` for days while a spec sits in `in-progress/` is a stranded
claim.

## End-to-end validation

The milestone that proves the loop — two lanes on cron draining a small
project unattended, humans only reviewing — is parked as
`threads/2026-07-04-headless-e2e-milestone-on-todo-app.md` in the throughline
workspace.

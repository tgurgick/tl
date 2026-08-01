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

## The happy path: `tl up`

You normally don't write the cron/launchd units below by hand anymore. Declare
one `automation:` profile in the workspace's TRIAGE.yml and let
`tl up <workspace>` install or refresh the schedule (plus start the cockpit
and print the next human action). (`tl open` is an alias of `tl up` — same
command, not a second product.) Canonical operator story:
`docs/canonical-e2e-path.md`.

```yaml
automation:
  enabled: true          # literal true; anything else (or an absent section) = no schedules
  interval_minutes: 15   # tick interval; fallback-on-garbage to 15
  lanes: [claude, codex] # each MUST have a lanes.<name>.command below — loud error otherwise
  verify: false          # true = isolated verify tick (tl-worker --mode verify; needs verifier_lanes)
  experiment: off        # off | drain — opt-in experiment queue/drain ticks; never auto-applies winners

verification:
  require_independent_verifier: true
  verifier_lanes:
    gemini:
      agent: gemini
      mode: verify
      isolated: true           # required
      sandbox: required        # required
      allow_network: false     # Gemini: true is rejected loudly
      allow_commands: ["npm test"]
      command: [agy]
```

`tl up` generates a **single per-workspace schedule** — one launchd plist
(`~/Library/LaunchAgents/com.tl.open.<ws>.plist`) on macOS, one cron line
elsewhere — whose body ticks each listed lane sequentially with
`bin/tl-worker.js <ws> --agent <lane>` (sequential is deliberate: calm over
swarm, and the per-lane locks prevent overlap anyway). When
`automation.verify: true`, the same schedule appends **one** isolated verify
tick (`tl-worker --mode verify`) as the primary verify drain — cockpit
verify-request files are routing hints only, not execution or queue truth.
**v1 platform gap:** macOS gets write+`launchctl load`; Linux/other get a
paste-able cron line only — `tl up` never runs `crontab` for you (use
`--print-schedule` or paste from the up output). Try `tl up <ws> --dry-run`
first; `tl up <ws> --print-schedule` emits the complete paste-able cron line
**and** plist — the right path when an agent is driving, because
`launchctl load` can hang a headless session on a macOS permission prompt. A
listed lane with no `lanes.<name>.command` fails loudly before anything is
generated. `PAUSE` still stops every tick; full contract in
`_templates/SCHEMA.md`.

Everything below — per-lane commands, quirks, and the hand-rolled cron/launchd
recipes — still applies and remains the **advanced escape hatch** (offset
schedules, per-lane intervals, non-standard layouts). `tl up` just writes the
common case for you. Interactive `tl run` / `tl verify` keep identical
contracts as manual recovery launchers.

## Configure the lanes (`TRIAGE.yml`)

A lane is an agent CLI invocation; tl ships no provider integrations. See
`_templates/SCHEMA.md` ("Headless lanes") for the full contract. Lane names
must be path-safe lowercase keys: letters, numbers, dots, underscores, and
hyphens only.

```yaml
lanes:
  claude:
    command: "claude --dangerously-skip-permissions -p"   # brief on stdin — no placeholder
  codex:
    command: "codex exec --sandbox workspace-write -"
    lock_timeout_minutes: 90    # optional; default 120
```

**Spawns are argv-first — there is no shell by default.** A string `command`
is split on whitespace into an argv array and executed directly
(`spawnSync(argv[0], argv.slice(1))`), the same argv-array shape the
experiment PROVIDERS table (`lib/experiment-runner.js`) and
`verification.verifier_lanes` already use. Nothing between the worker and
`execve` parses quotes, expands variables, or interprets operators — the
quoting-injection surface simply does not exist on this path. Two other
command shapes:

- **YAML list form** — `command: [codex, exec, -c, sandbox_workspace_write.writable_roots=["/x"], -]`
  passes each element verbatim as one argument. Use it when an argument
  contains spaces or shell-looking characters; under argv those bytes are
  plain data. (The hand-rolled parser splits inline lists on commas, so a
  token containing a comma still needs the agent's profile file instead.)
- **`shell: true`** — the explicit opt-in for a lane that genuinely needs
  pipes or redirection. Only then does the worker run the command string
  through the shell (old behavior), with the escape helpers guarding
  placeholder substitution.

A string command containing shell syntax (quotes, `|`, `&`, `;`, `<`, `>`,
`(`, `)`, `$`, backticks, `\`, globs) **without** `shell: true` is a loud
misconfiguration: the tick exits `1` with reason `shell_required` and
executes nothing — never a silent wrong-argv split. Leading `~` is also
rejected (no shell to expand it); use an absolute path.

Prompt delivery: **stdin is canonical** — a command with no `{prompt_file}` or
`{prompt}` placeholder receives the brief bytes on stdin (the shape every
working lane uses). `{prompt}` substitutes the single-line brief (lossy —
avoid for multiline run briefs); on the argv path it becomes exactly one
argument with no escaping needed, on a `shell: true` lane it is
shell-escaped. **`{prompt_file}` is wrong for CLIs that treat `-p <arg>` as
literal prompt text** (notably `claude -p`): the worker substitutes the
*path* to `_metrics/worker-prompts/<lane>-<timestamp>.txt`, so the session
receives a filename string, not the brief — only works if the agent happens
to open the path itself. Do not use `{prompt_file}` in claude lanes; pipe on
stdin instead. Try it without side effects first:

```
node bin/tl-worker.js throughline --agent claude --dry-run
```

Exit codes are cron-friendly: `0` no work / child ok, `1` misconfig / spawn
failure / child non-zero, `2` paused or lock held (an alerting hook for
launchd or monitoring if you want one).

The examples above are the minimal shapes. Real agent CLIs each have a trap
or two — read the next three sections before writing a lane for one.

## Per-lane invocation quirks

E2e findings from the first real multi-lane runs. Every one of these
produced a lane that *looked* correctly configured.

**agy (Antigravity gemini) — flag order is load-bearing.**
`agy -p --dangerously-skip-permissions "<prompt>"` silently misfires: `-p`
consumes the *next token* as its prompt value, so the agent receives the
literal string `--dangerously-skip-permissions` as its task — the first lane
run produced documentation about the flag instead of doing the work. Exit 0,
no error, no file touched. Correct order:

```
agy --dangerously-skip-permissions -p "<prompt>"
```

A lane template that gets this wrong fails **silently green** — the worst
failure mode for a cron lane, because every tick reports success while no
work moves. Today the only tell is human: `_metrics/worker-log.jsonl` shows
child exit 0 while the picked spec never moved folders. Watch for that
signature after adding or editing any lane command. (A driver-side sanity
check — spec unmoved after child exit 0 → log a suspicious-tick warning — is
a candidate future spec; the driver does not do this yet.)

**gemini CLI proper — not usable headless here yet.** It exits with an
ineligibility/project-id error (wants `GOOGLE_CLOUD_PROJECT` / a different
auth tier). The working gemini lane is Antigravity's `agy` — with a trust
implication: agy's permission model is blunter.
`--dangerously-skip-permissions` is full YOLO; there are no sandbox tiers
like codex's `--sandbox workspace-write`. Prefer agy for now, knowing that.

**cursor-agent — bake in `-f`.** `cursor-agent -p "<prompt>"` refuses to run
in an untrusted directory ("Pass --trust, --yolo, or -f"). The trust flag
has to live in the lane command:

```
cursor-agent -f -p "<prompt>"
```

Unlike agy's misfire this one fails *loudly* — the good failure mode — but a
lane config that forgets the flag still burns every tick.

**codex — `-p` means profile, not prompt.** Don't pattern-match from the
other lanes: in `codex exec`, `-p <profile>` selects a config profile and
the brief arrives on stdin via the trailing `-`. See the writable-roots
section below for why you'll want a profile at all.

**claude — prompt on stdin; token setup has gotchas.** The lane command is
`claude [extra…] -p` with **no** `-p` argument — the brief arrives on stdin
(the `cat brief | claude -p` shape). Never `claude -p {prompt_file}`: `-p`
takes literal prompt text, so `{prompt_file}` passes a path string, not the
brief (see prompt delivery above).

Headless auth uses `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (run
in a plain terminal outside any Claude Code session):

```bash
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN="⟨paste token here⟩"
export CLAUDE_CODE_OAUTH_TOKEN="$(printf %s "$CLAUDE_CODE_OAUTH_TOKEN" | tr -d '[:space:]')"
```

Setup gotchas (full walkthrough:
`done/research-claude-headless-auth/outcome/SMOKE.md` in the throughline
workspace):

1. **Line-wrap newline.** Terminal line-wrap embeds a hard newline in a
   copied token → malformed Authorization header (`Header 'N' has invalid
   value`). The `tr -d '[:space:]'` line above is part of the procedure, not
   optional cleanup.
2. **Redaction rule.** When sharing errors or logs, redact everything after
   `sk-ant-oat01-` — tokens have been exposed in error output during setup
   and must be revoked.
3. **Cron/launchd env.** Scheduled ticks do not inherit your shell's exports.
   Put `CLAUDE_CODE_OAUTH_TOKEN` in the schedule's environment (launchd
   `EnvironmentVariables` dict, cron `VAR=value` prefix, or a wrapper that
   sources it) — the same token, still whitespace-stripped. Without it every
   claude tick fails auth silently or loudly depending on the CLI.

Smoke-test before wiring the lane:

```bash
claude -p "Reply with exactly: OK" --output-format text </dev/null
```

Worked `lanes:` examples, one per lane:

```yaml
lanes:
  claude:
    command: "claude --dangerously-skip-permissions -p"           # brief on stdin
  codex:
    command: "codex exec --sandbox workspace-write -p todoapp -"  # -p = profile; brief on stdin
  gemini:
    command: "agy --dangerously-skip-permissions -p"              # -p last; brief on stdin
  cursor:
    command: "cursor-agent -f -p {prompt}"                        # -f = trust; {prompt} inline (no stdin)
```

## No nested quoting in `lanes:` commands

Hard rule, now **enforced by the argv-first guard** rather than merely
documented: a string lane command must never contain nested quoting or
escape sequences — the tick refuses to run it (`shell_required`, exit `1`)
instead of letting a wrong parse fail silently green. The failure that
taught us this was an attempt to pass inline TOML to codex:

```
codex exec ... -c 'sandbox_workspace_write.writable_roots=["…"]'
```

The TRIAGE.yml parser is hand-rolled and keeps backslash escapes literal, so
the escapes survived into the argument as literal characters, producing
invalid TOML — which codex silently treated as a raw string. No error
anywhere; the setting just didn't apply. Anything structured — arrays, TOML,
JSON, quoted paths — goes in the agent's own config/profile file (the lane
command only names the profile), or in the YAML **list form**, where each
element reaches the CLI verbatim without any shell in the way. `shell: true`
lanes are the one exception: there the string is genuinely shell input, and
the no-nested-quoting rule stays a hard manual rule.

## Sandboxed lanes and external repos: per-workspace writable roots

`codex exec --sandbox workspace-write` grants write access to its cwd only —
the tl checkout. A workspace whose `repo` points *outside* the checkout
blocks on the first write (`mkdir ~/code/todo-app/... Operation not
permitted`). The failure is at least honest — in the first e2e run codex
claimed, probed, blocked itself with a clear note, zero partial writes — but
every sandboxing lane needs the workspace's repo granted explicitly, and
(per the rule above) that grant cannot ride inline in the lane command.

The pattern is one profile per workspace. For codex:

`~/.codex/<ws>.config.toml`:

```toml
[sandbox_workspace_write]
writable_roots = ["/Users/you/code/todo-app"]
```

Lane command:

```
codex exec --sandbox workspace-write -p <profile> -
```

When you add a workspace whose `repo` lives outside the tl checkout, create
the profile before the lane's first tick — otherwise the first tick burns on
the permission block.

## cron recipes (advanced escape hatch — `tl up` writes the common case)

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

## launchd recipe (macOS — advanced escape hatch; `tl up` generates `com.tl.open.<ws>.plist`)

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

## Isolated verify ticks

When `automation.verify: true`, the per-workspace schedule appends:

```
node bin/tl-worker.js <workspace> --mode verify
```

One tick claims **at most one** eligible `awaiting_verifier` spec through a
configured `verification.verifier_lanes` entry. The builder (`claimed_by`) is
never assigned their own work. A per-spec lock at
`_metrics/verify-locks/<slug>.lock` prevents concurrent lanes from double-
checking. The tick invokes the isolated runner (`lib/verifier-worker.js`) in a
disposable worktree: TL runs only allowlisted acceptance commands, scrubs
credential env vars, and accepts a structured verdict. Clean pass →
`in-review/` with `verified_by` provenance. Failures stay in `tests/` with an
auditable `blocked_reason`. Mutation proposals become
`human-decision-required` — the UI/CLI present authorize fix-forward vs kick
back; **nothing is auto-applied**.

**Trust model.** The model is an untrusted reviewer. Canonical TL code owns
lifecycle transitions and metadata. `--dangerously-skip-permissions`, missing
`isolated`/`sandbox`, or Gemini `allow_network: true` fail loudly at config
time. Cockpit **Dispatch verify** (and `tl verify --dispatch`) only write
`_metrics/verify-requests/*.json` targeting a lane ≠ builder (or
`any-other`); the UI/server never spawn agent CLIs. Drain with the scheduled
tick or `tl verify --execute`.

```cron
# optional hand-rolled verify tick (tl up already chains this when verify: true)
*/15 * * * * cd $HOME/Documents/GitHub/throughline && /usr/local/bin/node bin/tl-worker.js throughline --mode verify >> /tmp/tl-worker-verify.log 2>&1
```

## Opt-in experiment drain ticks

`automation.experiment` is **off by default** (absent field = `off`). Experiments stay research/compare — not the canonical happy path — and winner application stays an explicit human action (`tl experiment select|apply|reject|send-to-review`). The dial only schedules existing queue/drain operations:

| Value | Effect |
|-------|--------|
| `off` | Inert — no experiment ticks in the schedule. |
| `drain` | After lane (+ optional verify) ticks, run `node bin/tl.js experiment drain --agent <lane> <ws>` once per `automation.lanes` entry. |

`drain` folds pending `_experiments/queue/*.json` request configs and drains queued candidate/judge rows for that agent lane — the same path as a manual drain. It does **not** queue new cohorts by itself (use `tl experiment queue`, the UI request form, or `experiments.auto_initiate`), and it never calls select/apply. Unsupported values fail loudly at `tl up` time (same as a missing lane command); `drain` with an empty `lanes` list is also a hard error. `tl up` status prints exactly which drain commands will run. Experiment drain is **experiment fixture proof**, not the canonical operating path.

```cron
# optional hand-rolled experiment drain (tl up chains these when experiment: drain)
*/15 * * * * cd $HOME/Documents/GitHub/throughline && /usr/local/bin/node bin/tl.js experiment drain --agent claude throughline >> /tmp/tl-experiment-drain.log 2>&1
```

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

## End-to-end validation (headless lifecycle proof)

The milestone that proves the **canonical operating path** — two lanes on
cron draining a small project unattended, humans only reviewing — shipped as
`projects/throughline/done/headless-e2e-todo-app/`. That is headless lifecycle
proof, not an experiment fixture and not a browser/CI E2E suite. See
`docs/canonical-e2e-path.md`.

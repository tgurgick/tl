'use strict';

// Experiment runner — executes ONE claimed queue row locally and always
// leaves the same artifact set behind, whatever happened.
//
// The contract that matters (spec hint, verbatim): every candidate produces
// the same artifact set and terminal status. Even a fault writes:
//   _experiments/<id>/candidates/<cid>/PATCH.diff     ('' when none)
//   _experiments/<id>/candidates/<cid>/FEEDBACK.md    what happened, honestly
//   _experiments/<id>/candidates/<cid>/METRICS.json   status/fault/fingerprint
//   _experiments/<id>/candidates/<cid>/TRACE.jsonl    observable action events
//   _metrics/candidate-run-log.jsonl                  one append-only row
//
// Runners, keyed by the row's `agent_tool`:
//   fixture  deterministic, side-effect-free — the protocol proof
//   shell    runs `config.command` in an ISOLATED workdir (git worktree from
//            base_commit, sibling-clone fallback) and collects `git diff`.
//            UNSANDBOXED host execution: requires the explicit trust opt-in
//            (config.unsafe_host_exec: true on the row, or drain
//            opts.allowUnsafeHostExec / CLI --unsafe-host-exec) or it fails
//            closed before anything runs
//   codex / gemini / claude / cursor
//            provider adapters — same isolation + artifact contract as
//            `shell`, but each encodes its CLI's invocation quirks (see the
//            PROVIDERS table below and docs/headless-lanes.md)
//
// ---- Seam for later worktree/clone orchestration -------------------------
// Real agent adapters (Claude / Codex / Cursor SDK / cloud) plug in at TWO
// points, both exported:
//   1. RUNNERS — register `RUNNERS[agent_tool] = (workspaceDir, row, opts) =>
//      ({ status, patch, feedback, output, taskComplete, agentModel, reason })`.
//      The wrapper (`runCandidate`) owns budget stop, timeout mapping, patch
//      validation, artifact writing, and log rows — an adapter only produces.
//      A full adapter should satisfy lib/experiment-adapter.js `isAdapter` and
//      wrap its prepare/start/collect cycle inside one RUNNERS entry.
//   2. createIsolatedWorkdir / removeIsolatedWorkdir — the isolation strategy.
//      Local case implemented here: `git worktree add --detach <dir> <commit>`
//      (cheap, shares the object store), falling back to a sibling clone when
//      worktrees are unavailable. A remote/cloud adapter replaces this pair
//      with its own sandbox provisioning but keeps the same promise: the
//      canonical repo working tree is NEVER mutated by a candidate run.
//
// TRUST BOUNDARY (lib/env-policy.js). A worktree/clone is an ISOLATED
// CHECKOUT, not a security sandbox: a spawned command keeps full filesystem
// read, network, and host authority. The boundary tl enforces here is the
// environment: every spawn receives a SCRUBBED environment (ambient
// credentials dropped by default), each provider lane gets back exactly its
// own auth variables via the per-lane allowlist, rows widen the boundary only
// through explicit scoped config (config.pass_env names / config.env values),
// and every value that crosses the boundary is redacted out of output tails
// and patches before any artifact is written. Names of passed-through
// variables are logged; values never are.
// ---------------------------------------------------------------------------
//
// Fault posture (all terminal, all serialized as both status and fault):
//   over_budget     estimated cost exceeds the row's budget_usd — stopped
//                   before execution
//   unavailable     no local runner for the row's agent_tool, or the shell
//                   runner's repo is missing
//   timed_out       the command outlived timeout_minutes
//   failed          the command exited non-zero (or the runner crashed)
//   invalid_output  the run "succeeded" but produced no usable patch
//
// Workers never apply winners — that is an explicit human CLI action, so this
// module must not import lib/experiment-apply.js (a test enforces it).
// Node stdlib only; zero dependencies.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { makeFingerprint } = require('./experiment-adapter');
const { buildLaneEnv, redactSecretValues, hostExecAllowed, isAutoInitiated } = require('./env-policy');
const {
  createTraceSession,
  extractTraceFeatures,
  appendTraceFeatures,
  resolveModelVisibility,
  coerceRunnerEvent,
} = require('./experiment-trace');
const { parseFrontmatter } = require('./parse');

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function datePart(iso) {
  return iso.slice(0, 10);
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
}

function appendJsonl(file, row) {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function git(cwd, args, opts = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
}

function tail(s, lines = 20, chars = 2000) {
  const text = String(s || '').trim();
  if (!text) return '';
  return text.split('\n').slice(-lines).join('\n').slice(-chars);
}

// ---------- isolation (the local worktree/clone strategy) ----------

// Create an isolated workdir for one candidate run: a detached git worktree
// at base_commit (preferred — cheap, shares objects), else a sibling clone.
// Returns { ok, mode: 'worktree' | 'clone', error }. The candidate mutates
// ONLY this directory; the canonical working tree is untouched.
function createIsolatedWorkdir(repoDir, baseCommit, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true }); // stale leftovers never poison a run
  mkdirp(path.dirname(destDir));
  const ref = baseCommit && baseCommit !== 'unknown' ? baseCommit : 'HEAD';

  const wt = git(repoDir, ['worktree', 'add', '--detach', destDir, ref]);
  if (wt.status === 0) return { ok: true, mode: 'worktree', error: null };

  const clone = git(path.dirname(destDir), ['clone', '--quiet', '--no-hardlinks', repoDir, destDir]);
  if (clone.status === 0) {
    const co = ref === 'HEAD' ? { status: 0 } : git(destDir, ['checkout', '--quiet', '--detach', ref]);
    if (co.status === 0) return { ok: true, mode: 'clone', error: null };
  }
  return {
    ok: false, mode: null,
    error: tail((wt.stderr || '') + '\n' + (clone.stderr || ''), 3, 300) || 'worktree add and clone both failed',
  };
}

// Tear the isolated workdir down. Best effort — a leftover directory is
// debris, never a correctness problem, so this never throws.
function removeIsolatedWorkdir(repoDir, destDir, mode) {
  try {
    if (mode === 'worktree') {
      git(repoDir, ['worktree', 'remove', '--force', destDir]);
      git(repoDir, ['worktree', 'prune']);
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

// ---------- the two local runners ----------

// Deterministic fixture candidate: no processes, no isolation needed (it
// writes only its own artifact folder). `config.complete` pins the outcome;
// default mirrors the fixture proof — primary completes, shadow doesn't.
function runFixtureCandidate(workspaceDir, row) {
  const config = row.config || {};
  const complete = config.complete !== undefined ? Boolean(config.complete) : row.role === 'primary';
  const patch = [
    `diff --git a/fixture-${row.candidate_id}.txt b/fixture-${row.candidate_id}.txt`,
    'new file mode 100644',
    'index 0000000..2cf24d8',
    '--- /dev/null',
    `+++ b/fixture-${row.candidate_id}.txt`,
    '@@ -0,0 +1 @@',
    `+fixture ${complete ? 'complete' : 'incomplete'}`,
    '',
  ].join('\n');
  return {
    status: 'succeeded',
    patch,
    taskComplete: complete,
    agentModel: row.agent_model_requested || 'deterministic',
    agentModelSource: 'fixture',
    framework: 'throughline-fixture',
    output: '',
    events: [
      { type: 'plan_summary', summary: 'Deterministic fixture plan: write a fixed patch and report task_complete.' },
      { type: 'patch', summary: 'Wrote deterministic fixture patch.' },
    ],
  };
}

// Shell candidate: run `config.command` inside an isolated worktree/clone of
// `config.repo` at the experiment's base_commit, then collect `git diff`
// (intent-to-add first, so new files show) as PATCH.diff.
//
// The worktree isolates the CHECKOUT, not the machine — running an arbitrary
// config.command is unsandboxed trusted-code execution, so it demands the
// explicit opt-in (checked FIRST, before any isolation work) and runs with a
// scrubbed environment: no ambient credential reaches the command unless the
// row names it via config.pass_env or sets it via config.env.
function runShellCandidate(workspaceDir, row, opts = {}) {
  const config = row.config || {};
  if (!hostExecAllowed(config, opts)) {
    // Two distinct refusals, both closed before anything runs: the auto path
    // (initiated_by: policy) has no opt-in AT ALL — an unattended queue means
    // nobody reviewed this command as trusted code, so neither the row flag
    // nor drain --unsafe-host-exec widens it (lib/env-policy.js).
    return {
      status: 'failed',
      reason: isAutoInitiated(opts.meta)
        ? 'unsandboxed shell execution refused: this experiment was auto-initiated (initiated_by: policy) and unattended shadows never execute host commands — config.unsafe_host_exec and drain --unsafe-host-exec are ignored on the auto path. Queue the cohort manually (tl experiment queue) after reviewing the command as trusted code.'
        : 'unsandboxed shell execution declined: the shell runner executes config.command directly on this host — a worktree isolates the checkout, not the machine (filesystem read, network, and host access remain). Opt in explicitly with config.unsafe_host_exec: true on the queue row, or drain with --unsafe-host-exec, after reviewing the command as trusted code.',
      events: [],
    };
  }
  const repo = config.repo ? path.resolve(config.repo) : null;
  if (!repo || !fs.existsSync(repo)) {
    return { status: 'unavailable', reason: 'shell runner requires config.repo pointing at an existing repo', events: [] };
  }
  const meta = opts.meta || {};
  const baseCommit = config.base_commit || meta.base_commit || 'unknown';
  const workdir = path.join(workspaceDir, '_experiments', row.experiment_id, 'work', row.candidate_id);
  const events = [];

  const iso = createIsolatedWorkdir(repo, baseCommit, workdir);
  if (!iso.ok) {
    return { status: 'failed', reason: `could not create isolated workdir: ${iso.error}`, events };
  }
  events.push({ type: 'status', summary: `Created isolated ${iso.mode} at base ${baseCommit}.` });

  try {
    const command = String(config.command || 'true');
    const timeoutMs = row.timeout_minutes != null && Number.isFinite(+row.timeout_minutes)
      ? Math.max(1, Math.round(+row.timeout_minutes * 60000)) : undefined;
    events.push({
      type: 'plan_summary',
      summary: 'Shell plan: run config.command in an isolated workdir, then collect git diff as PATCH.diff.',
    });
    const policy = buildLaneEnv('shell', { configEnv: config.env, passEnv: config.pass_env });
    events.push({
      type: 'status',
      summary: `Environment policy: ambient credentials scrubbed; passed through by name: ${policy.passed.length ? policy.passed.join(', ') : 'none'}.`,
    });
    events.push({
      type: 'command',
      summary: `Running shell command${timeoutMs ? ` (timeout ${row.timeout_minutes} min)` : ''}: ${command.slice(0, 200)}`,
      command: command.slice(0, 500),
    });
    const r = spawnSync('/bin/sh', ['-c', command], {
      cwd: workdir, encoding: 'utf8', timeout: timeoutMs,
      env: policy.env,
    });
    const output = redactSecretValues(tail((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')), policy.secretValues);

    if (r.error && r.error.code === 'ETIMEDOUT') {
      return { status: 'timed_out', reason: `command exceeded timeout of ${row.timeout_minutes} minute(s)`, output, events };
    }
    if (r.error) {
      return { status: 'failed', reason: `command could not run: ${r.error.message}`, output, events };
    }
    if (r.status !== 0) {
      return { status: 'failed', reason: `command exited ${r.status}`, output, events };
    }

    git(workdir, ['add', '--intent-to-add', '--all']); // untracked files become diffable
    const diff = git(workdir, ['diff']);
    // Redact boundary-crossing secret values from the patch too — a leaked
    // credential must never land in an artifact, even a broken patch beats it.
    const patch = diff.status === 0 ? redactSecretValues(diff.stdout, policy.secretValues) : '';
    events.push({ type: 'patch', summary: `Collected git diff (${patch.split('\n').length} lines).` });
    return { status: 'succeeded', patch, taskComplete: true, output, events };
  } finally {
    removeIsolatedWorkdir(repo, workdir, iso.mode);
    events.push({ type: 'status', summary: `Removed isolated ${iso.mode}.` });
  }
}

// ---------- provider adapters (codex / gemini / claude / cursor) ----------
//
// Thin wrappers over the same isolation + artifact contract as `shell`, but
// each one ENCODES its CLI's invocation quirks (ground truth:
// docs/headless-lanes.md "Per-lane invocation quirks") so a cohort config can
// say `agent_tool: "codex"` and cannot misconfigure the flag order:
//
//   codex    codex exec --sandbox <mode> [-p <profile>] [extra…] -   (prompt on stdin;
//            `-p` means PROFILE, never prompt; trailing `-` reads the brief from stdin)
//   gemini   agy --dangerously-skip-permissions [extra…] -p <prompt>  (flag order is
//            load-bearing: `-p` consumes the NEXT argv token as the prompt, so it is
//            always emitted LAST with the prompt as the final element — extras can
//            never be swallowed as the task)
//   claude   claude [extra…] -p                                       (print mode;
//            prompt on stdin — the `cat brief | claude -p` shape)
//   cursor   cursor-agent -f [extra…] -p <prompt>                     (`-f` trusts the
//            workdir — without it the run refuses; baked in, like gemini's order)
//
// No shell is ever involved: the CLI is spawned with an argv ARRAY and the
// prompt travels on stdin or as one argv element, so there is no nested-
// quoting hazard by construction (the docs' hard rule). Overrides are
// structured config fields on the queue row, never string concatenation:
//   config.repo         (required) repo the isolated workdir is created from
//   config.prompt       explicit prompt text; default: the tl spec named by
//                       the experiment's `tl_spec` (turnkey path)
//   config.profile      codex only — the `-p <profile>` config profile
//   config.sandbox      codex only — sandbox mode (default workspace-write)
//   config.extra_flags  array of extra argv elements, inserted in the one slot
//                       per adapter where they cannot displace the load-bearing
//                       flags; entries are passed as-is, one argv element each
//   config.env          explicit environment values (merged over the SCRUBBED
//                       base env — never over raw process.env; lib/env-policy.js)
//   config.pass_env     array of ambient variable NAMES to pass through the
//                       scrub in addition to the lane's own allowlist; names
//                       are logged, values are redacted from artifacts
// Budget (`over_budget`) is stopped by the wrapper before execution;
// timeout_minutes maps to the spawn timeout exactly like `shell`. A CLI
// missing from PATH (spawn ENOENT) is `unavailable` — with the full artifact
// set, per the contract.

function extraFlags(config) {
  return Array.isArray(config.extra_flags) ? config.extra_flags.map(String) : [];
}

// argv builders, one per provider. `prompt: 'stdin'` → the prompt is piped;
// `prompt: 'argv'` → the prompt is appended as the FINAL argv element (after
// the trailing `-p` these builders emit last).
const PROVIDERS = {
  codex: {
    bin: 'codex',
    prompt: 'stdin',
    args: (config) => ['exec', '--sandbox', String(config.sandbox || 'workspace-write'),
      ...(config.profile ? ['-p', String(config.profile)] : []),
      ...extraFlags(config), '-'],
  },
  gemini: {
    bin: 'agy',
    prompt: 'argv',
    args: (config) => ['--dangerously-skip-permissions', ...extraFlags(config), '-p'],
  },
  claude: {
    bin: 'claude',
    prompt: 'stdin',
    args: (config) => [...extraFlags(config), '-p'],
  },
  cursor: {
    bin: 'cursor-agent',
    prompt: 'argv',
    args: (config) => ['-f', ...extraFlags(config), '-p'],
  },
};

// The turnkey prompt: explicit `config.prompt` wins; otherwise the tl spec the
// experiment was queued from (meta.tl_spec) IS the brief. Null → no prompt.
function buildProviderPrompt(workspaceDir, row, meta) {
  const config = row.config || {};
  if (config.prompt) return String(config.prompt);
  const specRel = String(meta.tl_spec || '').replace(/^\/+/, '');
  if (!specRel) return null;
  const specFile = specRel.endsWith('.md')
    ? path.join(workspaceDir, specRel)
    : path.join(workspaceDir, specRel.replace(/\/+$/, ''), 'SPEC.md');
  try {
    const text = fs.readFileSync(specFile, 'utf8');
    return [
      'You are one candidate in a controlled experiment. Complete the spec below',
      'in the current working directory. Leave your changes in the working tree;',
      'do not commit, and do not touch anything outside this directory.',
      '',
      text,
    ].join('\n');
  } catch {
    return null;
  }
}

// One provider candidate: isolate at base_commit, spawn the CLI (argv array,
// prompt per the adapter's delivery mode), collect `git diff` — the same
// terminal-status mapping as `shell`, plus ENOENT → `unavailable`.
function runProviderCandidate(providerKey, workspaceDir, row, opts = {}) {
  const provider = PROVIDERS[providerKey];
  const config = row.config || {};
  const meta = opts.meta || {};
  const repo = config.repo ? path.resolve(config.repo) : null;
  if (!repo || !fs.existsSync(repo)) {
    return { status: 'unavailable', reason: `${providerKey} runner requires config.repo pointing at an existing repo`, events: [] };
  }
  const prompt = buildProviderPrompt(workspaceDir, row, meta);
  if (!prompt) {
    return { status: 'failed', reason: `${providerKey} runner has no prompt: set config.prompt or queue the experiment from a tl spec`, events: [] };
  }

  const baseCommit = config.base_commit || meta.base_commit || 'unknown';
  const workdir = path.join(workspaceDir, '_experiments', row.experiment_id, 'work', row.candidate_id);
  const events = [];

  const iso = createIsolatedWorkdir(repo, baseCommit, workdir);
  if (!iso.ok) {
    return { status: 'failed', reason: `could not create isolated workdir: ${iso.error}`, events };
  }
  events.push({ type: 'status', summary: `Created isolated ${iso.mode} at base ${baseCommit}.` });

  try {
    const args = provider.args(config);
    const argv = provider.prompt === 'argv' ? [...args, prompt] : args;
    const timeoutMs = row.timeout_minutes != null && Number.isFinite(+row.timeout_minutes)
      ? Math.max(1, Math.round(+row.timeout_minutes * 60000)) : undefined;
    events.push({
      type: 'plan_summary',
      summary: `${providerKey} plan: isolate at base_commit, spawn ${provider.bin}, collect git diff as PATCH.diff.`,
    });
    // Per-lane environment: scrubbed ambient env + exactly this provider's
    // own auth variables (LANE_ENV_ALLOWLIST) + explicit row config. The
    // claude lane gets CLAUDE_CODE_OAUTH_TOKEN back; it never sees another
    // vendor's credentials, and no lane sees e.g. JIRA_API_TOKEN.
    const policy = buildLaneEnv(providerKey, { configEnv: config.env, passEnv: config.pass_env });
    events.push({
      type: 'status',
      summary: `Environment policy: ambient credentials scrubbed; passed through by name: ${policy.passed.length ? policy.passed.join(', ') : 'none'}.`,
    });
    events.push({
      type: 'command',
      summary: `Running ${provider.bin} ${args.join(' ')}${provider.prompt === 'stdin' ? ' (prompt on stdin)' : ' <prompt as final argv>'}${timeoutMs ? ` (timeout ${row.timeout_minutes} min)` : ''}`,
      command: `${provider.bin} ${args.join(' ')}`.slice(0, 500),
    });
    const r = spawnSync(provider.bin, argv, {
      cwd: workdir, encoding: 'utf8', timeout: timeoutMs,
      input: provider.prompt === 'stdin' ? prompt : undefined,
      env: policy.env,
    });
    const output = redactSecretValues(tail((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')), policy.secretValues);

    if (r.error && r.error.code === 'ENOENT') {
      return { status: 'unavailable', reason: `${provider.bin} CLI not found on PATH — a machine with ${provider.bin} installed must drain this lane`, output, events };
    }
    if (r.error && r.error.code === 'ETIMEDOUT') {
      return { status: 'timed_out', reason: `${provider.bin} exceeded timeout of ${row.timeout_minutes} minute(s)`, output, events };
    }
    if (r.error) {
      return { status: 'failed', reason: `${provider.bin} could not run: ${r.error.message}`, output, events };
    }
    if (r.status !== 0) {
      return { status: 'failed', reason: `${provider.bin} exited ${r.status}`, output, events };
    }

    git(workdir, ['add', '--intent-to-add', '--all']); // untracked files become diffable
    const diff = git(workdir, ['diff']);
    // Same artifact discipline as shell: boundary-crossing secret values are
    // redacted out of the patch before it can land on disk.
    const patch = diff.status === 0 ? redactSecretValues(diff.stdout, policy.secretValues) : '';
    events.push({ type: 'patch', summary: `Collected git diff (${patch.split('\n').length} lines).` });
    return {
      status: 'succeeded',
      patch,
      taskComplete: true,
      output,
      events,
      framework: providerKey,
      // Best-effort: adapters may later fill these from SDK/hook/session reports.
      // No current provider adapter emits a model flag. Preserve the request
      // separately, but never claim it identifies the model that actually ran.
      agentModel: row.agent_model_requested ? null : resultModelFromConfig(row, providerKey),
      agentModelSource: row.agent_model_requested
        ? 'unfulfilled-request'
        : (providerKey === 'cursor' ? 'unknown' : 'reported'),
      agentModelAuto: Boolean(row.agent_model_requested) || (providerKey === 'cursor'),
    };
  } finally {
    removeIsolatedWorkdir(repo, workdir, iso.mode);
    events.push({ type: 'status', summary: `Removed isolated ${iso.mode}.` });
  }
}

function resultModelFromConfig(row, providerKey) {
  if (row.agent_model_requested) return String(row.agent_model_requested);
  if (providerKey === 'cursor') return null; // auto — resolved model unknown without SDK/hook
  return null;
}

// The runner registry — the first seam. Later adapters (SDK/cloud workers)
// register here under their agent_tool; the queue and wrapper never change.
// Unknown tools are `unavailable`, never a crash.
const RUNNERS = {
  fixture: runFixtureCandidate,
  shell: runShellCandidate,
  codex: (ws, row, opts) => runProviderCandidate('codex', ws, row, opts),
  gemini: (ws, row, opts) => runProviderCandidate('gemini', ws, row, opts),
  claude: (ws, row, opts) => runProviderCandidate('claude', ws, row, opts),
  cursor: (ws, row, opts) => runProviderCandidate('cursor', ws, row, opts),
};

function hasRunner(agentTool) {
  return Object.prototype.hasOwnProperty.call(RUNNERS, String(agentTool || ''));
}

// ---------- the wrapper: run one claimed row, always leave artifacts ----------

function readExperimentMeta(workspaceDir, experimentId) {
  try {
    const text = fs.readFileSync(path.join(workspaceDir, '_experiments', experimentId, 'EXPERIMENT.md'), 'utf8');
    return parseFrontmatter(text).meta || {};
  } catch {
    return {};
  }
}

// Execute one CLAIMED queue row. Owns the cross-cutting rules so individual
// runners stay thin: budget stop before execution, unavailable-tool mapping,
// empty-patch → invalid_output, and the invariant artifact set + log row on
// EVERY terminal path. Returns { status, reason, candidateDir }.
function runCandidate(workspaceDir, row, opts = {}) {
  const startedAt = Date.now();
  const started = isoNow(opts.now);
  const meta = readExperimentMeta(workspaceDir, row.experiment_id);
  const config = row.config || {};
  const candDir = path.join(workspaceDir, '_experiments', row.experiment_id, 'candidates', row.candidate_id);

  // Trace opens before execution so every terminal path — including
  // over_budget / unavailable — still leaves an append-only TRACE.jsonl.
  const earlyVisibility = resolveModelVisibility({
    agent_tool: row.agent_tool,
    agent_model_requested: row.agent_model_requested,
    agent_model: row.agent_model_requested,
    agent_model_source: row.agent_model_requested ? 'requested' : undefined,
  });
  const session = createTraceSession(candDir, {
    ...earlyVisibility,
    source: 'runner',
  }, { now: opts.now });
  session.append({
    ts: started,
    type: 'start',
    status: 'running',
    summary: `Claimed by ${row.claimed_by || 'worker'} (attempt ${row.attempt}); starting ${row.agent_tool} candidate.`,
  });

  let result;
  const estimated = Number(config.estimated_cost_usd) || 0;
  if (row.budget_usd != null && estimated > row.budget_usd) {
    // Budget stop happens BEFORE execution — the cheapest possible fault.
    result = { status: 'over_budget', reason: `estimated cost $${estimated} exceeds budget $${row.budget_usd}`, events: [] };
  } else if (!hasRunner(row.agent_tool)) {
    result = { status: 'unavailable', reason: `no local runner for agent_tool "${row.agent_tool}" — a ${row.agent_tool} worker (SDK/cloud/CLI) must drain this lane`, events: [] };
  } else {
    try {
      result = RUNNERS[row.agent_tool](workspaceDir, row, { ...opts, meta });
    } catch (e) {
      result = { status: 'failed', reason: `runner threw: ${String(e.message).slice(0, 300)}`, events: [] };
    }
  }

  let { status } = result;
  let reason = result.reason || null;
  const patch = String(result.patch || '');
  if (status === 'succeeded' && !patch.trim()) {
    status = 'invalid_output';
    reason = 'run finished but produced an empty or missing patch';
  }
  const fault = status === 'succeeded' ? null : status;
  const finished = isoNow(opts.now);
  const durationMinutes = Math.round(((Date.now() - startedAt) / 60000) * 1000) / 1000;

  let visibility = resolveModelVisibility({
    agent_tool: row.agent_tool,
    agent_model_requested: row.agent_model_requested,
    agent_model: result.agentModel != null ? result.agentModel : row.agent_model_requested,
    agent_model_auto: result.agentModelAuto,
    agent_model_source: result.agentModelSource,
  });
  // `unfulfilled-request` is deliberately runner-local until the provider
  // adapters gain model flags and the shared fingerprint schema is expanded.
  // The resolver's safe fallback would otherwise reconstruct the requested
  // label as the resolved model, repeating the dishonest stamp fixed here.
  if (result.agentModelSource === 'unfulfilled-request') {
    visibility = {
      ...visibility,
      agent_model: 'unknown',
      agent_model_auto: true,
      agent_model_source: 'unfulfilled-request',
    };
  }
  session.setIdentity({ ...visibility, source: 'runner' });

  for (const ev of result.events || []) {
    const coerced = coerceRunnerEvent(ev);
    session.append({ ts: finished, status: 'running', ...coerced });
  }
  if (fault) {
    session.append({
      ts: finished,
      type: 'fault',
      status,
      summary: reason || `Fault: ${fault}`,
      fault,
    });
  }
  session.append({
    ts: finished,
    type: 'finish',
    status,
    summary: reason || `Finished with status ${status}.`,
    duration_ms: Math.round((Date.now() - startedAt)),
  });

  // The invariant artifact set — written on every terminal path, fault or not.
  const fingerprint = makeFingerprint({
    agent_tool: visibility.agent_tool,
    agent_model: visibility.agent_model,
    agent_model_auto: visibility.agent_model_auto,
    agent_model_source: visibility.agent_model_source,
    runtime_version: '1',
    framework: result.framework || row.agent_tool,
    adapter_version: '1',
  });
  const metrics = {
    candidate_id: row.candidate_id,
    role: row.role,
    status,
    ...fingerprint,
    agent_model_requested: visibility.agent_model_requested,
    duration_minutes: durationMinutes,
    cost_usd: Number(config.actual_cost_usd) || 0,
    tokens_used: 0,
    fault,
    task_complete: status === 'succeeded' ? result.taskComplete !== false : false,
  };

  writeFile(path.join(candDir, 'PATCH.diff'), patch);
  writeFile(path.join(candDir, 'FEEDBACK.md'), [
    `# Feedback: ${row.candidate_id}`,
    '',
    `- Status: \`${status}\`${fault ? ` (fault: \`${fault}\`)` : ''}`,
    `- Role: ${row.role} · tool: \`${row.agent_tool}\` · attempt: ${row.attempt}`,
    reason ? `- Reason: ${reason}` : null,
    '',
    status === 'succeeded'
      ? 'The run completed and its patch is recorded in `PATCH.diff` for judging.'
      : 'The run did not complete successfully. This report and the metrics are retained as evidence — faults are learning data, never dropped.',
    result.output ? '' : null,
    result.output ? '## Output (tail)' : null,
    result.output ? '' : null,
    result.output ? '```\n' + result.output + '\n```' : null,
    '',
  ].filter(l => l !== null).join('\n'));
  writeFile(path.join(candDir, 'METRICS.json'), JSON.stringify(metrics, null, 2) + '\n');

  const features = extractTraceFeatures(session.events(), {
    date: datePart(finished),
    experiment_id: row.experiment_id,
    candidate_id: row.candidate_id,
    startedAtMs: startedAt,
    now: opts.now,
  });
  appendTraceFeatures(workspaceDir, features);

  appendJsonl(path.join(workspaceDir, '_metrics', 'candidate-run-log.jsonl'), {
    date: datePart(finished),
    experiment_id: row.experiment_id,
    task_type: meta.task_type || '',
    tl_spec: meta.tl_spec || '',
    spec_hash: meta.spec_hash || '',
    base_commit: meta.base_commit || '',
    candidate_id: row.candidate_id,
    role: row.role,
    status,
    fault,
    ...fingerprint,
    duration_minutes: durationMinutes,
    cost_usd: metrics.cost_usd,
    tokens_used: metrics.tokens_used,
    patch_path: `_experiments/${row.experiment_id}/candidates/${row.candidate_id}/PATCH.diff`,
    trace_path: `_experiments/${row.experiment_id}/candidates/${row.candidate_id}/TRACE.jsonl`,
  });

  return { status, reason, candidateDir: candDir };
}

module.exports = {
  RUNNERS,
  PROVIDERS,
  hasRunner,
  runCandidate,
  createIsolatedWorkdir,
  removeIsolatedWorkdir,
};

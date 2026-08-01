'use strict';

// Experiment execution trust boundary — the shared environment policy for
// candidate and judge command execution.
//
// The problem this closes (2026-07-17 readiness audit): experiment candidate
// and judge commands used to inherit the FULL parent environment, so every
// spawned process — an arbitrary `config.command`, a provider CLI, a judge
// test command running a candidate's patched code — silently received ambient
// credentials (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*, JIRA_API_TOKEN, GITHUB_*,
// AWS_*, …). A git worktree protects the canonical checkout from edits; it is
// NOT a security sandbox — the spawned process keeps full filesystem read,
// network, and host authority. Environment policy is therefore the one
// boundary tl can enforce everywhere without an OS sandbox, and it follows
// the verifier worker's scrubbing discipline (lib/verifier-worker.js
// scrubEnvironment), widened for experiments:
//
//   1. DEFAULT DENY for secrets. Every spawn starts from a scrubbed copy of
//      the parent environment: variables whose names look credential-shaped
//      (provider prefixes like ANTHROPIC_/OPENAI_/JIRA_, or secret name
//      segments like TOKEN/SECRET/KEY/AUTH/PASSWORD) are dropped. Benign
//      runtime plumbing (PATH, HOME, LANG, TMPDIR, …) passes untouched.
//   2. PER-LANE ALLOWLIST. A provider CLI legitimately needs its OWN auth —
//      the claude lane is useless without CLAUDE_CODE_OAUTH_TOKEN. Each lane
//      names exactly the ambient variables it may receive back
//      (LANE_ENV_ALLOWLIST); a claude candidate never sees OPENAI_API_KEY and
//      a shell candidate sees no ambient credential at all.
//   3. EXPLICIT SCOPED CONFIG. A row may widen the boundary deliberately:
//      `config.pass_env: [names]` passes named ambient variables through, and
//      `config.env: {NAME: value}` sets explicit values (both are recorded
//      queue-side, so the decision is auditable). Names are loggable;
//      values never are.
//   4. VALUES NEVER LAND IN ARTIFACTS. Every value that crosses the boundary
//      (lane allowlist, pass_env, secret-named config.env entries) is
//      registered for redaction, and the runners scrub those exact values out
//      of command output and patches before anything is written to disk.
//
// Unsandboxed host execution (the shell runner, and a judge test command
// running patched candidate code) is additionally gated as an explicit trust
// decision — see hostExecAllowed below. That gate is honest naming: opting in
// means "I trust this command with my host", not "this is sandboxed".
//
// AUTO-INITIATED experiments (EXPERIMENT.md `initiated_by: "policy"` — the
// `experiments.auto_initiate` dial) run UNATTENDED: nobody reviewed the
// specific command or the specific patch, so "I trust this command with my
// host" cannot have been decided by anyone. On that path host execution
// fails closed HERE, at the shared boundary, regardless of row flags or
// drain-wide opt-ins: hostExecAllowed refuses even `config.unsafe_host_exec:
// true` rows, and autoTestCommandAllowed keeps a drain's --test-command from
// running a candidate's patched code unless the workspace explicitly opted
// in with `experiments.auto_initiate_allow_test_command: true`.
//
// Node stdlib only; zero dependencies.

// Provider/org prefixes that mark a variable as credential-scoped. Superset
// of the verifier worker's SECRET_ENV list (ANTHROPIC|CLAUDE|OPENAI|GOOGLE|
// GEMINI|AWS|AZURE|GITHUB|GH|JIRA|SLACK|NPM), extended with the adapter
// lanes' own vendors so no lane's credentials leak into another lane.
const SECRET_ENV_PREFIX = /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|GOOGLE|GEMINI|CURSOR|OPENROUTER|AWS|AZURE|GITHUB|GH|JIRA|SLACK|NPM|VERCEL|HF|HUGGINGFACE)_/i;

// Name segments (underscore-delimited) that mark any variable as a secret,
// whoever the vendor is: MY_APP_TOKEN, DB_PASSWORD, SSH_AUTH_SOCK (an agent
// socket is an ambient credential channel), DEPLOY_KEY, … Segment matching
// keeps false positives low: GIT_AUTHOR_NAME survives (AUTHOR ≠ AUTH).
const SECRET_ENV_SEGMENTS = new Set([
  'TOKEN', 'SECRET', 'SECRETS', 'PASSWORD', 'PASSWD', 'PASSPHRASE',
  'CREDENTIAL', 'CREDENTIALS', 'APIKEY', 'KEY', 'KEYS', 'AUTH',
  'COOKIE', 'SESSION', 'BEARER',
]);

// The per-lane pass-through allowlist: exactly the ambient variables each
// provider CLI needs for its own auth/runtime, nothing else. `shell` is
// deliberately empty — an arbitrary command gets no ambient credential unless
// the row names it via config.pass_env. Unknown lanes get nothing.
const LANE_ENV_ALLOWLIST = Object.freeze({
  claude: Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
  codex: Object.freeze(['OPENAI_API_KEY', 'CODEX_HOME']),
  gemini: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI']),
  cursor: Object.freeze(['CURSOR_API_KEY']),
  shell: Object.freeze([]),
  fixture: Object.freeze([]),
});

// Values shorter than this are never registered for redaction — replacing
// e.g. every "1" in a build log would destroy the artifact, not protect it.
const MIN_REDACTABLE_VALUE_LENGTH = 6;

function isSecretEnvName(name) {
  const n = String(name || '');
  if (SECRET_ENV_PREFIX.test(n)) return true;
  return n.toUpperCase().split(/[^A-Z0-9]+/).some(seg => SECRET_ENV_SEGMENTS.has(seg));
}

// Copy `source` without credential-shaped variables. `keep` (explicit values,
// e.g. a test PATH stub) overlays last and always wins — an explicit value is
// a decision, not ambient inheritance.
function scrubEnvironment(source = process.env, keep = {}) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!isSecretEnvName(key)) out[key] = value;
  }
  return { ...out, ...keep };
}

// Build the environment for one lane's spawn.
// Returns { env, passed, secretValues }:
//   env          the environment to hand spawnSync
//   passed       names (never values) that crossed the boundary from the
//                ambient environment — loggable as-is
//   secretValues values that must never appear in logs/artifacts; the caller
//                runs output and patches through redactSecretValues with them
function buildLaneEnv(lane, opts = {}) {
  const source = opts.source || process.env;
  const configEnv = (opts.configEnv && typeof opts.configEnv === 'object') ? opts.configEnv : {};
  const passEnv = Array.isArray(opts.passEnv) ? opts.passEnv.map(String) : [];
  const allow = LANE_ENV_ALLOWLIST[String(lane || '')] || [];

  const env = scrubEnvironment(source);
  const passed = [];
  const secretValues = [];
  for (const name of [...allow, ...passEnv]) {
    if (source[name] === undefined || passed.includes(name)) continue;
    env[name] = source[name];
    passed.push(name);
    if (String(source[name]).length >= MIN_REDACTABLE_VALUE_LENGTH) secretValues.push(String(source[name]));
  }
  for (const [key, value] of Object.entries(configEnv)) {
    env[key] = value;
    // Explicit config values cross the trust boundary regardless of how the
    // key is named. A credential can be stored under an innocuous name, so
    // key-shape detection is not a safe redaction boundary here.
    if (String(value).length >= MIN_REDACTABLE_VALUE_LENGTH) secretValues.push(String(value));
  }
  return { env, passed, secretValues };
}

// Replace every occurrence of each secret value with `[redacted]` — the disk
// safety net for FEEDBACK.md output tails and PATCH.diff, complementing the
// pattern-based trace redaction in lib/experiment-trace.js.
function redactSecretValues(text, values = []) {
  let s = String(text == null ? '' : text);
  const unique = [...new Set(values.filter(v => String(v).length >= MIN_REDACTABLE_VALUE_LENGTH))]
    .sort((a, b) => b.length - a.length); // longest first so substrings of longer secrets cannot survive
  for (const value of unique) s = s.split(value).join('[redacted]');
  return s;
}

// Provenance test for the auto path: an experiment whose EXPERIMENT.md
// frontmatter carries the literal `initiated_by: "policy"` stamp was queued
// unattended by the auto-initiation dial (lib/worker.js). Absent, or any
// other value, means a human initiated it (manual CLI / UI paths).
function isAutoInitiated(meta) {
  return Boolean(meta) && typeof meta === 'object' && meta.initiated_by === 'policy';
}

// The explicit trust decision for unsandboxed host execution. True only when
// the queue row itself carries `config.unsafe_host_exec: true` (recorded,
// auditable) or the drain was invoked with the opt-in
// (`opts.allowUnsafeHostExec`, CLI `--unsafe-host-exec`). Anything else —
// absent, false, truthy-but-not-true — fails closed.
//
// AUTO-INITIATED rows (opts.meta from the experiment's EXPERIMENT.md,
// `initiated_by: "policy"`) refuse UNCONDITIONALLY: an unattended queue path
// means no human reviewed this specific command as trusted code, so neither
// a row flag nor a drain-wide `--unsafe-host-exec` can stand in for that
// decision. There is deliberately no opt-out dial for this one.
function hostExecAllowed(config = {}, opts = {}) {
  if (isAutoInitiated(opts.meta)) return false;
  return config.unsafe_host_exec === true || opts.allowUnsafeHostExec === true;
}

// May a judge run a LIVE test command (candidate-patched code executing on
// this host) for this experiment? Human-initiated experiments: yes — setting
// --test-command was the explicit trust decision. Auto-initiated experiments
// default to NO (scores come from artifacts/rubric only; tests_pass stays
// null, declared unavailable) unless the workspace's `experiments:` section
// carries the literal `experiments.auto_initiate_allow_test_command: true`.
// Anything else — absent, garbage, truthy-but-not-true — fails closed.
function autoTestCommandAllowed(meta, experimentsConfig = {}) {
  if (!isAutoInitiated(meta)) return true;
  return Boolean(experimentsConfig) && typeof experimentsConfig === 'object'
    && experimentsConfig.auto_initiate_allow_test_command === true;
}

module.exports = {
  SECRET_ENV_PREFIX,
  SECRET_ENV_SEGMENTS,
  LANE_ENV_ALLOWLIST,
  isSecretEnvName,
  scrubEnvironment,
  buildLaneEnv,
  redactSecretValues,
  isAutoInitiated,
  hostExecAllowed,
  autoTestCommandAllowed,
};

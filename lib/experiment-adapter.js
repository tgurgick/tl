// lib/experiment-adapter.js — the experiment adapter interface + TL spec adapter.
//
// One seam between the generic experiment core (task in → candidate artifacts and
// metrics out) and the tools that actually run a task (Claude, Codex, Cursor,
// shell, future runtimes). TL is just one adapter over that core: `tlSpecAdapter`
// turns a TL spec into a generic task; agent adapters advertise capabilities and
// carry a run through prepare → start → collect. This module defines the contract
// and ships two provider-free proofs (a TL task builder, a shell adapter) so the
// interface can be spun out as standalone open-source software later, without the
// private learned-routing layer. Node stdlib only; zero dependencies.

'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------
//
// An agent adapter is a plain object with these methods. The core never reaches
// into a provider SDK directly — it only speaks this interface, so a shell script
// and a hosted agent are interchangeable from the core's point of view.
//
//   prepareTask(task, opts)      -> prepared     : normalize a task for this tool
//   startCandidate(prepared,opts)-> handle        : begin one candidate attempt
//   collectArtifacts(handle,opts)-> artifacts     : gather patch/feedback/metrics/trace
//   cancelCandidate(handle,opts) -> result        : request cancellation
//   fingerprintRuntime(opts)     -> fingerprint   : identify the exact runtime used
//   supportsHeadless(opts)       -> boolean       : can this run without a human/IDE?
//   estimateBudget(task,opts)    -> budget        : rough cost/time envelope
//
// Every method is synchronous-or-promise agnostic here: the interface names the
// shape, not the execution model. Real provider adapters may return promises.

// The seven interface methods every agent adapter must expose. Exported so the
// core (and tests) can assert an adapter is complete before scheduling it.
const ADAPTER_METHODS = [
  'prepareTask',
  'startCandidate',
  'collectArtifacts',
  'cancelCandidate',
  'fingerprintRuntime',
  'supportsHeadless',
  'estimateBudget',
];

// Capability flags an adapter declares up front. These are data, not behavior:
// the core reads them to decide where a candidate can run (headless queue vs.
// an IDE session) without probing the provider.
const CAPABILITY_FIELDS = [
  'headless',        // can run with no human present
  'streams_trace',   // emits observable TRACE.jsonl events during the run
  'reports_model',   // reports the resolved model back (vs. unknown)
  'supports_cancel', // can honor a cancellation request mid-run
  'supports_budget', // accepts/enforces a cost or time budget
  'requires_ide',    // needs an editor/IDE open to run at all
];

// True when `adapter` exposes all seven interface methods as functions.
function isAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') return false;
  return ADAPTER_METHODS.every(m => typeof adapter[m] === 'function');
}

// Normalize an arbitrary capabilities object to the full flag set, coercing to
// boolean and defaulting anything unspecified to false. Never throws.
function normalizeCapabilities(caps) {
  const src = caps && typeof caps === 'object' ? caps : {};
  const out = {};
  for (const field of CAPABILITY_FIELDS) out[field] = Boolean(src[field]);
  return out;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// ---------------------------------------------------------------------------
// The generic task object
// ---------------------------------------------------------------------------
//
// A task is the controlled unit every candidate is judged against. It is
// intentionally tool-agnostic: acceptance criteria, scope, the intent outcome
// that motivates it, the base commit, a content hash of the spec text, and the
// files a candidate is allowed to touch. `spec_hash` + `base_commit` are what
// make a comparison fair — same task text, same source tree, for every candidate.

// Split a SPEC.md body into acceptance criteria, allowed files, and do-not-touch
// entries by scanning its markdown headings + checklist/bullet lines. This is a
// deliberately small extractor over the shape TL specs already use; it never
// throws on a malformed spec, it just returns whatever it could find.
function extractSpecSections(body) {
  const text = String(body || '');
  const lines = text.split('\n');
  const acceptance = [];
  const allowedFiles = [];
  const doNotTouch = [];
  let section = null; // 'acceptance' | 'files' | 'donottouch' | null

  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const h = heading[1].toLowerCase();
      if (/acceptance/.test(h)) section = 'acceptance';
      else if (/do\s*not\s*touch|don'?t\s*touch/.test(h)) section = 'donottouch';
      else if (/files?\s*to\s*touch|allowed\s*files?|scope/.test(h)) section = 'files';
      else section = null;
      continue;
    }
    if (!section) continue;

    // Checklist item: "- [ ] text" or "- [x] text"
    const check = line.match(/^-\s*\[[ xX]\]\s+(.*)$/);
    if (check && section === 'acceptance') { acceptance.push(check[1].trim()); continue; }

    // Plain bullet: "- text" or "* text"
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (!bullet) continue;
    const item = bullet[1].trim();
    if (section === 'acceptance') acceptance.push(item.replace(/^\[[ xX]\]\s*/, '').trim());
    else if (section === 'files') allowedFiles.push(firstBacktick(item) || item);
    else if (section === 'donottouch') doNotTouch.push(firstBacktick(item) || item);
  }

  return { acceptance, allowedFiles, doNotTouch };
}

// Pull the first `backticked` token from a line, if any — TL specs list file
// paths as inline code (e.g. "- `lib/foo.js` — does a thing").
function firstBacktick(s) {
  const m = String(s).match(/`([^`]+)`/);
  return m ? m[1].trim() : null;
}

// Build a generic task object from a TL spec. `spec` is { meta, body } — the
// shape lib/parse.js#parseFrontmatter returns — plus caller-supplied `specPath`
// and `baseCommit`. The result is what any agent adapter consumes; nothing about
// it is TL-specific except the provenance fields under `source`.
function tlSpecToTask(spec, opts = {}) {
  const meta = (spec && spec.meta) || {};
  const body = (spec && spec.body) || '';
  const sections = extractSpecSections(body);
  const specPath = opts.specPath || meta.spec || '';

  return {
    id: opts.taskId || slug(meta.title) || slug(specPath) || 'task',
    title: meta.title || '',
    objective: firstParagraphUnder(body, /objective/i) || '',
    // Why the task matters — sourced from the intent outcome when the caller
    // supplies it; the core treats this as judge context, not a hard gate.
    intent_outcome: opts.intentOutcome || meta.intent || '',
    acceptance_criteria: sections.acceptance,
    scope: {
      allowed_files: sections.allowedFiles,
      do_not_touch: sections.doNotTouch,
    },
    base_commit: opts.baseCommit || 'unknown',
    spec_hash: sha256(body),
    task_type: meta.type || 'feature',
    priority: meta.priority || null,
    source: {
      adapter: 'tl-spec',
      spec_path: specPath,
      intent: meta.intent || '',
    },
  };
}

// A TL spec adapter: the object the core asks to convert TL work into tasks.
// Kept separate from agent adapters — this one is a *source* adapter (task in),
// not a *runner* adapter (candidate out).
const tlSpecAdapter = {
  name: 'tl-spec',
  toTask: tlSpecToTask,
  extractSpecSections,
};

function slug(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Return the first non-empty paragraph following the heading matching `re`.
function firstParagraphUnder(body, re) {
  const lines = String(body || '').split('\n');
  let found = false;
  const para = [];
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (found && para.length) break;
      found = re.test(heading[1]);
      continue;
    }
    if (!found) continue;
    if (!line) { if (para.length) break; else continue; }
    para.push(line);
  }
  return para.join(' ');
}

// ---------------------------------------------------------------------------
// Runtime fingerprint
// ---------------------------------------------------------------------------
//
// Every candidate/judge record carries the same fingerprint so runs are
// comparable and replayable. Mirrors the fields documented in
// docs/agent-experiments.md; unknown fields degrade to safe defaults rather
// than throwing, so a bare adapter still produces a well-shaped record.

const FINGERPRINT_FIELDS = [
  'agent_tool',
  'agent_model',
  'agent_model_auto',
  'agent_model_source',
  'runtime_version',
  'framework',
  'adapter_version',
  'rules_hash',
  'skills_hash',
];

function makeFingerprint(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    agent_tool: str(src.agent_tool, 'unknown'),
    agent_model: str(src.agent_model, 'unknown'),
    agent_model_auto: Boolean(src.agent_model_auto),
    agent_model_source: str(src.agent_model_source, 'unknown'),
    runtime_version: str(src.runtime_version, '0'),
    framework: str(src.framework, 'unknown'),
    adapter_version: str(src.adapter_version, '0'),
    rules_hash: str(src.rules_hash, ''),
    skills_hash: str(src.skills_hash, ''),
  };
}

function str(v, dflt) {
  return v === undefined || v === null ? dflt : String(v);
}

// ---------------------------------------------------------------------------
// Reference adapters (provider-free proofs that the interface is portable)
// ---------------------------------------------------------------------------

// A minimal shell adapter: runs a task as a shell command, with no dependency on
// any Claude/Cursor/Codex API. It proves the interface is not tied to a provider.
// `startCandidate`/`collectArtifacts` here describe the shape a real runner fills
// in; the fixture keeps them side-effect-free so the contract can be tested
// without spawning processes.
function createShellAdapter(config = {}) {
  const capabilities = normalizeCapabilities({
    headless: true,
    streams_trace: true,
    reports_model: false, // a shell command has no "model"
    supports_cancel: true,
    supports_budget: false,
    requires_ide: false,
    ...config.capabilities,
  });

  return {
    name: config.name || 'shell',
    capabilities,

    prepareTask(task) {
      return {
        task,
        command: config.command || 'true',
        env: config.env || {},
      };
    },

    startCandidate(prepared, opts = {}) {
      return {
        adapter: 'shell',
        candidate_id: opts.candidateId || 'shell-candidate',
        command: prepared.command,
        status: 'queued',
      };
    },

    collectArtifacts(handle) {
      return {
        candidate_id: handle.candidate_id,
        patch: '',
        feedback: '',
        metrics: makeFingerprint({
          agent_tool: 'shell',
          framework: 'shell',
          adapter_version: '1',
          agent_model_source: 'none',
        }),
        trace: [],
      };
    },

    cancelCandidate(handle) {
      return { candidate_id: handle.candidate_id, status: 'cancelled' };
    },

    fingerprintRuntime(opts = {}) {
      return makeFingerprint({
        agent_tool: 'shell',
        agent_model: 'none',
        agent_model_source: 'none',
        framework: 'shell',
        adapter_version: '1',
        ...opts,
      });
    },

    supportsHeadless() {
      return capabilities.headless;
    },

    estimateBudget() {
      return { cost_usd: 0, duration_minutes: 0, tokens: 0 };
    },
  };
}

// A Cursor-shaped capability descriptor. Cursor's IDE chat mode requires the
// editor open (not headless); its SDK/cloud worker mode can be headless when
// configured. This is encoded as *data* so the core routes candidates correctly
// without any Cursor API — it's the canonical example of a capability that varies
// by mode. `mode` is 'ide' (default) or 'cloud'.
function cursorCapabilities(mode = 'ide') {
  const cloud = mode === 'cloud';
  return normalizeCapabilities({
    headless: cloud,          // IDE chat needs Cursor open; cloud worker can be headless
    streams_trace: true,
    reports_model: true,
    supports_cancel: true,
    supports_budget: cloud,
    requires_ide: !cloud,     // IDE mode requires the editor; cloud does not
  });
}

// ---------------------------------------------------------------------------
// Policy seam — private learned routing lives OUTSIDE the core
// ---------------------------------------------------------------------------
//
// Shipping write/select for `routing-priors.jsonl` lives in
// `lib/experiment-policy.js` (SCHEMA row shape). This factory is the portable
// `{ name, choose, record }` adapter seam: it delegates to that policy so the
// open core never invents a second prior-row shape. A future private/hosted
// model implements the same tiny interface and swaps in without the core
// depending on it.
//
// Lazy-require of experiment-policy avoids a load-time cycle (that module
// imports ROUTING_PRIORS_FILE / extractSpecSections from here).

const ROUTING_PRIORS_FILE = 'routing-priors.jsonl';

function createLocalRoutingPolicy(options = {}) {
  function policy() {
    return require('./experiment-policy');
  }

  return {
    name: 'local-priors',
    priorsFile: options.priorsFile || ROUTING_PRIORS_FILE,

    // SCHEMA-correct `routing-priors.jsonl` row — same fields as experiment-policy.
    formatPriorRow(row = {}) {
      const now = row.last_updated || new Date().toISOString();
      const model = row.agent_model;
      return {
        date: row.date || String(now).slice(0, 10),
        context_key: str(row.context_key, ''),
        agent_tool: str(row.agent_tool, ''),
        agent_model: model == null || model === '' ? null : String(model),
        runtime_fingerprint: str(row.runtime_fingerprint, ''),
        expected_quality: typeof row.expected_quality === 'number' ? row.expected_quality : 0,
        expected_cost: typeof row.expected_cost === 'number' ? row.expected_cost : 0,
        expected_latency: typeof row.expected_latency === 'number' ? row.expected_latency : 0,
        success_rate: typeof row.success_rate === 'number' ? row.success_rate : 0,
        samples: typeof row.samples === 'number' ? row.samples : 0,
        last_updated: now,
        source: str(row.source, ''),
      };
    },

    // Delegate primary selection to the shipping transparent policy.
    choose(candidates, priors = [], opts = {}) {
      if (!Array.isArray(candidates) || candidates.length === 0) return null;
      const { selectPrimary } = policy();
      const result = selectPrimary(candidates, {
        priors: Array.isArray(priors) ? priors : [],
        ...options,
        ...opts,
      });
      const c = result && result.candidate;
      if (!c) return null;
      // String-in → string-out (lane name) when callers pass bare tool ids.
      if (typeof candidates[0] === 'string') {
        return c.agent_tool || c.id || null;
      }
      return c;
    },

    // Fold judged experiment logs into append-only routing-priors.jsonl.
    record(workspaceDir, opts = {}) {
      const { updatePriorsFromLogs } = policy();
      return updatePriorsFromLogs(workspaceDir, opts);
    },
  };
}

module.exports = {
  ADAPTER_METHODS,
  CAPABILITY_FIELDS,
  FINGERPRINT_FIELDS,
  ROUTING_PRIORS_FILE,
  isAdapter,
  normalizeCapabilities,
  extractSpecSections,
  tlSpecToTask,
  tlSpecAdapter,
  makeFingerprint,
  createShellAdapter,
  cursorCapabilities,
  createLocalRoutingPolicy,
};

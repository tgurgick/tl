// lib/automation.js — the `automation:` profile behind `tl open`.
//
// One TRIAGE.yml section replaces N hand-written crons: read the profile,
// generate a SINGLE per-workspace schedule artifact (one launchd plist for
// macOS, one cron line for everywhere else) that ticks each listed lane via
// the existing bin/tl-worker.js, and summarize the whole thing for humans and
// the cockpit. Print-for-paste is a first-class outcome — agent-side installs
// can hang on macOS permission prompts, so every generator here returns the
// complete paste-able text and the CLI decides whether to also install it.
//
// Deliberately thin: no daemon, no new binary. The schedule calls binaries
// that already exist (`tl-worker` for lane ticks and for the isolated verify
// tick when automation.verify is true). This module never runs `crontab` or
// `launchctl` itself; the install seam is injected so tests exercise
// generation, never installation. Node stdlib only; zero dependencies.

'use strict';

const fs = require('fs');
const path = require('path');

const {
  laneConfig, validLaneName, readWorkspaceSpecs, verifierLaneIssues, readVerifierLanes,
} = require('./worker');
const { safeRead } = require('./workspace');

const DEFAULT_INTERVAL_MINUTES = 15;

// Supported `automation.experiment` dial values. `off` (and absent) are fully
// inert. `drain` schedules existing `tl experiment drain` ticks for each
// automation lane — never queue-as-default, never winner apply/select.
const EXPERIMENT_MODES = Object.freeze(['off', 'drain']);

// ---------- reading the profile (TRIAGE.yml `automation:`) ----------

// Normalize the parsed TRIAGE.yml `automation:` section. Same fallback-on-
// garbage posture as calmCap: a missing section is inert ({ configured:
// false }), `enabled`/`verify` must be literal true, the interval must be a
// positive integer (else the default), lanes must be an array of strings.
// Unknown keys are ignored here and preserved in the file (parsers must
// preserve unknown fields — SCHEMA.md).
//
// `experiment` is lowercased/trimmed; unsupported strings are kept verbatim
// so laneIssues can fail loudly when the profile is enabled — never silently
// execute a guessed mode.
function readAutomation(cfg) {
  const a = cfg && cfg.automation;
  const configured = !!a && typeof a === 'object' && !Array.isArray(a);
  const src = configured ? a : {};
  const n = Number(src.interval_minutes);
  const lanes = Array.isArray(src.lanes)
    ? src.lanes.map(l => String(l == null ? '' : l).trim().toLowerCase()).filter(Boolean)
    : [];
  const experiment = String(src.experiment == null ? 'off' : src.experiment).trim().toLowerCase() || 'off';
  return {
    configured,
    enabled: src.enabled === true,
    intervalMinutes: Number.isInteger(n) && n > 0 ? n : DEFAULT_INTERVAL_MINUTES,
    lanes,
    verify: src.verify === true,
    experiment,
  };
}

// The loud-failure check: every automation lane must be a valid lane name AND
// already have lanes.<name>.command in the same TRIAGE.yml. Returns an array
// of { lane, problem, hint } — empty means the profile is installable. An
// enabled profile with no lanes at all is also a problem (a schedule that
// ticks nothing is the quiet cousin of silent-green).
function laneIssues(automation, cfg) {
  const issues = [];
  if (!automation.enabled) return issues;
  // Empty lanes with only `off` experiment and no verify = a schedule that
  // ticks nothing. When experiment is `drain` (or invalid), fall through so
  // the experiment-specific checks below can speak first.
  if (!automation.lanes.length && !automation.verify && automation.experiment === 'off') {
    issues.push({
      lane: null,
      problem: 'automation.enabled is true but automation.lanes is empty (and verify is off)',
      hint: 'list at least one lane, e.g. lanes: [claude] — each needs a lanes.<name>.command',
    });
    return issues;
  }
  for (const lane of automation.lanes) {
    if (!validLaneName(lane)) {
      issues.push({
        lane,
        problem: `"${lane}" is not a valid lane name`,
        hint: 'use lowercase letters, numbers, dots, underscores, or hyphens',
      });
      continue;
    }
    if (!laneConfig(cfg, lane)) {
      issues.push({
        lane,
        problem: `automation.lanes lists "${lane}" but lanes.${lane}.command is missing`,
        hint: `add lanes.${lane}.command to TRIAGE.yml (see docs/headless-lanes.md for per-agent shapes)`,
      });
    }
  }
  if (automation.verify) {
    const vLanes = readVerifierLanes(cfg);
    if (!vLanes.length) {
      issues.push({
        lane: null,
        problem: 'automation.verify is true but verification.verifier_lanes is empty',
        hint: 'add verification.verifier_lanes.<name> with isolated: true, sandbox: required (see docs/headless-lanes.md)',
      });
    }
    for (const issue of verifierLaneIssues(cfg)) issues.push(issue);
  }
  if (!EXPERIMENT_MODES.includes(automation.experiment)) {
    issues.push({
      lane: null,
      problem: `automation.experiment "${automation.experiment}" is not a supported value`,
      hint: `use one of: ${EXPERIMENT_MODES.join(', ')} — off is inert; drain schedules tl experiment drain per automation lane (never applies winners)`,
    });
  } else if (automation.experiment === 'drain' && !automation.lanes.length) {
    issues.push({
      lane: null,
      problem: 'automation.experiment is "drain" but automation.lanes is empty',
      hint: 'list at least one lane to drain, e.g. lanes: [claude] — each drain tick runs: tl experiment drain --agent <lane>',
    });
  }
  return issues;
}

// ---------- schedule generation (pure — never installs) ----------

// The individual tick commands, in order: one tl-worker tick per lane, then
// the optional isolated verify tick, then optional experiment-drain ticks.
// When automation.verify is true the schedule invokes `tl-worker --mode verify`,
// which claims at most one awaiting-verifier spec through a configured
// verifier lane. When automation.experiment is `drain`, one
// `tl experiment drain --agent <lane>` tick is appended per automation lane —
// the existing queue/drain path (folds UI request configs + drains that lane's
// queued candidates). Never schedules select/apply/reject.
function tickCommands({ root, wsName, automation, nodeBin = process.execPath }) {
  const node = `'${nodeBin}'`;
  const cmds = [];
  for (const lane of automation.lanes) {
    cmds.push({ kind: 'lane', lane, command: `${node} bin/tl-worker.js ${wsName} --agent ${lane}` });
  }
  if (automation.verify) {
    cmds.push({
      kind: 'verify',
      lane: null,
      command: `${node} bin/tl-worker.js ${wsName} --mode verify`,
    });
  }
  if (automation.experiment === 'drain') {
    for (const lane of automation.lanes) {
      cmds.push({
        kind: 'experiment-drain',
        lane,
        command: `${node} bin/tl.js experiment drain --agent ${lane} ${wsName}`,
      });
    }
  }
  return cmds;
}

// Human-readable schedule line for status / `tl up` — states exactly what the
// experiment dial will run (or that it is inert). Never implies winner apply.
function experimentScheduleSummary(automation) {
  if (!automation || automation.experiment === 'off') {
    return 'experiment: off (inert — no experiment queue/drain ticks)';
  }
  if (automation.experiment === 'drain') {
    const lanes = automation.lanes.length ? automation.lanes.join(', ') : '(none)';
    return `experiment: drain — schedules tl experiment drain --agent <lane> for lanes: ${lanes} (folds pending queue requests; never selects or applies winners)`;
  }
  return `experiment: ${automation.experiment} (unsupported — fix TRIAGE.yml; nothing scheduled)`;
}

function logPathFor(wsName) {
  return `/tmp/tl-open-${wsName}.log`;
}

// The single chained shell body both artifacts share: sequential ticks —
// calm over swarm, and the per-lane locks already prevent overlap. `;` (not
// `&&`) so a paused lane (exit 2) never silences the lanes after it.
function shellBody({ root, wsName, automation, nodeBin }) {
  const cmds = tickCommands({ root, wsName, automation, nodeBin });
  return cmds.map(c => c.command).join('; ');
}

// The cron half of print-for-paste: comment header + one schedule line.
// Intervals under an hour use */N minutes; 60+ rounds to whole hours.
function cronSchedule(minutes) {
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return `0 */${hours} * * *`;
}

function generateCron({ root, wsName, automation, nodeBin = process.execPath }) {
  const log = logPathFor(wsName);
  const body = shellBody({ root, wsName, automation, nodeBin });
  const extras = [
    automation.verify ? ' + isolated verify tick' : '',
    automation.experiment === 'drain' ? ' + experiment drain per lane' : '',
  ].join('');
  const lines = [
    `# tl open — one schedule for workspace "${wsName}" (every ${automation.intervalMinutes}m): lanes ${automation.lanes.join(', ') || '(none)'}${extras}`,
    `# paste into \`crontab -e\` yourself — tl never runs crontab for you`,
    `${cronSchedule(automation.intervalMinutes)} cd '${root}' && { ${body}; } >> ${log} 2>&1`,
  ];
  return lines.join('\n');
}

// The launchd half: one plist per WORKSPACE (not per lane) — the "single
// per-workspace schedule". /bin/sh -c runs the same chained tick body.
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateLaunchd({ root, wsName, automation, nodeBin = process.execPath, home = process.env.HOME || '' }) {
  const label = `com.tl.open.${wsName}`;
  const log = logPathFor(wsName);
  const body = shellBody({ root, wsName, automation, nodeBin });
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-c</string>',
    `    <string>${xmlEscape(body)}</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>`,
    `  <key>StartInterval</key><integer>${automation.intervalMinutes * 60}</integer>`,
    `  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return {
    label,
    path: path.join(home, 'Library', 'LaunchAgents', label + '.plist'),
    content,
  };
}

// Everything `tl open` needs in one call: the tick list, both paste-able
// artifacts, and the log path. Pure — reads config, writes nothing.
function scheduleArtifacts({ root, wsName, automation, nodeBin = process.execPath, home = process.env.HOME || '' }) {
  return {
    commands: tickCommands({ root, wsName, automation, nodeBin }),
    cron: generateCron({ root, wsName, automation, nodeBin }),
    plist: generateLaunchd({ root, wsName, automation, nodeBin, home }),
    logPath: logPathFor(wsName),
  };
}

// ---------- the real install path (seams injected; verified via --dry-run) ----------

// Write the plist and (re)load it. `writeFile` and `exec` are injectable so
// tests never touch ~/Library or launchctl — a launchctl call can hang on a
// macOS TCC prompt, so tests exercise generation only and humans verify the
// install path via `tl open` in their own terminal (or paste from
// --print-schedule). Returns { written, loaded, error }.
function installLaunchd(plist, {
  writeFile = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); },
  exec = null,  // (cmd, args) => void; throws on failure. Required to actually load.
} = {}) {
  const result = { written: false, loaded: false, error: null };
  try {
    writeFile(plist.path, plist.content);
    result.written = true;
  } catch (e) {
    result.error = 'could not write ' + plist.path + ' — ' + (e && e.message ? e.message : e);
    return result;
  }
  if (!exec) return result;  // write-only install: caller prints the load line for paste
  try { exec('launchctl', ['unload', plist.path]); } catch { /* not loaded yet — fine */ }
  try {
    exec('launchctl', ['load', plist.path]);
    result.loaded = true;
  } catch (e) {
    result.error = 'launchctl load failed — ' + (e && e.message ? e.message : e) +
      `. Load it yourself: launchctl load ${plist.path}`;
  }
  return result;
}

// ---------- status (read-only; feeds `tl open` output and the cockpit chip) ----------

// One summary object answering "is automation running for this workspace?":
//   state: off | misconfigured | paused | installed | not-installed
// plus the inputs a human needs to fix whatever the state is. `stuckAtTests`
// counts specs sitting at the tests gate (awaiting_verifier or blocked).
function automationStatus({ wsDir, wsName, root, cfg, nodeBin = process.execPath, home = process.env.HOME || '' }) {
  const automation = readAutomation(cfg);
  const issues = laneIssues(automation, cfg);
  const paused = fs.existsSync(path.join(wsDir, 'PAUSE'));

  const lanes = automation.lanes.map(lane => ({
    name: lane,
    configured: !!laneConfig(cfg, lane) && validLaneName(lane),
  }));

  let specs = [];
  try { specs = readWorkspaceSpecs(wsDir); } catch { /* unreadable workspace — counts stay 0 */ }
  const stuckAtTests = specs.filter(s =>
    s.stage === 'tests' &&
    (s.meta.awaiting_verifier === true || String(s.meta.status || '').toLowerCase() === 'blocked')).length;

  // Installed = the plist on disk matches what we would generate now.
  let installed = 'absent';
  if (automation.enabled && !issues.length) {
    const plist = generateLaunchd({ root, wsName, automation, nodeBin, home });
    const onDisk = safeRead(plist.path);
    if (onDisk !== null) installed = onDisk === plist.content ? 'current' : 'stale';
  }

  let state;
  if (!automation.configured || !automation.enabled) state = 'off';
  else if (issues.length) state = 'misconfigured';
  else if (paused) state = 'paused';
  else state = installed === 'current' ? 'installed' : 'not-installed';

  // Cockpit chip vocabulary (AC): up / paused / misconfigured (+ stuck-at-tests count).
  // `installed` → `up`; off/not-installed stay as themselves for the Human desk.
  const signal = state === 'installed' ? 'up' : state;

  return { state, signal, automation, issues, paused, lanes, stuckAtTests, installed };
}

module.exports = {
  DEFAULT_INTERVAL_MINUTES,
  EXPERIMENT_MODES,
  readAutomation, laneIssues,
  tickCommands, shellBody, cronSchedule, logPathFor,
  experimentScheduleSummary,
  generateCron, generateLaunchd, scheduleArtifacts,
  installLaunchd,
  automationStatus,
};

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const {
  readAutomation, laneIssues, tickCommands, scheduleArtifacts,
  installLaunchd, automationStatus, DEFAULT_INTERVAL_MINUTES,
  EXPERIMENT_MODES, experimentScheduleSummary,
} = require('../lib/automation');

test('readAutomation: absent section is inert (configured false, enabled false)', () => {
  const a = readAutomation({});
  assert.equal(a.configured, false);
  assert.equal(a.enabled, false);
  assert.equal(a.intervalMinutes, DEFAULT_INTERVAL_MINUTES);
  assert.deepEqual(a.lanes, []);
  assert.equal(a.verify, false);
  assert.equal(a.experiment, 'off');
});

test('readAutomation: enabled must be literal true; garbage interval falls back', () => {
  assert.equal(readAutomation({ automation: { enabled: 'true', interval_minutes: 30 } }).enabled, false);
  assert.equal(readAutomation({ automation: { enabled: true, interval_minutes: 0 } }).intervalMinutes, DEFAULT_INTERVAL_MINUTES);
  assert.equal(readAutomation({ automation: { enabled: true, interval_minutes: 20 } }).intervalMinutes, 20);
  assert.equal(readAutomation({ automation: { enabled: true, verify: true, experiment: 'drain' } }).verify, true);
  assert.equal(readAutomation({ automation: { enabled: true, experiment: 'DRAIN' } }).experiment, 'drain');
});

test('readAutomation: experiment absent / blank → off; supported modes documented', () => {
  assert.equal(readAutomation({ automation: { enabled: true } }).experiment, 'off');
  assert.equal(readAutomation({ automation: { enabled: true, experiment: '  ' } }).experiment, 'off');
  assert.deepEqual(EXPERIMENT_MODES.slice(), ['off', 'drain']);
});

test('laneIssues: missing lanes.<name>.command fails loudly with a fix hint', () => {
  const automation = readAutomation({
    automation: { enabled: true, lanes: ['claude'] },
  });
  const issues = laneIssues(automation, { automation: { enabled: true, lanes: ['claude'] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].problem, /claude/);
  assert.match(issues[0].hint, /lanes\.claude\.command/);
});

test('laneIssues: configured lane with command is clean', () => {
  const cfg = {
    lanes: { claude: { command: 'claude -p {prompt_file}' } },
    automation: { enabled: true, lanes: ['claude'] },
  };
  assert.deepEqual(laneIssues(readAutomation(cfg), cfg), []);
});

test('laneIssues: disabled automation never surfaces issues', () => {
  const cfg = { automation: { enabled: false, lanes: ['missing'] } };
  assert.deepEqual(laneIssues(readAutomation(cfg), cfg), []);
});

test('scheduleArtifacts: one per-workspace body ticks listed lanes (+ optional verify)', () => {
  const automation = readAutomation({
    automation: { enabled: true, interval_minutes: 10, lanes: ['claude'], verify: true },
  });
  const art = scheduleArtifacts({
    root: ROOT, wsName: 'demo', automation, nodeBin: '/usr/bin/node', home: '/tmp/home',
  });
  assert.equal(art.commands.length, 2);
  assert.equal(art.commands[0].kind, 'lane');
  assert.match(art.commands[0].command, /tl-worker\.js demo --agent claude/);
  assert.equal(art.commands[1].kind, 'verify');
  assert.match(art.commands[1].command, /tl-worker\.js demo --mode verify/);
  assert.match(art.cron, /\*\/10 \* \* \* \*/);
  assert.match(art.cron, /tl-worker\.js demo --agent claude/);
  assert.equal(art.plist.label, 'com.tl.open.demo');
  assert.equal(art.plist.path, path.join('/tmp/home', 'Library', 'LaunchAgents', 'com.tl.open.demo.plist'));
  assert.match(art.plist.content, /StartInterval<\/key><integer>600<\/integer>/);
  assert.match(art.plist.content, /WorkingDirectory<\/key><string>/);
});

test('installLaunchd: uses injected write/exec — never touches real launchctl in tests', () => {
  const written = [];
  const execs = [];
  const plist = {
    path: '/tmp/fake/com.tl.open.x.plist',
    content: '<plist/>\n',
  };
  const res = installLaunchd(plist, {
    writeFile: (p, c) => written.push({ p, c }),
    exec: (c, a) => execs.push({ c, a }),
  });
  assert.equal(res.written, true);
  assert.equal(res.loaded, true);
  assert.equal(res.error, null);
  assert.equal(written[0].p, plist.path);
  assert.equal(execs[0].c, 'launchctl');
  assert.deepEqual(execs[0].a, ['unload', plist.path]);
  assert.deepEqual(execs[1].a, ['load', plist.path]);
});

test('automationStatus: absent = off; PAUSE → paused; stuck-at-tests counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-auto-'));
  const home = path.join(dir, 'home');
  try {
    fs.mkdirSync(path.join(dir, 'tests', 'stuck'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'stuck', 'SPEC.md'),
      '---\ntitle: stuck\nstatus: tests\nawaiting_verifier: true\n---\n\n## Objective\nx\n');
    fs.writeFileSync(path.join(dir, 'TRIAGE.yml'), 'goals: []\n');

    let st = automationStatus({
      wsDir: dir, wsName: 'w', root: ROOT, cfg: {}, home,
    });
    assert.equal(st.state, 'off');
    assert.equal(st.signal, 'off');
    assert.equal(st.stuckAtTests, 1);

    const cfg = {
      lanes: { claude: { command: 'claude -p {prompt_file}' } },
      automation: { enabled: true, lanes: ['claude'] },
    };
    fs.writeFileSync(path.join(dir, 'PAUSE'), '');
    st = automationStatus({ wsDir: dir, wsName: 'w', root: ROOT, cfg, home });
    assert.equal(st.state, 'paused');
    assert.equal(st.signal, 'paused');
    assert.equal(st.paused, true);

    fs.unlinkSync(path.join(dir, 'PAUSE'));
    st = automationStatus({ wsDir: dir, wsName: 'w', root: ROOT, cfg, home });
    assert.equal(st.state, 'not-installed');
    assert.equal(st.signal, 'not-installed');

    // write the generated plist → installed / up
    const art = scheduleArtifacts({ root: ROOT, wsName: 'w', automation: readAutomation(cfg), home });
    fs.mkdirSync(path.dirname(art.plist.path), { recursive: true });
    fs.writeFileSync(art.plist.path, art.plist.content);
    st = automationStatus({ wsDir: dir, wsName: 'w', root: ROOT, cfg, home });
    assert.equal(st.state, 'installed');
    assert.equal(st.signal, 'up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tickCommands: verify off omits the isolated verify tick', () => {
  const automation = readAutomation({ automation: { enabled: true, lanes: ['a'], verify: false } });
  const cmds = tickCommands({ root: ROOT, wsName: 'w', automation, nodeBin: 'node' });
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].kind, 'lane');
});

test('tickCommands: experiment off / absent adds no experiment ticks', () => {
  const off = readAutomation({ automation: { enabled: true, lanes: ['claude'], experiment: 'off' } });
  const absent = readAutomation({ automation: { enabled: true, lanes: ['claude'] } });
  for (const automation of [off, absent]) {
    const cmds = tickCommands({ root: ROOT, wsName: 'w', automation, nodeBin: 'node' });
    assert.ok(cmds.every(c => c.kind !== 'experiment-drain'));
    assert.ok(!cmds.some(c => /experiment/.test(c.command)));
    assert.match(experimentScheduleSummary(automation), /inert/i);
  }
});

test('tickCommands: experiment drain schedules per-lane tl experiment drain (never apply/select)', () => {
  const automation = readAutomation({
    automation: { enabled: true, lanes: ['claude', 'codex'], verify: true, experiment: 'drain' },
  });
  const cmds = tickCommands({ root: ROOT, wsName: 'demo', automation, nodeBin: '/usr/bin/node' });
  assert.equal(cmds.map(c => c.kind).join(','), 'lane,lane,verify,experiment-drain,experiment-drain');
  const drains = cmds.filter(c => c.kind === 'experiment-drain');
  assert.equal(drains.length, 2);
  assert.match(drains[0].command, /bin\/tl\.js experiment drain --agent claude demo/);
  assert.match(drains[1].command, /bin\/tl\.js experiment drain --agent codex demo/);
  const joined = cmds.map(c => c.command).join('\n');
  assert.doesNotMatch(joined, /experiment (apply|select|reject|send-to-review)/);
  assert.match(experimentScheduleSummary(automation), /drain --agent/);
  assert.match(experimentScheduleSummary(automation), /never selects or applies winners/);

  const art = scheduleArtifacts({
    root: ROOT, wsName: 'demo', automation, nodeBin: '/usr/bin/node', home: '/tmp/home',
  });
  assert.match(art.cron, /experiment drain/);
  assert.match(art.cron, /experiment drain per lane/);
  assert.doesNotMatch(art.cron, /experiment (apply|select)/);
});

test('laneIssues: invalid experiment value fails loudly (never silently executes)', () => {
  const cfg = {
    lanes: { claude: { command: 'claude -p {prompt_file}' } },
    automation: { enabled: true, lanes: ['claude'], experiment: 'shadow' },
  };
  const issues = laneIssues(readAutomation(cfg), cfg);
  assert.ok(issues.some(i => /not a supported value/.test(i.problem)));
  assert.ok(issues.some(i => /off, drain/.test(i.hint)));
  // And tickCommands must not invent a mode for unsupported values
  const cmds = tickCommands({ root: ROOT, wsName: 'w', automation: readAutomation(cfg), nodeBin: 'node' });
  assert.ok(!cmds.some(c => c.kind === 'experiment-drain'));
});

test('laneIssues: experiment drain with empty lanes fails loudly', () => {
  const cfg = {
    automation: { enabled: true, lanes: [], verify: true, experiment: 'drain' },
    verification: {
      verifier_lanes: {
        gemini: {
          agent: 'gemini', isolated: true, sandbox: 'required',
          allow_network: false, command: ['agy'],
        },
      },
    },
  };
  const issues = laneIssues(readAutomation(cfg), cfg);
  assert.ok(issues.some(i => /experiment is "drain" but automation\.lanes is empty/.test(i.problem)));
});

test('automation module never wires winner application', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'automation.js'), 'utf8');
  assert.doesNotMatch(src, /experiment-apply/);
  assert.doesNotMatch(src, /applyWinner|selectWinner/);
});

test('laneIssues: verify:true without verifier_lanes fails loudly', () => {
  const cfg = {
    lanes: { claude: { command: 'claude -p {prompt_file}' } },
    automation: { enabled: true, lanes: ['claude'], verify: true },
  };
  const issues = laneIssues(readAutomation(cfg), cfg);
  assert.ok(issues.some(i => /verifier_lanes/.test(i.problem)));
});

test('laneIssues: unsafe Gemini verifier lane is rejected', () => {
  const cfg = {
    lanes: { claude: { command: 'claude -p {prompt_file}' } },
    automation: { enabled: true, lanes: ['claude'], verify: true },
    verification: {
      verifier_lanes: {
        gemini: {
          agent: 'gemini', isolated: true, sandbox: 'required',
          allow_network: true, command: ['agy'],
        },
      },
    },
  };
  const issues = laneIssues(readAutomation(cfg), cfg);
  assert.ok(issues.some(i => /allow_network/.test(i.problem)));
});

test('installLaunchd: a failed load reports the error plus the paste-it-yourself line', () => {
  const res = installLaunchd({ path: '/p.plist', content: 'x' }, {
    writeFile: () => {},
    exec: (cmd, args) => { if (args[0] === 'load') throw new Error('TCC denied'); },
  });
  assert.equal(res.written, true);
  assert.equal(res.loaded, false);
  assert.match(res.error, /TCC denied/);
  assert.match(res.error, /launchctl load \/p\.plist/);
});

test('installLaunchd: no exec seam = write-only install (caller prints the load line)', () => {
  let wrote = null;
  const res = installLaunchd({ path: '/p.plist', content: 'x' }, { writeFile: p => { wrote = p; } });
  assert.deepEqual(res, { written: true, loaded: false, error: null });
  assert.equal(wrote, '/p.plist');
});

test('scheduleArtifacts: exactly one non-comment cron line; ; separators so a paused lane never silences the next', () => {
  const automation = readAutomation({ automation: { enabled: true, interval_minutes: 15, lanes: ['a', 'b'] } });
  const art = scheduleArtifacts({ root: '/r', wsName: 'w', automation, nodeBin: 'node', home: '/h' });
  const scheduleLines = art.cron.split('\n').filter(l => !l.startsWith('#'));
  assert.equal(scheduleLines.length, 1);
  assert.match(scheduleLines[0], /--agent a; 'node' bin\/tl-worker\.js w --agent b/);
  assert.ok(!scheduleLines[0].includes('&&') || scheduleLines[0].indexOf('&&') === scheduleLines[0].lastIndexOf('&&'));  // only the cd guard
  assert.match(scheduleLines[0], / >> \/tmp\/tl-open-w\.log 2>&1$/);
});

test('scheduleArtifacts: 60+ minute intervals become whole cron hours; plist keeps exact seconds', () => {
  const automation = readAutomation({ automation: { enabled: true, interval_minutes: 90, lanes: ['a'] } });
  const art = scheduleArtifacts({ root: '/r', wsName: 'w', automation, nodeBin: 'node', home: '/h' });
  assert.match(art.cron, /^0 \*\/2 \* \* \* /m);
  assert.match(art.plist.content, /StartInterval<\/key><integer>5400<\/integer>/);
});

test('generateLaunchd-via-artifacts: XML-escapes & in paths so the plist stays parseable', () => {
  const automation = readAutomation({ automation: { enabled: true, lanes: ['a'] } });
  const art = scheduleArtifacts({ root: '/repo & co', wsName: 'w', automation, nodeBin: 'node', home: '/h' });
  assert.match(art.plist.content, /<key>WorkingDirectory<\/key><string>\/repo &amp; co<\/string>/);
  assert.ok(!/<string>[^<]*&(?!amp;|lt;|gt;)/.test(art.plist.content));
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  SPEC_TYPES, MAP_TARGETS, DEFAULT_TYPE_MAP,
  normalizeTypeKey, normalizeTypeMap, classifyIssueType, configHint,
} = require('../lib/sync-map');
const { parseYaml } = require('../lib/parse');

// ---- backward compatibility: the original fixed four-type contract ----

test('absent map yields exactly the shipped defaults', () => {
  for (const raw of [undefined, null, {}]) {
    const { map, errors } = normalizeTypeMap(raw);
    assert.deepEqual(errors, []);
    assert.deepEqual(classifyIssueType('Epic', map), { action: 'intent' });
    assert.deepEqual(classifyIssueType('Story', map), { action: 'spec', type: 'feature', tags: [] });
    assert.deepEqual(classifyIssueType('Task', map), { action: 'spec', type: 'feature', tags: [] });
    assert.deepEqual(classifyIssueType('Bug', map), { action: 'spec', type: 'bug', tags: [] });
  }
});

test('the literal legacy TRIAGE.yml block still means what it always did', () => {
  const raw = { epic: 'intent', story: 'spec', task: 'spec', bug: 'spec' };
  const { map, errors } = normalizeTypeMap(raw);
  assert.deepEqual(errors, []);
  assert.equal(classifyIssueType('Epic', map).action, 'intent');
  assert.equal(classifyIssueType('Story', map).type, 'feature');
  // scalar `bug: spec` keeps the default TL type hint for the bug key
  assert.equal(classifyIssueType('Bug', map).type, 'bug');
});

test('custom keys extend the defaults without erasing them', () => {
  const { map, errors } = normalizeTypeMap({ spike: 'spec' });
  assert.deepEqual(errors, []);
  assert.equal(classifyIssueType('Epic', map).action, 'intent');   // default preserved
  assert.equal(classifyIssueType('Bug', map).type, 'bug');         // default preserved
  assert.deepEqual(classifyIssueType('Spike', map), { action: 'spec', type: 'feature', tags: [] });
});

// ---- custom types: Spike / Sub-task / Incident ----

test('Spike → spec with a research type hint and tag', () => {
  const { map, errors } = normalizeTypeMap({ spike: { to: 'spec', type: 'research', tags: ['spike'] } });
  assert.deepEqual(errors, []);
  assert.deepEqual(classifyIssueType('Spike', map), { action: 'spec', type: 'research', tags: ['spike'] });
});

test('Sub-task → explicit ignore is honored, not reported as unmapped', () => {
  const { map, errors } = normalizeTypeMap({ 'sub-task': 'ignore' });
  assert.deepEqual(errors, []);
  assert.deepEqual(classifyIssueType('Sub-task', map), { action: 'ignore' });
});

test('Incident → scalar spec mapping defaults the TL type to feature', () => {
  const { map } = normalizeTypeMap({ incident: 'spec' });
  assert.deepEqual(classifyIssueType('Incident', map), { action: 'spec', type: 'feature', tags: [] });
});

test('Incident → block form can hint type bug', () => {
  const { map } = normalizeTypeMap({ incident: { to: 'spec', type: 'bug', tags: ['incident'] } });
  assert.deepEqual(classifyIssueType('Incident', map), { action: 'spec', type: 'bug', tags: ['incident'] });
});

test('a workspace entry overrides a default on key collision', () => {
  const { map, errors } = normalizeTypeMap({ task: 'ignore' });
  assert.deepEqual(errors, []);
  assert.deepEqual(classifyIssueType('Task', map), { action: 'ignore' });
});

// ---- unmapped types: held with a visible reason, never silently dropped ----

test('unknown type classifies as unmapped with a concrete config hint', () => {
  const { map } = normalizeTypeMap({});
  const out = classifyIssueType('Design Review', map);
  assert.equal(out.action, 'unmapped');
  assert.match(out.hint, /Design Review/);
  assert.match(out.hint, /sync\.jira\.map/);
  assert.match(out.hint, /design-review: spec/);
  assert.match(out.hint, /design-review: ignore/);
});

test('blank issue type is unmapped, not a crash and not a misfile', () => {
  const { map } = normalizeTypeMap({});
  for (const name of ['', '   ', null, undefined]) {
    const out = classifyIssueType(name, map);
    assert.equal(out.action, 'unmapped');
    assert.ok(out.hint.length > 0);
  }
});

test('configHint names the type and the exact map key to add', () => {
  const hint = configHint('Sub-task');
  assert.match(hint, /"Sub-task"/);
  assert.match(hint, /sub-task: spec/);
  assert.match(hint, /held, not imported/);
});

// ---- matching rules ----

test('lookup is case- and whitespace-insensitive; multi-word names hyphenate', () => {
  assert.equal(normalizeTypeKey('  Sub Task '), 'sub-task');
  assert.equal(normalizeTypeKey('SPIKE'), 'spike');
  const { map } = normalizeTypeMap({ 'design-review': 'ignore' });
  assert.equal(classifyIssueType('Design  Review', map).action, 'ignore');
  assert.equal(classifyIssueType('design review', map).action, 'ignore');
});

test('map keys normalize too — `Spike:` and `spike:` meet the same entry', () => {
  const { map } = normalizeTypeMap({ Spike: 'ignore' });
  assert.equal(classifyIssueType('spike', map).action, 'ignore');
});

// ---- validation: unsupported values fail loudly, listing the key ----

test('invalid scalar target is an error naming the key and valid targets', () => {
  const { errors } = normalizeTypeMap({ story: 'sepc' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sync\.jira\.map\.story/);
  assert.match(errors[0], /intent, spec, ignore/);
});

test('type hint outside the spec-type enum is rejected (no lifecycle values)', () => {
  for (const bad of ['epic', 'done', 'in-progress', 'triage']) {
    const { errors } = normalizeTypeMap({ spike: { to: 'spec', type: bad } });
    assert.equal(errors.length, 1, `expected error for type "${bad}"`);
    assert.match(errors[0], new RegExp(SPEC_TYPES.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('type/tags hints on non-spec targets are rejected', () => {
  const { errors } = normalizeTypeMap({ initiative: { to: 'intent', type: 'feature' } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /only apply to "to: spec"/);
});

test('block form without a valid "to" is an error', () => {
  for (const bad of [{}, { to: 'folder' }, { type: 'feature' }]) {
    const { errors } = normalizeTypeMap({ spike: bad });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /sync\.jira\.map\.spike/);
  }
});

test('tags must be a list; list entries coerce to trimmed strings', () => {
  assert.equal(normalizeTypeMap({ spike: { to: 'spec', tags: 'spike' } }).errors.length, 1);
  const { map, errors } = normalizeTypeMap({ spike: { to: 'spec', tags: [' spike ', ''] } });
  assert.deepEqual(errors, []);
  assert.deepEqual(classifyIssueType('Spike', map).tags, ['spike']);
});

test('a bad entry never lands in the effective map — defaults still stand', () => {
  const { map, errors } = normalizeTypeMap({ story: 'sepc', spike: 'spec' });
  assert.equal(errors.length, 1);
  assert.equal(classifyIssueType('Story', map).type, 'feature'); // default kept, typo not applied
  assert.equal(classifyIssueType('Spike', map).action, 'spec');  // valid sibling still lands
});

test('non-mapping map value is a single loud error', () => {
  const { map, errors } = normalizeTypeMap(['epic', 'story']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must be a mapping/);
  assert.equal(classifyIssueType('Epic', map).action, 'intent'); // defaults survive
});

// ---- integration: the block parses through the tl YAML parser ----

test('a TRIAGE.yml sync block round-trips through lib/parse parseYaml', () => {
  const yaml = [
    'sync:',
    '  jira:',
    '    url: "https://acme.atlassian.net"',
    '    project: "PROJ"',
    '    map:',
    '      epic: intent',
    '      story: spec',
    '      task: spec',
    '      bug: spec',
    '      spike:',
    '        to: spec',
    '        type: research',
    '        tags: [spike]',
    '      sub-task: ignore',
    '      incident:',
    '        to: spec',
    '        type: bug',
    '',
  ].join('\n');
  const parsed = parseYaml(yaml);
  const { map, errors } = normalizeTypeMap(parsed.sync.jira.map);
  assert.deepEqual(errors, []);
  assert.deepEqual(classifyIssueType('Spike', map), { action: 'spec', type: 'research', tags: ['spike'] });
  assert.deepEqual(classifyIssueType('Sub-task', map), { action: 'ignore' });
  assert.deepEqual(classifyIssueType('Incident', map), { action: 'spec', type: 'bug', tags: [] });
  assert.equal(classifyIssueType('Epic', map).action, 'intent');
  assert.equal(classifyIssueType('Improvement', map).action, 'unmapped');
});

// ---- exported constants stay in step with SCHEMA.md ----

test('SPEC_TYPES matches the schema spec-type enum; targets are closed', () => {
  assert.deepEqual([...SPEC_TYPES].sort(), ['bug', 'feature', 'research', 'tech_debt']);
  assert.deepEqual([...MAP_TARGETS].sort(), ['ignore', 'intent', 'spec']);
  assert.deepEqual(Object.keys(DEFAULT_TYPE_MAP).sort(), ['bug', 'epic', 'story', 'task']);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { canAdvanceToReview, verificationPolicy } = require('../lib/verification-gate');

const CFG = { verification: { require_independent_verifier: true, allow_self_check_for: [] } };
const CFG_RESEARCH_OK = { verification: { require_independent_verifier: true, allow_self_check_for: ['research'] } };

const spec = (type, claimedBy) => ({ meta: { type, claimed_by: claimedBy } });

test('gate: independent pass advances', () => {
  const r = canAdvanceToReview(spec('feature', 'claude'),
    { meta: { builder: 'claude', verifier: 'codex', verification_type: 'independent', verdict: 'pass' } }, CFG);
  assert.equal(r.ok, true);
  assert.match(r.reason, /codex/);
});

test('gate: residual-concerns still advances (human reads them at review)', () => {
  const r = canAdvanceToReview(spec('feature', 'claude'),
    { meta: { builder: 'claude', verifier: 'codex', verification_type: 'independent', verdict: 'residual-concerns' } }, CFG);
  assert.equal(r.ok, true);
});

test('gate: self-check blocked by default', () => {
  const r = canAdvanceToReview(spec('feature', 'codex'),
    { meta: { builder: 'codex', verifier: 'codex', verification_type: 'self-check', verdict: 'pass' } }, CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /self-check is not allowed/);
});

test('gate: builder==verifier is self-check even when mislabeled independent', () => {
  const r = canAdvanceToReview(spec('feature', 'codex'),
    { meta: { builder: 'codex', verifier: 'codex', verification_type: 'independent', verdict: 'pass' } }, CFG);
  assert.equal(r.ok, false);
});

test('gate: self-check allowed for research when configured', () => {
  const r = canAdvanceToReview(spec('research', 'claude'),
    { meta: { builder: 'claude', verifier: 'claude', verification_type: 'self-check', verdict: 'pass' } }, CFG_RESEARCH_OK);
  assert.equal(r.ok, true);
  assert.match(r.reason, /research/);
});

test('gate: missing alignment rejected when verification required', () => {
  const r = canAdvanceToReview(spec('feature', 'claude'), null, CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ALIGNMENT\.md missing/);
});

test('gate: not enforced when workspace has no verification section', () => {
  const r = canAdvanceToReview(spec('feature', 'claude'), null, {});
  assert.equal(r.ok, true);
});

test('gate: bad verdict rejected on independent path', () => {
  const r = canAdvanceToReview(spec('feature', 'claude'),
    { meta: { builder: 'claude', verifier: 'codex', verdict: 'fail' } }, CFG);
  assert.equal(r.ok, false);
});

test('gate: human-decision-required never advances', () => {
  const r = canAdvanceToReview(spec('feature', 'claude'),
    { meta: { builder: 'claude', verifier: 'gemini', verdict: 'human-decision-required' } }, CFG);
  assert.equal(r.ok, false);
  assert.match(r.reason, /human must approve/);
});

test('policy: parses allow list case-insensitively', () => {
  const p = verificationPolicy({ verification: { require_independent_verifier: true, allow_self_check_for: ['Research'] } });
  assert.deepEqual(p.allowSelfCheckFor, ['research']);
  assert.equal(p.required, true);
});

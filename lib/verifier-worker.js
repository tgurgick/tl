// Isolated verifier runner. The model is an untrusted reviewer: TL runs declared
// checks in a disposable worktree, gives the reviewer their output, and accepts
// only a structured verdict. Source mutations are findings, never patches.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { setFrontmatterField, fmValue } = require('./frontmatter');

const RESULT_BEGIN = 'TL_VERIFIER_RESULT_BEGIN';
const RESULT_END = 'TL_VERIFIER_RESULT_END';
const SECRET_ENV = /^(ANTHROPIC|CLAUDE|OPENAI|GOOGLE|GEMINI|AWS|AZURE|GITHUB|GH|JIRA|SLACK|NPM)_/i;

function scrubEnvironment(source = process.env, keep = {}) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!SECRET_ENV.test(key)) out[key] = value;
  }
  return { ...out, ...keep };
}

function normalizePolicy(raw = {}) {
  const mode = raw.mode === 'review-only' ? 'review-only' : 'verify';
  const command = Array.isArray(raw.command) ? raw.command.map(String) : [];
  const flags = command.concat(Array.isArray(raw.extra_flags) ? raw.extra_flags.map(String) : []);
  if (flags.includes('--dangerously-skip-permissions')) {
    throw new Error('unsafe verifier configuration: --dangerously-skip-permissions is forbidden');
  }
  const allowCommands = Array.isArray(raw.allow_commands)
    ? raw.allow_commands.map(String).filter(Boolean) : [];
  if (mode === 'review-only' && allowCommands.length) {
    throw new Error('review-only verifier cannot declare acceptance commands');
  }
  return { mode, command, allowCommands, allowNetwork: raw.allow_network === true };
}

function buildGeminiInvocation(policy, prompt) {
  const p = normalizePolicy(policy);
  const base = p.command.length ? p.command : ['agy'];
  return {
    file: base[0],
    args: base.slice(1).concat(['--sandbox', '--mode', 'plan', '-p', String(prompt)]),
  };
}

function parseStructuredResult(stdout) {
  const src = String(stdout || '');
  const start = src.lastIndexOf(RESULT_BEGIN);
  const end = src.lastIndexOf(RESULT_END);
  if (start < 0 || end <= start) throw new Error('verifier output missing structured result markers');
  const raw = src.slice(start + RESULT_BEGIN.length, end).trim();
  const result = JSON.parse(raw);
  if (!['pass', 'concerns', 'human-decision-required'].includes(result.verdict)) {
    throw new Error('invalid verifier verdict');
  }
  result.notes = Array.isArray(result.notes) ? result.notes.map(String) : [];
  result.proposed_mutations = Array.isArray(result.proposed_mutations)
    ? result.proposed_mutations.map(m => ({ file: String(m.file || ''), reason: String(m.reason || '') })) : [];
  return result;
}

function changedFiles(repo, run = spawnSync) {
  const r = run('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not inspect verifier worktree');
  return String(r.stdout || '').split('\n').filter(Boolean).map(line => line.slice(3).trim()).filter(Boolean);
}

function runAcceptanceCommands(repo, commands, run = spawnSync, env = process.env) {
  const results = [];
  for (const command of commands) {
    const r = run('/bin/sh', ['-lc', command], {
      cwd: repo, env: scrubEnvironment(env), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    results.push({ command, status: r.status == null ? 1 : r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') });
  }
  return results;
}

function makePrompt({ brief, checks }) {
  return [
    'You are an independent reviewer in a disposable worktree.',
    'Do not edit files, run commands, access the network, or read credentials. TL already ran the allowed checks.',
    'If a mutation is advisable, record it under proposed_mutations; never implement it.',
    'Return JSON between the exact markers below with verdict, notes, and proposed_mutations.',
    RESULT_BEGIN, '{"verdict":"pass|concerns|human-decision-required","notes":[],"proposed_mutations":[{"file":"path","reason":"why"}]}', RESULT_END,
    '', 'BRIEF:', String(brief || ''), '', 'ALLOWLISTED CHECK RESULTS:', JSON.stringify(checks),
  ].join('\n');
}

function createWorktree(repo, run = spawnSync, tempRoot = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'tl-verify-'));
  const r = run('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('could not create verifier worktree'); }
  return dir;
}

function removeWorktree(repo, dir, run = spawnSync) {
  run('git', ['worktree', 'remove', '--force', dir], { cwd: repo, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
}

function runIsolatedVerification(opts) {
  const run = opts.spawn || spawnSync;
  const policy = normalizePolicy(opts.policy);
  const worktree = (opts.createWorktree || createWorktree)(opts.repo, run, opts.tempRoot);
  try {
    const checks = policy.mode === 'review-only' ? [] : runAcceptanceCommands(worktree, policy.allowCommands, run, opts.env);
    const prompt = makePrompt({ brief: opts.brief, checks });
    const invocation = (opts.buildInvocation || buildGeminiInvocation)(policy, prompt);
    const child = run(invocation.file, invocation.args, {
      cwd: worktree, env: scrubEnvironment(opts.env), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (child.status !== 0) return { status: 'blocked', reason: 'verifier process failed', checks };
    const result = parseStructuredResult(child.stdout);
    const mutations = changedFiles(worktree, run);
    const proposed = result.proposed_mutations.concat(mutations.map(file => ({ file, reason: 'unexpected verifier worktree mutation' })));
    if (proposed.length) {
      return { status: 'human-decision-required', verdict: 'human-decision-required', notes: result.notes, proposed_mutations: proposed, checks };
    }
    if (checks.some(c => c.status !== 0)) return { status: 'blocked', reason: 'allowlisted acceptance command failed', notes: result.notes, checks };
    return { status: result.verdict === 'pass' ? 'pass' : 'blocked', verdict: result.verdict, notes: result.notes, checks };
  } finally {
    (opts.removeWorktree || removeWorktree)(opts.repo, worktree, run);
  }
}

function alignmentText({ specPath, builder, verifier, result }) {
  const human = result.status === 'human-decision-required';
  const verdict = human ? 'human-decision-required' : (result.verdict || result.status);
  const concerns = (result.notes || []).concat((result.proposed_mutations || []).map(m => `${m.file}: ${m.reason}`));
  return [
    '---', `spec: "${fmValue(specPath)}"`, `builder: "${fmValue(builder)}"`, `verifier: "${fmValue(verifier)}"`,
    'verification_type: "independent"', 'rounds: 1', `verdict: "${fmValue(verdict)}"`,
    ...(concerns.length ? ['residual_concerns:', ...concerns.map(x => `  - "${fmValue(x)}"`)] : ['residual_concerns: []']), '---', '',
    '# Alignment', '', human
      ? 'The verifier proposed a mutation. No source change was applied and the spec remains held for a human decision.'
      : 'The isolated verifier completed without mutating the disposable worktree.', '',
    ...(result.notes || []).map(x => `- ${x}`),
  ].join('\n') + '\n';
}

function recordVerificationOutcome({ wsDir, slug, builder, verifier, result }) {
  const testsDir = path.join(wsDir, 'tests', slug);
  if (!fs.statSync(testsDir).isDirectory()) throw new Error('spec is not at tests gate');
  const outcomeDir = path.join(testsDir, 'outcome');
  fs.mkdirSync(outcomeDir, { recursive: true });
  fs.writeFileSync(path.join(outcomeDir, 'ALIGNMENT.md'), alignmentText({
    specPath: `tests/${slug}/`, builder, verifier, result,
  }));

  if (result.status === 'human-decision-required') {
    const proposals = (result.proposed_mutations || []).map(m => `- \`${m.file}\`: ${m.reason}`).join('\n') || '- See ALIGNMENT.md.';
    fs.appendFileSync(path.join(testsDir, 'NOTES.md'), [
      '', '## Verifier mutation proposal — human decision required', '',
      'No mutation was applied. Choose either: approve a fix-forward for an agent to implement, or kick this spec back to the builder/another agent.', '', proposals, '',
    ].join('\n'));
    let spec = fs.readFileSync(path.join(testsDir, 'SPEC.md'), 'utf8');
    spec = setFrontmatterField(spec, 'status', 'blocked');
    spec = setFrontmatterField(spec, 'awaiting_verifier', 'false');
    spec = setFrontmatterField(spec, 'verified_by', verifier);
    spec = setFrontmatterField(spec, 'verification_type', 'independent');
    fs.writeFileSync(path.join(testsDir, 'SPEC.md'), spec);
    return { status: 'human-decision-required', path: `tests/${slug}/` };
  }

  if (result.status !== 'pass') return { status: 'blocked', path: `tests/${slug}/` };
  let spec = fs.readFileSync(path.join(testsDir, 'SPEC.md'), 'utf8');
  spec = setFrontmatterField(spec, 'status', 'in-review');
  spec = setFrontmatterField(spec, 'awaiting_verifier', 'false');
  spec = setFrontmatterField(spec, 'verified_by', verifier);
  spec = setFrontmatterField(spec, 'verification_type', 'independent');
  fs.writeFileSync(path.join(testsDir, 'SPEC.md'), spec);
  const dest = path.join(wsDir, 'in-review', slug);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(testsDir, dest);
  return { status: 'in-review', path: `in-review/${slug}/` };
}

module.exports = {
  RESULT_BEGIN, RESULT_END, scrubEnvironment, normalizePolicy, buildGeminiInvocation,
  parseStructuredResult, changedFiles, runAcceptanceCommands, makePrompt,
  createWorktree, removeWorktree, runIsolatedVerification, alignmentText, recordVerificationOutcome,
};

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  filesToTouch, isReadOnly, specSlug, dependencySatisfied, activeConflicts, selectBatch,
  calmCap, selectContinuations,
  isRepoUrl, localRepoPath, repoHoldReason, sameResolvedPath, sameLocalRepo,
} = require('../lib/batch');

// build a spec object shaped like readStage produces
function mk(slug, { priority = 'p2', type = 'feature', deps, files, mtime = 0, readonlyBody, stage = 'ready', repo } = {}) {
  let body = '';
  if (readonlyBody) body = '## Objective\ndo a thing\n';
  else if (files !== undefined) {
    body = '## Scope\n\n### Files to touch\n' + files.map(f => `- \`${f}\``).join('\n') + '\n';
  } else {
    body = '## Scope\n\n### Files to touch\n';   // declared but empty
  }
  const folder = stage === 'ready' ? 'specs' : stage;
  const meta = { priority, type, depends_on: deps };
  if (repo !== undefined) meta.repo = repo;
  return { path: `${folder}/${slug}/`, stage, meta, body, mtime };
}

test('specSlug normalizes across stages', () => {
  assert.equal(specSlug('specs/foo/'), 'foo');
  assert.equal(specSlug('done/foo/'), 'foo');
  assert.equal(specSlug('in-progress/foo/SPEC.md'), 'foo');
  assert.equal(specSlug('foo'), 'foo');
});

test('dependencySatisfied: specs/foo/ is satisfied by a done foo (by slug)', () => {
  const done = new Set(['foo']);   // slug set, as cmdRun builds it from done paths
  assert.equal(dependencySatisfied('specs/foo/', done), true);
  assert.equal(dependencySatisfied('specs/bar/', done), false);
});

test('isReadOnly: research yes; code no; empty-scope code no; no-scope yes', () => {
  assert.equal(isReadOnly(mk('r', { type: 'research', readonlyBody: true })), true);
  assert.equal(isReadOnly(mk('c', { files: ['a.js'] })), false);
  assert.equal(isReadOnly(mk('empty', { files: undefined })), false);   // heading present, no bullets
  assert.equal(isReadOnly(mk('plain', { type: 'feature', readonlyBody: true })), true); // no scope section
});

test('filesToTouch parses backtick bullets incl. comma lists', () => {
  const s = mk('x', { files: ['a.js', 'b.js, c.js'] });
  assert.deepEqual(filesToTouch(s), ['a.js', 'b.js', 'c.js']);
});

test('selectBatch: disjoint code specs batch together', () => {
  const { batch, held } = selectBatch([
    mk('a', { files: ['a.js'] }),
    mk('b', { files: ['b.js'] }),
  ], new Set());
  assert.equal(batch.length, 2);
  assert.equal(held.length, 0);
});

test('selectBatch: overlapping files hold the second', () => {
  const { batch, held } = selectBatch([
    mk('a', { files: ['shared.js'], mtime: 1 }),
    mk('b', { files: ['shared.js'], mtime: 2 }),
  ], new Set());
  assert.equal(batch.length, 1);
  assert.equal(held.length, 1);
  assert.match(held[0].holdReason, /file conflict/);
});

test('selectBatch: unmet dependency is blocked', () => {
  const { batch, held } = selectBatch([
    mk('needsdep', { files: ['a.js'], deps: ['specs/missing/'] }),
  ], new Set());          // nothing done
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /blocked on/);
});

test('selectBatch: met dependency (by slug) lets the spec run', () => {
  const { batch } = selectBatch([
    mk('needsdep', { files: ['a.js'], deps: ['specs/dep/'] }),
  ], new Set(['dep']));   // dep is done
  assert.equal(batch.length, 1);
});

test('selectBatch: caps at 4, holds the overflow', () => {
  const specs = ['a', 'b', 'c', 'd', 'e'].map((s, i) => mk(s, { files: [s + '.js'], mtime: i }));
  const { batch, held } = selectBatch(specs, new Set());
  assert.equal(batch.length, 4);
  assert.equal(held.length, 1);
  assert.match(held[0].holdReason, /capped/);
});

test('selectBatch: undeclared scope conflicts with other code specs', () => {
  const undeclared = { path: 'specs/u/', meta: { priority: 'p2', type: 'feature' }, body: '## Objective\nx\n', mtime: 5 };
  // note: no "Files to touch" section at all → treated read-only, so it does NOT conflict.
  // an undeclared *code* spec is one with the section but no parseable files:
  const { batch, held } = selectBatch([
    mk('code', { files: ['a.js'], mtime: 1 }),
    mk('empty', { files: undefined, mtime: 2 }),   // has heading, no files → code, undeclared
  ], new Set());
  assert.equal(batch.length, 1);
  assert.match(held[0].holdReason, /undeclared scope/);
  void undeclared;
});

// ---------- active-work conflict guard ----------

test('activeConflicts: maps locked files to their stage/slug source, skips read-only', () => {
  const active = activeConflicts([
    mk('inprog', { stage: 'in-progress', files: ['bin/tl.js'] }),
    mk('research', { stage: 'in-progress', type: 'research', readonlyBody: true }), // read-only locks nothing
  ]);
  assert.equal(active.files.get('bin/tl.js'), 'in-progress/inprog');
  assert.equal(active.codeActive, true);
  assert.equal(active.files.has('anything-else.js'), false);
});

test('activeConflicts: dirty git paths lock files under a "dirty git" label', () => {
  const active = activeConflicts([], ['lib/foo.js', '']);
  assert.equal(active.files.get('lib/foo.js'), 'dirty git');
  assert.equal(active.codeActive, true);
  assert.equal(active.files.size, 1);   // blank path skipped
});

test('selectBatch: holds a ready spec that conflicts with an in-progress spec', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['bin/tl.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['bin/tl.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with in-progress\/foo on bin\/tl\.js/);
});

test('selectBatch: holds a ready spec that conflicts with a tests-stage spec', () => {
  const active = activeConflicts([mk('foo', { stage: 'tests', files: ['a.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['a.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with tests\/foo on a\.js/);
});

test('selectBatch: holds a ready spec that conflicts with an in-review spec', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-review', files: ['a.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['a.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with in-review\/foo on a\.js/);
});

test('selectBatch: holds a ready spec that conflicts with a dirty git path', () => {
  const active = activeConflicts([], ['bin/tl.js']);
  const { batch, held } = selectBatch([mk('r', { files: ['bin/tl.js'] })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /conflicts with dirty git on bin\/tl\.js/);
});

test('selectBatch: read-only ready spec never conflicts with active work', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['a.js'] })], ['b.js']);
  const { batch, held } = selectBatch([mk('r', { type: 'research', readonlyBody: true })], new Set(), { active });
  assert.equal(batch.length, 1);
  assert.equal(held.length, 0);
});

test('selectBatch: undeclared-scope code spec is held when any code work is active', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['unrelated.js'] })]);
  const { batch, held } = selectBatch([mk('empty', { files: undefined })], new Set(), { active });
  assert.equal(batch.length, 0);
  assert.match(held[0].holdReason, /undeclared scope — conflicts with active code work/);
});

test('selectBatch: a non-overlapping ready spec still runs alongside active work', () => {
  const active = activeConflicts([mk('foo', { stage: 'in-progress', files: ['locked.js'] })]);
  const { batch, held } = selectBatch([mk('r', { files: ['free.js'] })], new Set(), { active });
  assert.equal(batch.length, 1);
  assert.equal(held.length, 0);
});

test('selectBatch: no active set behaves exactly as before (back-compat)', () => {
  const { batch, held } = selectBatch([
    mk('a', { files: ['a.js'] }),
    mk('b', { files: ['b.js'] }),
  ], new Set());
  assert.equal(batch.length, 2);
  assert.equal(held.length, 0);
});

// ---------- fan-out: configured cap, concrete conflict reasons, continuation batches ----------

test('calmCap: reads run.cap from the triage config, falls back to 4', () => {
  assert.equal(calmCap(null), 4);
  assert.equal(calmCap({}), 4);
  assert.equal(calmCap({ run: { cap: 2 } }), 2);
  assert.equal(calmCap({ run: { cap: 7 } }), 7);
  // non-sensical values never disable the cap
  assert.equal(calmCap({ run: { cap: 0 } }), 4);
  assert.equal(calmCap({ run: { cap: -3 } }), 4);
  assert.equal(calmCap({ run: { cap: 'lots' } }), 4);
  assert.equal(calmCap({ run: { cap: 2.5 } }), 4);
  assert.equal(calmCap({ run: {} }), 4);
});

test('selectBatch: honors a configured cap via opts.cap', () => {
  const specs = ['a', 'b', 'c'].map((s, i) => mk(s, { files: [s + '.js'], mtime: i }));
  const { batch, held } = selectBatch(specs, new Set(), { cap: 2 });
  assert.equal(batch.length, 2);
  assert.equal(held.length, 1);
  assert.match(held[0].holdReason, /batch capped at 2/);
});

test('selectBatch: within-batch file conflict names the winning spec', () => {
  const { held } = selectBatch([
    mk('winner', { files: ['shared.js'], mtime: 1 }),
    mk('loser', { files: ['shared.js'], mtime: 2 }),
  ], new Set());
  assert.match(held[0].holdReason, /file conflict on shared\.js with winner/);
});

// ---------- claim-time asset preflight (repo readiness) ----------

// A stubbed preflight for a NON-tl workspace: only /repos/good is a usable
// checkout (existing dir containing .git); the tl checkout is /tl/checkout.
function pre(over = {}) {
  return {
    isRepo: p => p === '/repos/good',
    tlRoot: '/tl/checkout',
    workspaceRepo: '/repos/good',
    homedir: '/home/u',
    ...over,
  };
}

test('isRepoUrl: URLs and scp-style remotes yes, local paths no', () => {
  assert.equal(isRepoUrl('https://github.com/a/b.git'), true);
  assert.equal(isRepoUrl('git@github.com:a/b.git'), true);
  assert.equal(isRepoUrl('~/Documents/GitHub/x'), false);
  assert.equal(isRepoUrl('/abs/path'), false);
  assert.equal(isRepoUrl(''), false);
});

test('localRepoPath: expands ~ with the injected homedir; URL or unset is null', () => {
  assert.equal(localRepoPath('~/proj', '/home/u'), '/home/u/proj');
  assert.equal(localRepoPath('~', '/home/u'), '/home/u');
  assert.equal(localRepoPath('/abs/proj/', '/home/u'), '/abs/proj');
  assert.equal(localRepoPath('https://github.com/a/b.git', '/home/u'), null);
  assert.equal(localRepoPath('', '/home/u'), null);
  assert.equal(localRepoPath(undefined, '/home/u'), null);
});

test('repoHoldReason: missing dir is held with the literal path', () => {
  const s = mk('a', { files: ['a.js'], repo: '/repos/missing' });
  assert.equal(repoHoldReason(s, pre()), 'repo not found: /repos/missing');
});

test('repoHoldReason: dir without .git is held (isRepo says not a checkout)', () => {
  // /repos/bare exists but the injected check requires a contained .git
  const s = mk('a', { files: ['a.js'], repo: '/repos/bare' });
  assert.equal(repoHoldReason(s, pre()), 'repo not found: /repos/bare');
});

test('repoHoldReason: resolvable repo passes; ~ is expanded before the check', () => {
  assert.equal(repoHoldReason(mk('a', { files: ['a.js'], repo: '/repos/good' }), pre()), null);
  const tilde = mk('b', { files: ['b.js'], repo: '~/proj' });
  assert.equal(repoHoldReason(tilde, pre({ isRepo: p => p === '/home/u/proj' })), null);
  assert.equal(repoHoldReason(tilde, pre()), 'repo not found: ~/proj');
});

test('repoHoldReason: repo-not-found applies to read-only specs too', () => {
  const s = mk('r', { type: 'research', readonlyBody: true, repo: '/repos/missing' });
  assert.match(repoHoldReason(s, pre()), /^repo not found: /);
});

test('repoHoldReason: repo unset on a read-only spec passes', () => {
  assert.equal(repoHoldReason(mk('r', { type: 'research', readonlyBody: true }), pre()), null);
});

test('repoHoldReason: repo unset on a code spec in a non-tl workspace is held', () => {
  const s = mk('c', { files: ['a.js'] });
  assert.equal(repoHoldReason(s, pre()), 'no project repo — refusing to work in the tl checkout');
});

test('repoHoldReason: repo at or inside the tl root is held for a non-tl workspace', () => {
  const isRepo = () => true;   // both exist as checkouts — containment still refuses
  const atRoot = mk('c', { files: ['a.js'], repo: '/tl/checkout' });
  const nested = mk('c', { files: ['a.js'], repo: '/tl/checkout/bench' });
  assert.equal(repoHoldReason(atRoot, pre({ isRepo })), 'no project repo — refusing to work in the tl checkout');
  assert.equal(repoHoldReason(nested, pre({ isRepo })), 'no project repo — refusing to work in the tl checkout');
  // a sibling path sharing the prefix is NOT inside the tl root
  const sibling = mk('c', { files: ['a.js'], repo: '/tl/checkout-other' });
  assert.equal(repoHoldReason(sibling, pre({ isRepo })), null);
});

test('repoHoldReason: URL-only repo is treated as unset (containment holds a code spec)', () => {
  const s = mk('c', { files: ['a.js'], repo: 'git@github.com:a/b.git' });
  assert.equal(repoHoldReason(s, pre()), 'no project repo — refusing to work in the tl checkout');
  // …but a read-only spec with a URL repo passes: nothing local to check.
  assert.equal(repoHoldReason(mk('r', { type: 'research', readonlyBody: true, repo: 'https://x.test/r.git' }), pre()), null);
});

test('repoHoldReason: the tl-developing-tl workspace is exempt from containment', () => {
  const tlPre = pre({ isRepo: () => true, workspaceRepo: '/tl/checkout' });
  assert.equal(repoHoldReason(mk('c', { files: ['a.js'] }), tlPre), null);                              // unset repo ok
  assert.equal(repoHoldReason(mk('c', { files: ['a.js'], repo: '/tl/checkout' }), tlPre), null);        // tl root ok
  // the exemption never waives the existence check
  const missing = pre({ workspaceRepo: '/tl/checkout' });
  assert.match(repoHoldReason(mk('c', { files: ['a.js'], repo: '/repos/missing' }), missing), /^repo not found: /);
});

test('sameResolvedPath / sameLocalRepo: exact path only — no basename fallback', () => {
  // same basename, different parent → NOT the same repo
  assert.equal(sameResolvedPath('/a/throughline', '/b/throughline'), false);
  assert.equal(sameLocalRepo('/a/throughline', '/b/throughline', '/home/u'), false);
  // exact match
  assert.equal(sameResolvedPath('/tl/checkout', '/tl/checkout'), true);
  assert.equal(sameLocalRepo('/tl/checkout', '/tl/checkout', '/home/u'), true);
  // ~ vs absolute — same after expand
  assert.equal(sameLocalRepo('~/Documents/GitHub/throughline', '/home/u/Documents/GitHub/throughline', '/home/u'), true);
  // sibling sharing only the leaf name must not get the tl-developing-tl exemption
  const siblingWs = pre({
    isRepo: () => true,
    tlRoot: '/tl/checkout',
    workspaceRepo: '/other/checkout', // same basename, different parent
  });
  assert.equal(
    repoHoldReason(mk('c', { files: ['a.js'] }), siblingWs),
    'no project repo — refusing to work in the tl checkout'
  );
});

test('sameResolvedPath: optional resolvePath covers symlink-canonical identity', () => {
  const real = '/real/throughline';
  const link = '/link/throughline';
  const resolvePath = (p) => (String(p) === link || String(p) === real ? real : require('path').resolve(p));
  assert.equal(sameResolvedPath(link, real), false); // default resolve keeps them distinct
  assert.equal(sameResolvedPath(link, real, { resolvePath }), true);
  assert.equal(sameLocalRepo(link, real, '/home/u', { resolvePath }), true);
});

test('repoHoldReason: no preflight wired → no holds (back-compat)', () => {
  assert.equal(repoHoldReason(mk('c', { files: ['a.js'], repo: '/repos/missing' }), null), null);
  assert.equal(repoHoldReason(mk('c', { files: ['a.js'] }), {}), null);
});

test('selectBatch: repo-held specs are held with the concrete reason, others still run', () => {
  const { batch, held } = selectBatch([
    mk('void', { files: ['a.js'], repo: '/repos/missing', mtime: 1 }),
    mk('nore', { files: ['b.js'], mtime: 2 }),
    mk('ok', { files: ['c.js'], repo: '/repos/good', mtime: 3 }),
  ], new Set(), { preflight: pre() });
  assert.deepEqual(batch.map(s => specSlug(s.path)), ['ok']);
  assert.equal(held.find(h => specSlug(h.path) === 'void').holdReason, 'repo not found: /repos/missing');
  assert.equal(held.find(h => specSlug(h.path) === 'nore').holdReason, 'no project repo — refusing to work in the tl checkout');
});

test('selectBatch: without opts.preflight the repo check is off (back-compat)', () => {
  const { batch, held } = selectBatch([mk('void', { files: ['a.js'], repo: '/repos/missing' })], new Set());
  assert.equal(batch.length, 1);
  assert.equal(held.length, 0);
});

test('selectContinuations: a repo-held continuation stays pending with the same reason', () => {
  const { batch, held } = selectContinuations([
    cont('void', { files: ['a.js'], repo: '/repos/missing' }, { created: '2026-07-01' }),
    cont('ok', { files: ['b.js'], repo: '/repos/good' }, { created: '2026-07-02' }),
  ], { preflight: pre() });
  assert.deepEqual(batch.map(c => specSlug(c.spec.path)), ['ok']);
  assert.equal(held[0].holdReason, 'repo not found: /repos/missing');
});

// A live continuation entry as readContinuations shapes it: dispatch file +
// parsed dispatch JSON + the in-progress/tests spec it resumes.
function cont(slug, specOpts = {}, dispatch = {}) {
  return {
    file: '_dispatch/' + slug + '.json',
    dispatch: { spec: slug, mode: 'continuation', status: 'pending', ...dispatch },
    spec: mk(slug, { stage: 'in-progress', ...specOpts }),
  };
}

test('selectContinuations: orders by spec priority, then oldest kickback', () => {
  const { batch, held } = selectContinuations([
    cont('late-p2', { priority: 'p2', files: ['a.js'] }, { created: '2026-07-01' }),
    cont('urgent', { priority: 'p0', files: ['b.js'] }, { created: '2026-07-03' }),
    cont('old-p2', { priority: 'p2', files: ['c.js'] }, { created: '2026-06-28' }),
  ]);
  assert.equal(held.length, 0);
  assert.deepEqual(batch.map(c => specSlug(c.spec.path)), ['urgent', 'old-p2', 'late-p2']);
});

test('selectContinuations: overlapping resumed scopes serialize with a concrete reason', () => {
  const { batch, held } = selectContinuations([
    cont('first', { priority: 'p1', files: ['src/x.js'] }, { created: '2026-07-01' }),
    cont('second', { priority: 'p2', files: ['src/x.js', 'src/y.js'] }, { created: '2026-07-02' }),
  ]);
  assert.equal(batch.length, 1);
  assert.equal(held.length, 1);
  assert.match(held[0].holdReason, /file conflict on src\/x\.js with first/);
});

test('selectContinuations: caps the resume batch, overflow stays pending', () => {
  const live = ['a', 'b', 'c'].map((s, i) => cont(s, { files: [s + '.js'] }, { created: '2026-07-0' + (i + 1) }));
  const { batch, held } = selectContinuations(live, { cap: 2 });
  assert.equal(batch.length, 2);
  assert.equal(held.length, 1);
  assert.match(held[0].holdReason, /batch capped at 2/);
});

test('selectContinuations: read-only continuations never conflict', () => {
  const { batch, held } = selectContinuations([
    cont('code', { files: ['a.js'] }),
    cont('research', { type: 'research', readonlyBody: true }),
  ]);
  assert.equal(batch.length, 2);
  assert.equal(held.length, 0);
});

test('selectContinuations: undeclared scope conflicts with other resumed code work', () => {
  const { batch, held } = selectContinuations([
    cont('code', { priority: 'p1', files: ['a.js'] }),
    cont('vague', { priority: 'p2', files: undefined }),   // heading present, no bullets
  ]);
  assert.equal(batch.length, 1);
  assert.match(held[0].holdReason, /undeclared scope/);
});

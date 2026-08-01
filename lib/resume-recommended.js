// lib/resume-recommended.js — shared "recommended next" + open-loop ranking
// for /tl resume and the cockpit Resume tab. Pure functions over already-parsed
// workspace shapes (specs, threads, goals, intents). Zero dependencies.
//
// Priority for recommended next (highest first — keep skill + UI in lockstep):
//   1. open question/risk/decision blocking the top ready spec
//   2. top-weighted goal with zero active specs (not when all linked work is done)
//   3. longest-idle in-progress with NOTES.md (kickback / mid-flight)
//   4. top ready spec
//   5. any open question
//   6. in-progress without NOTES → all clear
//   7. empty queue → decompose ask
//
// UMD: CommonJS for tests/CLI; `globalThis.ResumeRecommended` for the cockpit
// (ui/index.html inlines the same factory — keep both copies in lockstep).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ResumeRecommended = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const ACTIVE = new Set(['ready', 'in-progress', 'tests', 'in-review']);
const PRIO = { p0: 0, p1: 1, p2: 2, p3: 3 };
const OPEN_TYPES = new Set(['question', 'risk', 'decision']);
const DAY = 86400000;

function normPath(p) {
  return String(p || '').replace(/^\.\//, '').replace(/\/$/, '').trim();
}

function slugOf(p) {
  return normPath(p).split('/').pop().replace(/\.md$/, '');
}

function pathsMatch(a, b) {
  const na = normPath(a), nb = normPath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return slugOf(na) === slugOf(nb);
}

function meta(item) {
  return (item && item.meta) || {};
}

function topGoal(goals) {
  if (!goals || !goals.length) return null;
  return goals.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))[0];
}

function sortedReady(specs) {
  return (specs || [])
    .filter(s => s.stage === 'ready')
    .sort((a, b) => (PRIO[meta(a).priority] ?? 9) - (PRIO[meta(b).priority] ?? 9)
      || (a.mtime || 0) - (b.mtime || 0));
}

function openTypedThreads(threads) {
  return (threads || []).filter(t => {
    const type = String(meta(t).type || '').toLowerCase();
    const status = String(meta(t).status || '').toLowerCase();
    return OPEN_TYPES.has(type) && status === 'open';
  });
}

function threadBlocksSpec(thread, spec) {
  const linked = meta(thread).linked_spec;
  if (!linked || !spec) return false;
  return pathsMatch(linked, spec.path);
}

function specsForGoal(goal, { specs, intents }) {
  if (!goal) return [];
  const goalId = String(goal.id || '');
  const intentPaths = new Set(
    (intents || [])
      .filter(it => (meta(it).goals || []).map(String).includes(goalId))
      .map(it => normPath(it.path))
  );
  return (specs || []).filter(s => intentPaths.has(normPath(meta(s).intent)));
}

/** True when the goal has zero active work and is not fully complete (all done). */
function isGoalStarving(goal, ctx) {
  if (!goal) return false;
  const linked = specsForGoal(goal, ctx);
  if (!linked.length) return true; // no work ladders to it yet
  if (linked.some(s => ACTIVE.has(s.stage))) return false;
  if (linked.every(s => s.stage === 'done')) return false;
  return true; // e.g. only triage leftovers — still needs a human call
}

/** True when an intent has zero active specs and is not fully complete. */
function isIntentStarving(intent, specs) {
  const status = String(meta(intent).status || '').toLowerCase();
  if (status !== 'decomposed' && status !== 'approved') return false;
  const its = (specs || []).filter(s => normPath(meta(s).intent) === normPath(intent.path));
  if (its.some(s => s.stage === 'ready' || s.stage === 'in-progress' || s.stage === 'tests' || s.stage === 'in-review')) return false;
  if (its.length && its.every(s => s.stage === 'done')) return false;
  return true;
}

function longestIdleInProgress(specs, { requireNotes = false } = {}) {
  let list = (specs || []).filter(s => s.stage === 'in-progress');
  if (requireNotes) list = list.filter(s => !!s.notes);
  if (!list.length) return null;
  return list.slice().sort((a, b) => (a.mtime || 0) - (b.mtime || 0))[0];
}

/**
 * Pick the single recommended-next item for Resume "In focus".
 * @returns {{ kind: string, item: object|null, reason: string, items?: object[] }}
 */
function chooseRecommendedNext({ specs = [], threads = [], goals = [], intents = [] } = {}) {
  const ready = sortedReady(specs);
  const topReady = ready[0] || null;
  const openThreads = openTypedThreads(threads);

  if (topReady) {
    const blocking = openThreads.find(t => threadBlocksSpec(t, topReady));
    if (blocking) {
      return {
        kind: 'blocking-thread',
        item: blocking,
        reason: `Open ${meta(blocking).type} blocking the top ready spec — answer it before running the queue.`,
      };
    }
  }

  const goal = topGoal(goals);
  if (goal && isGoalStarving(goal, { specs, intents })) {
    return {
      kind: 'starving-goal',
      item: goal,
      reason: 'Top-weighted goal has zero active specs — decompose an intent or revisit the goal.',
    };
  }

  const withNotes = longestIdleInProgress(specs, { requireNotes: true });
  if (withNotes) {
    const kicked = /kicked back/i.test(String(withNotes.notes || ''));
    return {
      kind: 'kickback',
      item: withNotes,
      reason: kicked
        ? 'Longest-idle in-progress with kickback NOTES — binding corrections for the next run.'
        : 'Longest-idle in-progress with NOTES.md — mid-flight feedback needs attention.',
    };
  }

  if (topReady) {
    return {
      kind: 'spec',
      item: topReady,
      reason: `Top of the queue${meta(topReady).status === 'blocked' ? ', but blocked' : ', ready'} — read it, then /tl run.`,
    };
  }

  const openQ = openThreads.find(t => String(meta(t).type || '').toLowerCase() === 'question');
  if (openQ) {
    return {
      kind: 'question',
      item: openQ,
      reason: 'An open question, upstream of new work.',
    };
  }

  const inprog = (specs || []).filter(s => s.stage === 'in-progress');
  if (inprog.length) {
    return {
      kind: 'clear',
      item: null,
      items: inprog,
      reason: 'Agents working; nothing needs you.',
    };
  }

  return {
    kind: 'empty',
    item: null,
    reason: 'Queue empty — decompose the next slice of an intent.',
  };
}

/**
 * Collect decay-inbox candidates (uncapped). Caller ranks + slices to ≤3.
 */
function collectOpenLoops({
  specs = [], threads = [], intents = [], goals = [],
  now = Date.now(), idleMs = 10 * DAY, triageMs = 14 * DAY,
  healthLoops = [],
} = {}) {
  const loops = [];
  const push = (kind, item, title, sub, age, extra = {}) => {
    loops.push({ kind, item, title, sub, age: age == null ? 0 : age, ...extra });
  };

  // Shared doctor findings (lib/doctor.js healthOpenLoops) — highest urgency first.
  for (const h of healthLoops || []) {
    push(
      h.kind === 'capacity' ? 'blocked' : 'risk',
      { path: 'health/' + (h.kind || 'finding'), title: h.text },
      h.text,
      (h.kind || 'health').toUpperCase() + (h.fix ? ' · ' + h.fix : ''),
      now,
      { health: true },
    );
  }

  for (const t of openTypedThreads(threads)) {
    const type = String(meta(t).type || '').toLowerCase();
    push(type, t, t.title, type.toUpperCase() + (meta(t).origin ? ' · ' + meta(t).origin : '') + ' · open', t.mtime, { thread: true });
  }

  for (const s of specs || []) {
    if (String(meta(s).status || '').toLowerCase() === 'blocked') {
      push('blocked', s, s.title, 'BLOCKED · idle', s.mtime);
    }
  }

  for (const s of specs || []) {
    if (s.stage === 'done' && !s.feedback && meta(s).type !== 'research') {
      push('feedback', s, s.title + ' — FEEDBACK not written', 'FEEDBACK', s.mtime);
    }
  }

  // NOTES.md on in-progress outranks plain idle — surface even before the idle threshold
  for (const s of specs || []) {
    if (s.stage !== 'in-progress') continue;
    if (s.notes) {
      const kicked = /kicked back/i.test(String(s.notes));
      push('notes', s, s.title + (kicked ? ' — kickback note' : ' — has NOTES'), kicked ? 'KICKBACK' : 'NOTES', s.mtime);
    } else if (now - (s.mtime || 0) > idleMs) {
      push('idle', s, s.title + ' — stalled?', 'IDLE', s.mtime);
    }
  }

  for (const s of specs || []) {
    if (s.stage === 'triage' && now - (s.mtime || 0) > triageMs) {
      push('triage', s, s.title + ' — promote or kill?', 'TRIAGE', s.mtime);
    }
  }

  for (const s of specs || []) {
    if (s.stage === 'in-review') {
      push('review', s, s.title + ' — awaiting your sign-off', 'REVIEW', s.mtime);
    }
  }

  for (const s of specs || []) {
    if (s.stage === 'done' && meta(s).type === 'research') {
      push('research', s, String(s.title || '').replace(/^Research:\s*/i, '') + ' — recommendation ready', 'RESEARCH', s.mtime);
    }
  }

  const goal = topGoal(goals);
  if (goal && isGoalStarving(goal, { specs, intents })) {
    push('starving', { ...goal, _goal: true }, (goal.description || goal.id) + ' — no active work', 'GOAL · starving', 0, { goal: true });
  }

  for (const it of intents || []) {
    if (!isIntentStarving(it, specs)) continue;
    // skip if already covered by top-goal starving for the same intent's only goal
    const its = (specs || []).filter(s => normPath(meta(s).intent) === normPath(it.path));
    const doneN = its.filter(s => s.stage === 'done').length;
    push('starving', it, it.title + ' — no active work', its.length ? `INTENT · ${doneN}/${its.length} specs done` : 'INTENT · not yet decomposed', 0, { intent: true });
  }

  return loops;
}

/**
 * Rank open loops by impact (skill): (1) blocking in-focus, (2) starving top goal,
 * (3) NOTES/kickback before plain idle, then severity, then oldest first.
 */
function rankOpenLoops(loops, { focusItem = null, topGoalId = null } = {}) {
  const focusPath = focusItem && focusItem.path ? focusItem.path : null;
  const focusSlug = focusPath ? slugOf(focusPath) : null;

  const blocksFocus = (l) => {
    if (!focusPath || !l.thread) return false;
    return threadBlocksSpec(l.item, { path: focusPath });
  };

  const starvesTop = (l) => {
    if (l.kind !== 'starving') return false;
    if (l.goal && topGoalId && String(l.item.id) === String(topGoalId)) return true;
    if (l.intent && topGoalId) {
      return (meta(l.item).goals || []).map(String).includes(String(topGoalId));
    }
    return !!l.goal;
  };

  // Base severity after the three impact overrides (lower = more urgent)
  const SEV = {
    notes: 0, review: 1, research: 2, risk: 3, starving: 4,
    question: 5, blocked: 6, idle: 7, feedback: 8, decision: 9, triage: 10,
  };

  return loops.slice().sort((a, b) => {
    const a0 = blocksFocus(a) ? 0 : 1;
    const b0 = blocksFocus(b) ? 0 : 1;
    if (a0 !== b0) return a0 - b0;
    const a1 = starvesTop(a) ? 0 : 1;
    const b1 = starvesTop(b) ? 0 : 1;
    if (a1 !== b1) return a1 - b1;
    // NOTES/kickback before plain idle (also encoded in SEV, but keep explicit)
    const aNotes = a.kind === 'notes' ? 0 : 1;
    const bNotes = b.kind === 'notes' ? 0 : 1;
    if (aNotes !== bNotes) return aNotes - bNotes;
    const sa = SEV[a.kind] ?? 50;
    const sb = SEV[b.kind] ?? 50;
    if (sa !== sb) return sa - sb;
    return (a.age || 0) - (b.age || 0);
  });
}

/** Cap after rank — skill + UI share the ≤3 "needs you now" ceiling. */
function selectOpenLoops(loops, ctx, cap = 3) {
  const ranked = rankOpenLoops(loops, ctx);
  // Drop the hero item if it already appears as a loop (avoid duplicating the ask)
  const focus = ctx && ctx.focusItem;
  const filtered = focus
    ? ranked.filter(l => {
        if (l.item === focus) return false;
        if (focus.path && l.item && pathsMatch(l.item.path, focus.path)) return false;
        if (focus.id && l.goal && String(l.item.id) === String(focus.id)) return false;
        return true;
      })
    : ranked;
  return { shown: filtered.slice(0, cap), rest: filtered.slice(cap), ranked: filtered };
}

return {
  chooseRecommendedNext,
  collectOpenLoops,
  rankOpenLoops,
  selectOpenLoops,
  isGoalStarving,
  isIntentStarving,
  topGoal,
  sortedReady,
  pathsMatch,
  ACTIVE,
  DAY,
};
});

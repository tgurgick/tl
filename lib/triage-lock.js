'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TRIAGE_LOCK_TIMEOUT_MINUTES = 15;

function triageLockPath(wsDir) {
  return path.join(wsDir, '_metrics', 'locks', 'triage.lock');
}

// Content is diagnostic only; mtime decides staleness, matching worker locks.
function checkTriageLock(wsDir, { nowMs = Date.now(), timeoutMinutes = DEFAULT_TRIAGE_LOCK_TIMEOUT_MINUTES } = {}) {
  const file = triageLockPath(wsDir);
  let st;
  try { st = fs.statSync(file); } catch { return { state: 'free', file }; }
  const ageMinutes = (nowMs - st.mtimeMs) / 60000;
  return { state: ageMinutes < timeoutMinutes ? 'held' : 'stale', file, ageMinutes: Math.round(ageMinutes) };
}

function acquireTriageLock(wsDir, { lane = 'unknown', nowMs = Date.now(), timeoutMinutes = DEFAULT_TRIAGE_LOCK_TIMEOUT_MINUTES } = {}) {
  const file = triageLockPath(wsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ lane, acquired_at: new Date(nowMs).toISOString() }) + '\n'); }
      finally { fs.closeSync(fd); }
      fs.utimesSync(file, new Date(nowMs), new Date(nowMs));
      return { state: attempt ? 'taken-over' : 'acquired', file, lane };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      const current = checkTriageLock(wsDir, { nowMs, timeoutMinutes });
      if (current.state === 'held') return current;
      try { fs.unlinkSync(file); } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  return checkTriageLock(wsDir, { nowMs, timeoutMinutes });
}

function touchTriageLock(wsDir, { nowMs = Date.now() } = {}) {
  const file = triageLockPath(wsDir);
  fs.utimesSync(file, new Date(nowMs), new Date(nowMs));
  return { state: 'touched', file };
}

function releaseTriageLock(wsDir) {
  const file = triageLockPath(wsDir);
  try { fs.unlinkSync(file); } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return { state: 'released', file };
}

module.exports = {
  DEFAULT_TRIAGE_LOCK_TIMEOUT_MINUTES,
  triageLockPath, checkTriageLock, acquireTriageLock, touchTriageLock, releaseTriageLock,
};

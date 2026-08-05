/**
 * blocker/sessionManager.js
 * Tamper-resistant session timing.
 *
 * Two anchors are stored:
 *   endWallMs   — Date.now() + duration. Survives restarts, but the user can
 *                 cheat it by moving the system clock forward.
 *   uptimeAtStart / endUptimeSec — os.uptime() based. Immune to clock changes,
 *                 but resets to ~0 on reboot.
 *
 * Rule: if os.uptime() >= uptimeAtStart there was NO reboot, so trust the
 * uptime anchor and ignore the wall clock entirely (clock tampering does
 * nothing). If uptime went backwards, a reboot happened, so fall back to the
 * wall clock, capped at the original duration.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR  = path.join(os.homedir(), 'AppData', 'Local', 'StrictFocus');
const DATA_FILE = path.join(DATA_DIR, 'session.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function save(d) { ensureDir(); fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return null; }
}

function startSession(durationMs, whitelist) {
  const uptimeSec = Math.floor(os.uptime());
  const data = {
    active:        true,
    durationMs,
    whitelist,
    startEpoch:    Date.now(),
    endWallMs:     Date.now() + durationMs,
    uptimeAtStart: uptimeSec,
    endUptimeSec:  uptimeSec + Math.ceil(durationMs / 1000)
  };
  save(data);
  return data;
}

function getRemainingMs() {
  const d = load();
  if (!d || !d.active) return 0;

  const nowUptime = Math.floor(os.uptime());
  let remaining;

  if (nowUptime >= d.uptimeAtStart) {
    remaining = (d.endUptimeSec - nowUptime) * 1000;   // no reboot: trust uptime
  } else {
    remaining = d.endWallMs - Date.now();              // rebooted: wall clock
  }

  return Math.max(0, Math.min(remaining, d.durationMs));
}

function isActive() {
  const d = load();
  return !!(d && d.active && getRemainingMs() > 0);
}

function getSession() { return load(); }

function endSession() {
  const d = load();
  if (d) { d.active = false; d.endedAt = Date.now(); save(d); }
}

function clear() { try { if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE); } catch {} }

module.exports = { startSession, getRemainingMs, isActive, getSession, endSession, clear };

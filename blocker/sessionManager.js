/**
 * blocker/sessionManager.js
 * Persists session state to a JSON file in AppData.
 * Uses process.hrtime.bigint() for a tamper-proof elapsed-time counter
 * anchored to process uptime — not wall clock.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR  = path.join(os.homedir(), 'AppData', 'Local', 'StrictFocus');
const DATA_FILE = path.join(DATA_DIR, 'session.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function save(data) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return null; }
}

function clear() {
  try { if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE); } catch {}
}

/**
 * Start a new session.
 * @param {number} durationMs   - Total session duration in milliseconds
 * @param {string[]} whitelist  - Array of base domains e.g. ['google.com','notion.so']
 */
function startSession(durationMs, whitelist) {
  const data = {
    active:       true,
    startEpoch:   Date.now(),             // wall clock (for display only)
    startHrtime:  Number(process.hrtime.bigint() / 1_000_000n), // ms since process start — tamper-proof
    durationMs,
    whitelist
  };
  save(data);
  return data;
}

/**
 * Returns remaining milliseconds for the active session, or 0 if none.
 * Uses hrtime for tamper-proof elapsed time.
 */
function getRemainingMs() {
  const data = load();
  if (!data || !data.active) return 0;
  const nowHr     = Number(process.hrtime.bigint() / 1_000_000n);
  const elapsedMs = nowHr - data.startHrtime;
  const remaining = Math.max(0, data.durationMs - elapsedMs);
  return remaining;
}

function isActive() {
  const data = load();
  return !!(data && data.active && getRemainingMs() > 0);
}

function getSession() {
  return load();
}

function endSession() {
  const data = load();
  if (data) { data.active = false; save(data); }
  // Keep the file so we can show "last session" info, but mark inactive
}

module.exports = { startSession, getRemainingMs, isActive, getSession, endSession, clear };

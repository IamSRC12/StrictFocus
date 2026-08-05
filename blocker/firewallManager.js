/**
 * blocker/firewallManager.js
 * Controls Windows Firewall rules via `netsh advfirewall`.
 *
 * Strategy:
 *   1. Block ALL outbound TCP traffic on ports 80 and 443 (HTTP + HTTPS)
 *   2. Block ALL outbound UDP traffic on port 53 (DNS) except to 127.0.0.1
 *   3. Add individual ALLOW rules for each resolved IP in the whitelist
 *
 * Rule naming convention:
 *   StrictFocus_BLOCK_HTTP          — blocks port 80 outbound
 *   StrictFocus_BLOCK_HTTPS         — blocks port 443 outbound
 *   StrictFocus_BLOCK_DNS           — blocks UDP 53 outbound
 *   StrictFocus_ALLOW_{ip_safe}     — allows specific IP (dots → underscores)
 *
 * All rules are removed when the session ends (or the app restores on next launch).
 *
 * IMPORTANT: Requires the app to run as Administrator.
 */

const { execSync, exec } = require('child_process');

const RULE_PREFIX       = 'StrictFocus_';
const RULE_BLOCK_HTTP   = 'StrictFocus_BLOCK_HTTP';
const RULE_BLOCK_HTTPS  = 'StrictFocus_BLOCK_HTTPS';
const RULE_BLOCK_DNS    = 'StrictFocus_BLOCK_DNS';
const WATCHDOG_INTERVAL = 30_000; // Re-apply rules every 30 seconds as anti-bypass

let watchdogTimer = null;
let currentAllowedIps = new Set();

// ─── Low-level netsh helpers ───────────────────────────────────────────────────

function runNetsh(args) {
  try {
    execSync(`netsh ${args}`, { stdio: 'pipe', windowsHide: true });
    return true;
  } catch (e) {
    console.error(`netsh failed: ${args}\n${e.message}`);
    return false;
  }
}

function addBlockRule(name, protocol, port) {
  // Delete first to avoid duplicates
  runNetsh(`advfirewall firewall delete rule name="${name}"`);
  return runNetsh(
    `advfirewall firewall add rule name="${name}" ` +
    `dir=out action=block protocol=${protocol} remoteport=${port} enable=yes`
  );
}

function addAllowRule(ip) {
  const safeName = `${RULE_PREFIX}ALLOW_${ip.replace(/\./g, '_')}`;
  runNetsh(`advfirewall firewall delete rule name="${safeName}"`);
  return runNetsh(
    `advfirewall firewall add rule name="${safeName}" ` +
    `dir=out action=allow protocol=TCP remoteip=${ip} remoteport=80,443 enable=yes`
  );
}

function deleteAllowRule(ip) {
  const safeName = `${RULE_PREFIX}ALLOW_${ip.replace(/\./g, '_')}`;
  runNetsh(`advfirewall firewall delete rule name="${safeName}"`);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Applies all firewall rules for a new session.
 * @param {Set<string>} allowedIps - IP addresses to whitelist
 */
function applyRules(allowedIps) {
  currentAllowedIps = new Set(allowedIps);

  // Block all outbound HTTP + HTTPS + DNS
  addBlockRule(RULE_BLOCK_HTTP,  'TCP', '80');
  addBlockRule(RULE_BLOCK_HTTPS, 'TCP', '443');
  addBlockRule(RULE_BLOCK_DNS,   'UDP', '53');

  // Allow whitelisted IPs
  for (const ip of allowedIps) {
    addAllowRule(ip);
  }

  console.log(`[Firewall] Applied: blocked HTTP/HTTPS/DNS, allowed ${allowedIps.size} IPs`);
}

/**
 * Adds new allowed IPs discovered during runtime (e.g., from in-session DNS).
 * @param {Set<string>} newIps
 */
function addAllowedIps(newIps) {
  for (const ip of newIps) {
    if (!currentAllowedIps.has(ip)) {
      currentAllowedIps.add(ip);
      addAllowRule(ip);
    }
  }
}

/**
 * Removes ALL StrictFocus firewall rules (call on session end).
 */
function removeAllRules() {
  stopWatchdog();

  // Delete block rules
  runNetsh(`advfirewall firewall delete rule name="${RULE_BLOCK_HTTP}"`);
  runNetsh(`advfirewall firewall delete rule name="${RULE_BLOCK_HTTPS}"`);
  runNetsh(`advfirewall firewall delete rule name="${RULE_BLOCK_DNS}"`);

  // Delete all allow rules
  for (const ip of currentAllowedIps) {
    deleteAllowRule(ip);
  }

  // Belt-and-suspenders: delete ANY rule with our prefix
  try {
    execSync(
      `powershell -Command "Get-NetFirewallRule -DisplayName 'StrictFocus_*' | Remove-NetFirewallRule"`,
      { stdio: 'pipe', windowsHide: true }
    );
  } catch {}

  currentAllowedIps.clear();
  console.log('[Firewall] All StrictFocus rules removed.');
}

/**
 * Checks if our blocking rules are still active (anti-tamper).
 * Returns true if all core block rules exist.
 */
function verifyRulesActive() {
  try {
    const output = execSync(
      `netsh advfirewall firewall show rule name="${RULE_BLOCK_HTTPS}"`,
      { stdio: 'pipe', windowsHide: true }
    ).toString();
    return output.includes('Enabled') && output.includes('Yes');
  } catch {
    return false;
  }
}

/**
 * Starts the watchdog that re-applies rules if they're removed.
 * @param {Set<string>} allowedIps
 */
function startWatchdog(allowedIps) {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!verifyRulesActive()) {
      console.warn('[Watchdog] Rules were removed! Re-applying...');
      applyRules(allowedIps);
    }
  }, WATCHDOG_INTERVAL);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Checks if the process has admin privileges (needed for netsh).
 * @returns {boolean}
 */
function isRunningAsAdmin() {
  try {
    execSync('net session', { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  applyRules,
  addAllowedIps,
  removeAllRules,
  verifyRulesActive,
  startWatchdog,
  stopWatchdog,
  isRunningAsAdmin
};

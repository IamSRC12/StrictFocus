/**
 * blocker/firewallManager.js
 * Blocks known DNS-over-HTTPS (DoH) servers on port 443 via Windows Firewall rules.
 *
 * ARCHITECTURE NOTE:
 * - Leaves Windows Firewall DefaultOutboundAction as 'Allow' (default behavior).
 * - Creates explicit OUTBOUND BLOCK rules targeting known DoH resolver IPs on TCP/UDP port 443.
 * - This prevents modern browsers (Chrome, Edge, Brave) from bypassing system DNS via DoH,
 *   forcing them to fallback to 127.0.0.1 (StrictFocus DNS Proxy).
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PREFIX      = 'StrictFocus_';
const DATA_DIR    = path.join(os.homedir(), 'AppData', 'Local', 'StrictFocus');
const RESTORE_BAT = path.join(DATA_DIR, 'RESTORE_INTERNET.bat');
const STATE_FILE  = path.join(DATA_DIR, 'firewall-state.json');
const TASK_NAME   = 'StrictFocusFailsafe';

let watchdog = null;
let isActive = false;

// Known DNS-over-HTTPS (DoH) server IPs
const DOH_IPS = [
  // Cloudflare
  '1.1.1.1', '1.0.0.1', '1.1.1.2', '1.0.0.2', '1.1.1.3', '1.0.0.3',
  // Google
  '8.8.8.8', '8.8.4.4',
  // Quad9
  '9.9.9.9', '149.112.112.112', '9.9.9.10', '149.112.112.10',
  // OpenDNS
  '208.67.222.222', '208.67.220.220', '208.67.222.220', '208.67.220.222',
  // AdGuard
  '94.140.14.14', '94.140.15.15', '94.140.14.140', '94.140.14.141',
  // NextDNS / Control D / CleanBrowsing / Comcast
  '45.90.28.0', '45.90.30.0', '76.76.2.0', '76.76.10.0', '185.228.168.9', '185.228.169.9', '68.87.64.19', '68.87.68.19'
];

// ─── PowerShell Helper ────────────────────────────────────────────────────────

function psRun(script, { quiet = false } = {}) {
  ensureDir();
  const file = path.join(os.tmpdir(), `sf_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`,
      { stdio: 'pipe', windowsHide: true, timeout: 90_000 }
    ).toString();
  } catch (e) {
    if (!quiet) console.error('[PS ERROR]', (e.stderr && e.stderr.toString()) || e.message);
    return '';
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Emergency Restore Script & Failsafe ─────────────────────────────────────

function writeRestoreScript() {
  ensureDir();
  const bat = `@echo off
REM StrictFocus emergency network restore. Run as Administrator.
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName '${PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"
powershell -NoProfile -Command "Get-NetAdapter | Where-Object Status -eq 'Up' | Set-DnsClientServerAddress -ResetServerAddresses"
powershell -NoProfile -Command "Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue"
ipconfig /flushdns >nul
echo Internet access restored.
`;
  fs.writeFileSync(RESTORE_BAT, bat, 'utf8');
  return RESTORE_BAT;
}

function registerFailsafe(minutesFromNow) {
  const mins = Math.max(2, Math.ceil(minutesFromNow) + 3);
  psRun(`
$ErrorActionPreference='SilentlyContinue'
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false
$act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c ""${RESTORE_BAT}""'
$trg = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(${mins}))
$pr  = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $act -Trigger $trg -Principal $pr -Force | Out-Null
`, { quiet: true });
}

function clearFailsafe() {
  psRun(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`, { quiet: true });
}

// ─── Rule Construction ───────────────────────────────────────────────────────

function clearRules() {
  psRun(`Get-NetFirewallRule -DisplayName '${PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`, { quiet: true });
}

/**
 * Creates outbound BLOCK rules for known DoH server IPs on TCP and UDP port 443.
 */
function blockDohServers() {
  const dohList = DOH_IPS.map(ip => `'${ip}'`).join(',');
  psRun(`
$ErrorActionPreference='SilentlyContinue'
$addrs = @(${dohList})
New-NetFirewallRule -DisplayName '${PREFIX}BLOCK_DOH_TCP' -Direction Outbound -Action Block -Protocol TCP -RemotePort 443 -RemoteAddress $addrs | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}BLOCK_DOH_UDP' -Direction Outbound -Action Block -Protocol UDP -RemotePort 443 -RemoteAddress $addrs | Out-Null
`);
  console.log(`[Firewall] Created block rules for ${DOH_IPS.length} DoH resolver IPs on port 443.`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Applies DoH block rules in Windows Firewall.
 * @param {object} opts
 * @param {number} opts.durationMinutes - for the failsafe scheduled task
 */
function applyRules(opts = {}) {
  const { durationMinutes = 60 } = opts;

  ensureDir();
  writeRestoreScript();

  fs.writeFileSync(STATE_FILE, JSON.stringify({ active: true, ts: Date.now() }, null, 2));

  clearRules();
  blockDohServers();

  registerFailsafe(durationMinutes);
  isActive = true;
  startWatchdog();
  console.log('[Firewall] DoH blocking ACTIVE.');
}

function removeAllRules() {
  stopWatchdog();
  isActive = false;

  clearRules();
  clearFailsafe();

  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch {}
  console.log('[Firewall] Removed StrictFocus firewall rules.');
}

/** True if the StrictFocus DoH block rules exist in Windows Firewall. */
function verifyRulesActive() {
  const out = psRun(
    `$r = (Get-NetFirewallRule -DisplayName '${PREFIX}BLOCK_DOH_*' -ErrorAction SilentlyContinue | Measure-Object).Count
"$r"`,
    { quiet: true }
  ).trim();
  const count = parseInt(out, 10);
  return !isNaN(count) && count > 0;
}

function startWatchdog() {
  stopWatchdog();
  watchdog = setInterval(() => {
    if (!isActive) return;
    if (!verifyRulesActive()) {
      console.warn('[Watchdog] DoH block rules missing — re-applying.');
      blockDohServers();
    }
  }, 20_000);
}

function stopWatchdog() {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
}

/** Called at app startup: undo a stranded lockdown left by a crash. */
function recoverIfStranded(sessionStillActive) {
  const stranded = fs.existsSync(STATE_FILE);
  if (stranded && !sessionStillActive) {
    console.warn('[Firewall] Found stranded state from a previous run. Restoring.');
    removeAllRules();
    return true;
  }
  return false;
}

function isRunningAsAdmin() {
  try {
    execSync('net session', { stdio: 'pipe', windowsHide: true });
    return true;
  } catch { return false; }
}

module.exports = {
  applyRules, removeAllRules, verifyRulesActive,
  startWatchdog, stopWatchdog, isRunningAsAdmin,
  recoverIfStranded, writeRestoreScript,
  get restoreScriptPath() { return RESTORE_BAT; }
};


/**
 * blocker/firewallManager.js
 *
 * Strategy: Default-deny outbound + explicit allow-list.
 *
 *   applyRules()       → lockdown() + blockDohServers() + disableBrowserDoh()
 *   allowIps(ips)      → upserts ALLOW_WEB_* rules with resolved IPs (called live by dnsProxy)
 *   removeAllRules()   → unlock() + clear rules + re-enable browser DoH
 *   RESTORE_INTERNET.bat → always starts with unlock so a crash doesn't strand the machine.
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

const CHUNK = 400;       // max IPs per firewall rule (PowerShell limit)
let allowedIps = new Set();
let watchdog   = null;
let isActive   = false;

// Known DNS-over-HTTPS / DNS-over-TLS server IPs to blackhole
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
  '45.90.28.0', '45.90.30.0', '76.76.2.0', '76.76.10.0',
  '185.228.168.9', '185.228.169.9', '68.87.64.19', '68.87.68.19'
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
REM Step 1: ALWAYS restore default-allow first (critical if app crashed during lockdown)
powershell -NoProfile -Command "Set-NetFirewallProfile -All -DefaultOutboundAction Allow -DefaultInboundAction Block"
REM Step 2: Remove all StrictFocus firewall rules
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName '${PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"
REM Step 3: Restore system DNS
powershell -NoProfile -Command "Get-NetAdapter | Where-Object Status -eq 'Up' | Set-DnsClientServerAddress -ResetServerAddresses"
REM Step 4: Remove browser DoH policy keys (Chrome, Edge, Firefox)
powershell -NoProfile -Command "Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' -Recurse -Force -ErrorAction SilentlyContinue"
powershell -NoProfile -Command "Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Recurse -Force -ErrorAction SilentlyContinue"
powershell -NoProfile -Command "Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS' -Recurse -Force -ErrorAction SilentlyContinue"
REM Step 5: Remove failsafe task
powershell -NoProfile -Command "Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue"
ipconfig /flushdns >nul
echo Internet access fully restored.
pause
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

// ─── Lockdown & Unlock ───────────────────────────────────────────────────────

/**
 * Sets Windows Firewall to default-deny outbound, then creates allow rules for:
 *   - This app's own process (so it can reach DNS resolver + Groq API)
 *   - Loopback (127.0.0.1 + ::1)
 *   - LAN subnet (LocalSubnet)
 *   - DHCP (UDP 67/68)
 */
function lockdown(selfExe) {
  const exePath = selfExe.replace(/\\/g, '\\\\');
  psRun(`
$ErrorActionPreference='Stop'
Set-NetFirewallProfile -All -DefaultOutboundAction Block -DefaultInboundAction Block
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_SELF'     -Direction Outbound -Action Allow -Program '${exePath}' | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_LOOPBACK' -Direction Outbound -Action Allow -RemoteAddress '127.0.0.1','::1' | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_LAN'      -Direction Outbound -Action Allow -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_DHCP'     -Direction Outbound -Action Allow -Protocol UDP -RemotePort 67,68 | Out-Null
`);
  console.log('[Firewall] Lockdown ACTIVE — default-deny outbound.');
}

/** Reverts Windows Firewall back to default-allow outbound. */
function unlock() {
  psRun(`Set-NetFirewallProfile -All -DefaultOutboundAction Allow -DefaultInboundAction Block`);
  allowedIps.clear();
  console.log('[Firewall] Default-allow restored.');
}

// ─── Dynamic IP Allow-List ───────────────────────────────────────────────────

/**
 * Adds IPs to the running allow-list and upserts ALLOW_WEB_* firewall rules.
 * Called at session start with pre-warmed IPs, and live from dnsProxy's onNewIps callback.
 * @param {string[]} ips  Array of IPv4 address strings.
 */
function allowIps(ips) {
  if (!ips || ips.length === 0) return;
  ips.forEach(ip => allowedIps.add(ip));

  const all    = [...allowedIps];
  const chunks = [];
  for (let i = 0; i < all.length; i += CHUNK) chunks.push(all.slice(i, i + CHUNK));

  const script = chunks.map((c, i) => {
    const list  = c.map(ip => `'${ip}'`).join(',');
    const name  = `${PREFIX}ALLOW_WEB_${i}`;
    const nameQ = `${PREFIX}ALLOW_WEB_${i}_Q`;
    return `
$r = Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue
if ($r) {
  Set-NetFirewallRule -DisplayName '${name}'  -RemoteAddress @(${list})
  Set-NetFirewallRule -DisplayName '${nameQ}' -RemoteAddress @(${list})
} else {
  New-NetFirewallRule -DisplayName '${name}'  -Direction Outbound -Action Allow \`
    -Protocol TCP -RemotePort 80,443 -RemoteAddress @(${list}) | Out-Null
  New-NetFirewallRule -DisplayName '${nameQ}' -Direction Outbound -Action Allow \`
    -Protocol UDP -RemotePort 443   -RemoteAddress @(${list}) | Out-Null
}`;
  }).join('\n');

  psRun(`$ErrorActionPreference='SilentlyContinue'\n${script}`);
  console.log(`[Firewall] Allow-list updated: ${allowedIps.size} IPs across ${chunks.length} rule(s).`);
}

// ─── DoH Server Blocking ─────────────────────────────────────────────────────

function blockDohServers() {
  const dohList = DOH_IPS.map(ip => `'${ip}'`).join(',');
  psRun(`
$ErrorActionPreference='SilentlyContinue'
$addrs = @(${dohList})
New-NetFirewallRule -DisplayName '${PREFIX}BLOCK_DOH_TCP' -Direction Outbound -Action Block -Protocol TCP -RemotePort 443 -RemoteAddress $addrs | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}BLOCK_DOH_UDP' -Direction Outbound -Action Block -Protocol UDP -RemotePort 443 -RemoteAddress $addrs | Out-Null
`);
  console.log(`[Firewall] Created block rules for ${DOH_IPS.length} DoH resolver IPs.`);
}

// ─── Browser DoH Policy ───────────────────────────────────────────────────────

/**
 * Writes Group Policy registry keys to disable DoH in Chrome, Edge, and Firefox.
 * NOTE: Browser must be restarted for policy to take effect and drop its internal host cache.
 */
function disableBrowserDoh() {
  psRun(`
$ErrorActionPreference='SilentlyContinue'
New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' -Force | Out-Null
Set-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' -Name DnsOverHttpsMode -Value 'off'
New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Force | Out-Null
Set-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' -Name DnsOverHttpsMode -Value 'off'
New-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS' -Force | Out-Null
Set-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS' -Name Enabled -Value 0 -Type DWord
Set-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS' -Name Locked  -Value 1 -Type DWord
`);
  console.log('[Firewall] Browser DoH disabled via Group Policy. Restart browser to apply.');
}

function enableBrowserDoh() {
  psRun(`
$ErrorActionPreference='SilentlyContinue'
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome'                 -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'                -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path 'HKLM:\\SOFTWARE\\Policies\\Mozilla\\Firefox\\DNSOverHTTPS' -Recurse -Force -ErrorAction SilentlyContinue
`, { quiet: true });
}

// ─── Rule Management ─────────────────────────────────────────────────────────

function clearRules() {
  psRun(`Get-NetFirewallRule -DisplayName '${PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`, { quiet: true });
}

// ─── Public API ──────────────────────────────────────────────────────────────

function applyRules(opts = {}) {
  const { durationMinutes = 60 } = opts;

  ensureDir();
  writeRestoreScript();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ active: true, ts: Date.now() }, null, 2));

  clearRules();
  lockdown(process.execPath);
  blockDohServers();
  disableBrowserDoh();

  registerFailsafe(durationMinutes);
  isActive = true;
  startWatchdog();
  console.log('[Firewall] Full lockdown ACTIVE.');
}

function removeAllRules() {
  stopWatchdog();
  isActive = false;

  // CRITICAL: unlock FIRST so the machine is not left with no internet
  unlock();
  clearRules();
  enableBrowserDoh();
  clearFailsafe();

  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch {}
  console.log('[Firewall] All StrictFocus restrictions removed.');
}

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
  applyRules, removeAllRules, allowIps, verifyRulesActive,
  startWatchdog, stopWatchdog, isRunningAsAdmin,
  recoverIfStranded, writeRestoreScript,
  get restoreScriptPath() { return RESTORE_BAT; }
};



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


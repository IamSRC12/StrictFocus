/**
 * blocker/firewallManager.js
 * Whitelist-only outbound networking via Windows Firewall.
 *
 * CRITICAL ARCHITECTURE NOTE (Do NOT introduce block-rules-plus-allow-rules):
 * In the Windows Filtering Platform (WFP), at equal rule weight, BLOCK rules
 * ALWAYS take precedence over ALLOW rules. If you create a global block rule
 * for ports 80/443, ALLOW rules for whitelisted IPs are completely ignored and
 * all traffic is killed.
 *
 * THE ONLY WORKING APPROACH:
 *   1. Capture the machine's current DefaultOutboundAction per profile.
 *   2. Add ALLOW rules for infrastructure + whitelisted IPs.
 *   3. ONLY THEN flip DefaultOutboundAction to Block on all profiles.
 *   Anything without an explicit allow rule is now dropped, including DoH,
 *   QUIC, direct-IP access, and every other app on the machine.
 *
 * SAFETY: A RESTORE_INTERNET.bat is written to %LOCALAPPDATA%\StrictFocus
 * and a SYSTEM scheduled task is registered to run it shortly after the
 * session should end, so a crash/kill can never permanently brick the network.
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

let ruleIndex  = 0;
let appliedIps = new Set();
let watchdog   = null;
let isActive   = false;

// ─── PowerShell helper (script file avoids all quote-escaping hell) ──────────

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

// ─── Baseline capture / restore ──────────────────────────────────────────────

function captureBaseline() {
  const out = psRun(`Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.DefaultOutboundAction)" }`);
  const map = {};
  out.split(/\r?\n/).forEach(line => {
    const [name, action] = line.trim().split('=');
    if (name && action) map[name] = action;
  });
  // Windows default if the query failed for any reason
  if (!Object.keys(map).length) return { Domain: 'Allow', Private: 'Allow', Public: 'Allow' };
  return map;
}

function writeRestoreScript() {
  ensureDir();
  const bat = `@echo off
REM StrictFocus emergency network restore. Run as Administrator.
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName '${PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"
powershell -NoProfile -Command "Set-NetFirewallProfile -Name Domain,Private,Public -DefaultOutboundAction Allow"
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

// ─── Rule construction ───────────────────────────────────────────────────────

function clearRules() {
  psRun(`Get-NetFirewallRule -DisplayName '${PREFIX}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`, { quiet: true });
  appliedIps.clear();
  ruleIndex = 0;
}

/**
 * Rules that MUST exist or the machine loses basic connectivity — and our own
 * DNS proxy loses its ability to reach upstream resolvers.
 */
function addInfrastructureRules(appPath, upstreamDnsIps) {
  const dnsList = upstreamDnsIps.map(ip => `'${ip}'`).join(',');
  psRun(`
$ErrorActionPreference='SilentlyContinue'
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_LOOPBACK' -Direction Outbound -Action Allow -RemoteAddress 127.0.0.1 | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_LAN'      -Direction Outbound -Action Allow -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_DHCP'     -Direction Outbound -Action Allow -Protocol UDP -RemotePort 67,68 | Out-Null
New-NetFirewallRule -DisplayName '${PREFIX}ALLOW_SELF_DNS' -Direction Outbound -Action Allow -Program '${appPath}' -Protocol UDP -RemotePort 53 -RemoteAddress @(${dnsList}) | Out-Null
`);
}

/**
 * Adds allow rules for a batch of IPs. Windows chokes on huge address lists,
 * so we chunk. TCP 80/443 for HTTP(S), UDP 443 for HTTP/3.
 * Returns the number of newly-allowed IPs.
 */
function addAllowedIps(ips) {
  const fresh = [...ips].filter(ip => ip && !appliedIps.has(ip));
  if (!fresh.length) return 0;

  const CHUNK = 180;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const chunk = fresh.slice(i, i + CHUNK);
    const list  = chunk.map(ip => `'${ip}'`).join(',');
    const name  = `${PREFIX}ALLOW_IP_${++ruleIndex}`;
    psRun(`
$ErrorActionPreference='SilentlyContinue'
$addrs = @(${list})
New-NetFirewallRule -DisplayName '${name}'     -Direction Outbound -Action Allow -Protocol TCP -RemotePort 80,443 -RemoteAddress $addrs | Out-Null
New-NetFirewallRule -DisplayName '${name}_UDP' -Direction Outbound -Action Allow -Protocol UDP -RemotePort 443     -RemoteAddress $addrs | Out-Null
`, { quiet: true });
    chunk.forEach(ip => appliedIps.add(ip));
  }
  console.log(`[Firewall] +${fresh.length} IPs allowed (total ${appliedIps.size})`);
  return fresh.length;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {Set<string>|string[]} ips           resolved whitelist IPs
 * @param {object} opts
 * @param {string} opts.appPath                process.execPath
 * @param {string[]} opts.upstreamDnsIps       resolvers the DNS proxy may reach
 * @param {number} opts.durationMinutes        for the failsafe task
 */
function applyRules(ips, opts = {}) {
  const { appPath = process.execPath, upstreamDnsIps = ['1.1.1.1', '8.8.8.8'], durationMinutes = 60 } = opts;

  ensureDir();
  writeRestoreScript();

  const baseline = captureBaseline();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ baseline, active: true, ts: Date.now() }, null, 2));

  clearRules();
  addInfrastructureRules(appPath, upstreamDnsIps);
  addAllowedIps(ips);

  // Flip to deny-by-default LAST, so we never strand ourselves mid-setup.
  psRun(`Set-NetFirewallProfile -Name Domain,Private,Public -DefaultOutboundAction Block`);

  registerFailsafe(durationMinutes);
  isActive = true;
  startWatchdog();
  console.log('[Firewall] Whitelist-only mode ACTIVE.');
}

function removeAllRules() {
  stopWatchdog();
  isActive = false;

  let baseline = { Domain: 'Allow', Private: 'Allow', Public: 'Allow' };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s.baseline) baseline = s.baseline;
    }
  } catch {}

  // Restore default policy BEFORE deleting allow rules.
  const restoreLines = Object.entries(baseline)
    .map(([name, action]) => `Set-NetFirewallProfile -Name ${name} -DefaultOutboundAction ${action}`)
    .join('\n');
  psRun(`$ErrorActionPreference='SilentlyContinue'\n${restoreLines}`);

  clearRules();
  clearFailsafe();

  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch {}
  console.log('[Firewall] Restored normal networking.');
}

/** True only if all profiles are Block AND at least one allow rule exists. */
function verifyRulesActive() {
  const out = psRun(
    `$p = (Get-NetFirewallProfile | Where-Object DefaultOutboundAction -ne 'Block').Count
$r = (Get-NetFirewallRule -DisplayName '${PREFIX}ALLOW_IP_*' -ErrorAction SilentlyContinue | Measure-Object).Count
"$p|$r"`,
    { quiet: true }
  ).trim();
  const [nonBlock, ruleCount] = out.split('|').map(n => parseInt(n, 10));
  return nonBlock === 0 && ruleCount > 0;
}

function startWatchdog() {
  stopWatchdog();
  watchdog = setInterval(() => {
    if (!isActive) return;
    if (!verifyRulesActive()) {
      console.warn('[Watchdog] Firewall tampered with — re-applying.');
      psRun(`Set-NetFirewallProfile -Name Domain,Private,Public -DefaultOutboundAction Block`, { quiet: true });
      const ips = new Set(appliedIps);
      appliedIps.clear();
      ruleIndex = 0;
      addAllowedIps(ips);
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
    console.warn('[Firewall] Found stranded lockdown from a previous run. Restoring.');
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
  applyRules, addAllowedIps, removeAllRules, verifyRulesActive,
  startWatchdog, stopWatchdog, isRunningAsAdmin,
  recoverIfStranded, writeRestoreScript,
  get restoreScriptPath() { return RESTORE_BAT; }
};

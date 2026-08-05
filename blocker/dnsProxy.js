/**
 * blocker/dnsProxy.js
 * Local DNS Interceptor & Filtering Engine for StrictFocus Desktop.
 *
 * How it works:
 *  1. Runs a lightweight DNS server on 127.0.0.1:53 using Node dgram.
 *  2. Points Windows network adapters to 127.0.0.1 as primary DNS.
 *  3. Flushes Windows DNS cache (ipconfig /flushdns).
 *  4. Intercepts all incoming DNS queries:
 *     - If domain is in whitelist or is a subdomain (e.g., static.pw.live for pw.live):
 *       Forwards query to upstream DNS (1.1.1.1 / 8.8.8.8), returns real IP to client.
 *     - If domain is NOT in whitelist:
 *       Immediately returns NXDOMAIN (RCODE 3). Browser gets instant connection refused.
 *  5. Blocks DNS-over-HTTPS (DoH) IPs in Windows Firewall to prevent browser DoH bypass.
 */

const dgram = require('dgram');
const { execSync, exec } = require('child_process');

let server = null;
let currentWhitelist = [];
let watchdogTimer = null;
let isProxyActive = false;

// Known public DoH / DoT resolver IPs to block in Firewall so browsers don't bypass local DNS
const DOH_IPS = [
  '1.1.1.1', '1.0.0.1', '1.1.1.2', '1.0.0.2', // Cloudflare
  '8.8.8.8', '8.8.4.4',                       // Google
  '9.9.9.9', '149.112.112.112',               // Quad9
  '208.67.222.222', '208.67.220.220',         // OpenDNS
  '94.140.14.14', '94.140.15.15'              // AdGuard
];

const DOH_RULE_NAME = 'StrictFocus_BLOCK_DOH';

// ─── DNS Packet Helpers ────────────────────────────────────────────────────────

function parseDomain(buf) {
  try {
    let offset = 12;
    const parts = [];
    while (offset < buf.length && buf[offset] !== 0) {
      const len = buf[offset];
      if ((len & 0xC0) === 0xC0) break; // compression pointer
      parts.push(buf.toString('utf8', offset + 1, offset + 1 + len));
      offset += 1 + len;
    }
    return parts.join('.').toLowerCase();
  } catch {
    return '';
  }
}

function isWhitelisted(domain, list) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return list.some(w => {
    const base = w.toLowerCase().trim();
    return d === base || d.endsWith('.' + base);
  });
}

function makeNxdomain(reqBuf) {
  const res = Buffer.from(reqBuf);
  if (res.length >= 4) {
    res[2] = 0x81; // Flags byte 1: Response + Recursion Desired
    res[3] = 0x83; // Flags byte 2: Recursion Available + RCODE 3 (NXDOMAIN)
  }
  return res;
}

// ─── Local DNS Proxy Server ───────────────────────────────────────────────────

function startDnsServer(whitelist) {
  stopDnsServer();
  currentWhitelist = [...whitelist];

  server = dgram.createSocket('udp4');

  server.on('message', (msg, rinfo) => {
    const domain = parseDomain(msg);
    const allowed = isWhitelisted(domain, currentWhitelist);

    if (!allowed) {
      // Blocked domain: reply with NXDOMAIN immediately
      try {
        server.send(makeNxdomain(msg), rinfo.port, rinfo.address);
      } catch {}
    } else {
      // Whitelisted domain: forward to 1.1.1.1 (Cloudflare) or 8.8.8.8 (Google)
      const upstream = dgram.createSocket('udp4');
      const targetDns = (Math.random() > 0.5) ? '1.1.1.1' : '8.8.8.8';

      upstream.send(msg, 53, targetDns, (err) => {
        if (err) {
          try { upstream.close(); } catch {}
        }
      });

      upstream.on('message', (reply) => {
        try {
          server.send(reply, rinfo.port, rinfo.address);
        } catch {}
        try { upstream.close(); } catch {}
      });

      upstream.on('error', () => {
        try { upstream.close(); } catch {}
      });

      // Timeout safety
      setTimeout(() => {
        try { upstream.close(); } catch {}
      }, 3000);
    }
  });

  server.on('error', (err) => {
    console.error('[DNS Proxy Error]:', err.message);
  });

  server.bind(53, '127.0.0.1', () => {
    console.log('[DNS Proxy] Server listening on 127.0.0.1:53');
  });
}

function stopDnsServer() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
}

// ─── Windows Network Adapter & Firewall Controls ──────────────────────────────

function setSystemDnsToLocal() {
  try {
    const psCmd = `Get-NetAdapter | Where-Object Status -eq 'Up' | Set-DnsClientServerAddress -ServerAddresses ("127.0.0.1")`;
    execSync(`powershell -Command "${psCmd}"`, { stdio: 'pipe', windowsHide: true });
    execSync('ipconfig /flushdns', { stdio: 'pipe', windowsHide: true });
    console.log('[DNS System] Set system DNS to 127.0.0.1');
  } catch (e) {
    console.error('[DNS System] Failed to set local DNS:', e.message);
  }
}

function resetSystemDns() {
  try {
    const psCmd = `Get-NetAdapter | Where-Object Status -eq 'Up' | Set-DnsClientServerAddress -ResetServerAddresses`;
    execSync(`powershell -Command "${psCmd}"`, { stdio: 'pipe', windowsHide: true });
    execSync('ipconfig /flushdns', { stdio: 'pipe', windowsHide: true });
    console.log('[DNS System] Reset system DNS to default');
  } catch (e) {
    console.error('[DNS System] Failed to reset DNS:', e.message);
  }
}

function blockDoHInFirewall() {
  try {
    const ipList = DOH_IPS.join(',');
    execSync(`netsh advfirewall firewall delete rule name="${DOH_RULE_NAME}"`, { stdio: 'pipe', windowsHide: true });
    execSync(
      `netsh advfirewall firewall add rule name="${DOH_RULE_NAME}" dir=out action=block protocol=TCP remoteip=${ipList} remoteport=443,853 enable=yes`,
      { stdio: 'pipe', windowsHide: true }
    );
    execSync(
      `netsh advfirewall firewall add rule name="${DOH_RULE_NAME}_UDP" dir=out action=block protocol=UDP remoteip=${ipList} remoteport=443,853 enable=yes`,
      { stdio: 'pipe', windowsHide: true }
    );
    console.log('[Firewall] Blocked DoH providers');
  } catch (e) {
    console.error('[Firewall] Failed to block DoH:', e.message);
  }
}

function unblockDoHInFirewall() {
  try {
    execSync(`netsh advfirewall firewall delete rule name="${DOH_RULE_NAME}"`, { stdio: 'pipe', windowsHide: true });
    execSync(`netsh advfirewall firewall delete rule name="${DOH_RULE_NAME}_UDP"`, { stdio: 'pipe', windowsHide: true });
    console.log('[Firewall] Unblocked DoH providers');
  } catch {}
}

// ─── Watchdog ──────────────────────────────────────────────────────────────────

function startWatchdog(whitelist) {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!isProxyActive) return;
    setSystemDnsToLocal();
  }, 15000);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

function applyRules(whitelist) {
  isProxyActive = true;
  startDnsServer(whitelist);
  blockDoHInFirewall();
  setSystemDnsToLocal();
  startWatchdog(whitelist);
}

function removeAllRules() {
  isProxyActive = false;
  stopWatchdog();
  stopDnsServer();
  resetSystemDns();
  unblockDoHInFirewall();
}

function updateWhitelist(whitelist) {
  currentWhitelist = [...whitelist];
}

function isRunningAsAdmin() {
  try {
    execSync('net session', { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function verifyRulesActive() {
  return isProxyActive;
}

module.exports = {
  applyRules,
  removeAllRules,
  updateWhitelist,
  isRunningAsAdmin,
  verifyRulesActive,
  startWatchdog: () => {},
  stopWatchdog: () => {}
};

/**
 * blocker/dnsProxy.js
 * Local DNS server on 127.0.0.1:53. Forwards whitelisted queries upstream,
 * NXDOMAINs everything else, and reports newly-seen A-record IPs so the
 * firewall can allow them mid-session.
 */

const dgram = require('dgram');
const { execSync } = require('child_process');

const UPSTREAMS = ['1.1.1.1', '8.8.8.8'];

let server        = null;
let whitelist     = [];
let onNewIps      = null;
let dnsWatchdog   = null;
let running       = false;
let pendingIps    = new Set();
let flushTimer    = null;

// ─── Packet helpers ──────────────────────────────────────────────────────────

function parseQuestion(buf) {
  try {
    let off = 12;
    const parts = [];
    while (off < buf.length && buf[off] !== 0) {
      const len = buf[off];
      if ((len & 0xC0) === 0xC0) break;
      parts.push(buf.toString('utf8', off + 1, off + 1 + len));
      off += 1 + len;
    }
    return parts.join('.').toLowerCase();
  } catch { return ''; }
}

/** Extracts every A record from a response (covers CNAME chains automatically). */
function parseAnswerIps(buf) {
  const ips = [];
  try {
    if (buf.length < 12) return ips;
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    let off = 12;

    const skipName = () => {
      while (off < buf.length) {
        const len = buf[off];
        if (len === 0) { off += 1; return; }
        if ((len & 0xC0) === 0xC0) { off += 2; return; }
        off += 1 + len;
      }
    };

    for (let i = 0; i < qd; i++) { skipName(); off += 4; }
    for (let i = 0; i < an; i++) {
      skipName();
      if (off + 10 > buf.length) break;
      const type  = buf.readUInt16BE(off);
      const rdlen = buf.readUInt16BE(off + 8);
      off += 10;
      if (type === 1 && rdlen === 4 && off + 4 <= buf.length) {
        ips.push(`${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`);
      }
      off += rdlen;
    }
  } catch {}
  return ips;
}

function makeNxdomain(req) {
  const res = Buffer.from(req);
  if (res.length < 12) return res;
  res[2] = res[2] | 0x80;              // QR = response
  res[3] = (res[3] & 0xF0) | 0x03;     // RCODE = NXDOMAIN, preserve RA/Z
  res.writeUInt16BE(0, 6);             // ANCOUNT = 0
  res.writeUInt16BE(0, 8);             // NSCOUNT = 0  (FIXED)
  res.writeUInt16BE(0, 10);            // ARCOUNT = 0  (FIXED)
  return res;
}

const DOH_DOMAINS = [
  'dns.google', 'cloudflare-dns.com', 'chrome.cloudflare-dns.com',
  'mozilla.cloudflare-dns.com', 'dns.quad9.net', 'doh.opendns.com'
];

function isWhitelisted(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/\.$/, '');
  
  // Always block DoH domains to force browsers to use system DNS
  if (DOH_DOMAINS.some(doh => d === doh || d.endsWith('.' + doh))) {
    return false; 
  }

  return whitelist.some(w => {
    const base = w.toLowerCase().trim()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .replace(/\.$/, '');
    return d === base || d.endsWith('.' + base);
  });
}

// ─── Batched IP reporting ────────────────────────────────────────────────────

function queueIp(ip) {
  pendingIps.add(ip);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (pendingIps.size && onNewIps) {
      const batch = [...pendingIps];
      pendingIps.clear();
      try { onNewIps(batch); } catch (e) { console.error('[DNS] onNewIps failed', e.message); }
    }
  }, 2000);
}

// ─── Server ──────────────────────────────────────────────────────────────────

let onBlockedDomain = null;

function startServer() {
  stopServer();
  server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  server.on('message', (msg, rinfo) => {
    const domain = parseQuestion(msg);

    if (!isWhitelisted(domain)) {
      if (onBlockedDomain && domain) onBlockedDomain(domain);
      try { server.send(makeNxdomain(msg), rinfo.port, rinfo.address); } catch {}
      return;
    }

    const upstream = dgram.createSocket('udp4');
    let settled = false;
    const done = () => { if (!settled) { settled = true; try { upstream.close(); } catch {} } };

    const timer = setTimeout(done, 4000);

    upstream.on('message', reply => {
      clearTimeout(timer);
      try { server.send(reply, rinfo.port, rinfo.address); } catch {}
      parseAnswerIps(reply).forEach(queueIp);
      done();
    });
    upstream.on('error', () => { clearTimeout(timer); done(); });

    const target = UPSTREAMS[Math.floor(Math.random() * UPSTREAMS.length)];
    upstream.send(msg, 53, target, err => { if (err) { clearTimeout(timer); done(); } });
  });

  server.on('error', err => {
    console.error('[DNS Proxy] fatal:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('[DNS Proxy] Port 53 is taken. Stop Internet Connection Sharing / '
        + 'Hyper-V DNS / Docker DNS, or another resolver, then retry.');
    }
  });

  server.bind(53, '127.0.0.1', () => console.log('[DNS Proxy] listening on 127.0.0.1:53'));
}

function stopServer() {
  if (server) { try { server.close(); } catch {} server = null; }
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pendingIps.clear();
}

// ─── System DNS ──────────────────────────────────────────────────────────────

function setSystemDnsToLocal() {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetAdapter | Where-Object Status -eq 'Up' | `
      + `Set-DnsClientServerAddress -ServerAddresses '127.0.0.1'"`,
      { stdio: 'pipe', windowsHide: true }
    );
    execSync('ipconfig /flushdns', { stdio: 'pipe', windowsHide: true });
  } catch (e) { console.error('[DNS] set failed:', e.message); }
}

function resetSystemDns() {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetAdapter | Where-Object Status -eq 'Up' | `
      + `Set-DnsClientServerAddress -ResetServerAddresses"`,
      { stdio: 'pipe', windowsHide: true }
    );
    execSync('ipconfig /flushdns', { stdio: 'pipe', windowsHide: true });
  } catch (e) { console.error('[DNS] reset failed:', e.message); }
}

/** Re-asserts 127.0.0.1 only if something changed it — avoids constant churn. */
function startWatchdog() {
  stopWatchdog();
  dnsWatchdog = setInterval(() => {
    if (!running) return;
    try {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-DnsClientServerAddress -AddressFamily IPv4 | `
        + `Where-Object { $_.ServerAddresses -notcontains '127.0.0.1' -and $_.ServerAddresses.Count -gt 0 } | `
        + `Measure-Object).Count"`,
        { stdio: 'pipe', windowsHide: true }
      ).toString().trim();
      if (parseInt(out, 10) > 0) {
        console.warn('[DNS Watchdog] DNS was changed — re-asserting 127.0.0.1');
        setSystemDnsToLocal();
      }
    } catch {}
  }, 15_000);
}

function stopWatchdog() {
  if (dnsWatchdog) { clearInterval(dnsWatchdog); dnsWatchdog = null; }
}

// ─── Public API ──────────────────────────────────────────────────────────────

function start(domains, newIpCallback, blockedCallback) {
  whitelist = [...domains];
  onNewIps  = newIpCallback;
  onBlockedDomain = blockedCallback;
  running   = true;
  startServer();
  setSystemDnsToLocal();
  startWatchdog();
}

function stop() {
  running = false;
  stopWatchdog();
  stopServer();
  resetSystemDns();
  onNewIps = null;
}

function updateWhitelist(domains) { whitelist = [...domains]; }
function isRunning() { return running; }

module.exports = { start, stop, updateWhitelist, isRunning, UPSTREAMS };

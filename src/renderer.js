/**
 * renderer.js — StrictFocus UI logic
 * Runs in the Electron renderer process (sandboxed, no Node.js access).
 * Communicates with main process via window.sf (contextBridge).
 */

// ─── State ────────────────────────────────────────────────────────────────────

const DEFAULT_DOMAINS = ['google.com', 'googleapis.com', 'gstatic.com'];

let domains      = [...DEFAULT_DOMAINS];
let durationMins = 25;
let totalMs      = 0;
let allowedIpCount = 0;

const MOTIVATIONS = [
  "Stay in the zone. You've got this! 💪",
  "Deep work mode activated. Keep going! 🚀",
  "Every minute counts. Stay focused! ⚡",
  "No distractions. Pure productivity. 🎯",
  "You're building something great. Focus! 🏆",
  "Silence the noise. Amplify the signal. 🎯",
];

// ─── Elements ─────────────────────────────────────────────────────────────────

const screens = {
  setup:     document.getElementById('screen-setup'),
  resolving: document.getElementById('screen-resolving'),
  active:    document.getElementById('screen-active'),
  done:      document.getElementById('screen-done'),
};

const $ = (id) => document.getElementById(id);

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ─── Titlebar ─────────────────────────────────────────────────────────────────

$('btn-minimize').addEventListener('click', () => window.sf.minimize());
$('btn-close').addEventListener('click',    () => window.sf.closeApp());

window.sf.onCloseBlocked(() => {
  $('btn-close').style.animation = 'shake 0.4s ease';
  setTimeout(() => $('btn-close').style.animation = '', 400);
});

// ─── Timer Slider ─────────────────────────────────────────────────────────────

const slider = $('timer-slider');
const durationDisplay = $('duration-display');

function updateSlider(value) {
  durationMins = parseInt(value, 10);
  durationDisplay.textContent = formatMins(durationMins);

  // Update slider fill
  const pct = ((durationMins - 1) / (480 - 1)) * 100;
  slider.style.setProperty('--pct', `${pct}%`);

  // Update active chip
  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('active', parseInt(c.dataset.mins, 10) === durationMins);
  });
}

slider.addEventListener('input', (e) => updateSlider(e.target.value));
updateSlider(25);

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const mins = chip.dataset.mins;
    slider.value = mins;
    updateSlider(mins);
  });
});

// ─── Domain Whitelist ─────────────────────────────────────────────────────────

function renderDomains() {
  const list = $('domain-list');
  list.innerHTML = '';
  $('domain-count').textContent = `${domains.length} domain${domains.length !== 1 ? 's' : ''}`;

  if (domains.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:16px;color:var(--red);font-size:13px">⚠️ No domains whitelisted — all internet will be blocked</div>`;
    return;
  }

  domains.forEach((domain, idx) => {
    const item = document.createElement('div');
    item.className = 'domain-item';
    item.innerHTML = `
      <div class="domain-item-left">
        <div class="domain-dot"></div>
        <div>
          <div class="domain-name">${escHtml(domain)}</div>
          <div class="domain-sub">*.${escHtml(domain)} &amp; subdomains allowed</div>
        </div>
      </div>
      <button class="domain-remove" data-idx="${idx}" title="Remove">×</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.domain-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      domains.splice(parseInt(btn.dataset.idx, 10), 1);
      renderDomains();
    });
  });
}

function addDomain(raw) {
  const cleaned = raw
    .toLowerCase()
    .replace(/^https?:\/\//,'')
    .replace(/^www\./,'')
    .split('/')[0]
    .trim();

  if (!cleaned || !cleaned.includes('.')) return false;
  if (domains.includes(cleaned)) return false;

  domains.push(cleaned);
  renderDomains();
  return true;
}

const domainInput = $('domain-input');
const btnAdd      = $('btn-add-domain');

btnAdd.addEventListener('click', () => {
  if (addDomain(domainInput.value)) domainInput.value = '';
});

domainInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    if (addDomain(domainInput.value)) domainInput.value = '';
  }
});

renderDomains();

// ─── Start Session ────────────────────────────────────────────────────────────

$('btn-start').addEventListener('click', async () => {
  if (domains.length === 0) {
    pulse($('domain-list'));
    return;
  }

  totalMs = durationMins * 60 * 1000;
  showScreen('resolving');
  $('resolving-log').innerHTML = '';

  // Hook resolve progress events
  window.sf.onResolveProgress(({ domain, count }) => {
    const line = document.createElement('div');
    line.textContent = `✓ ${domain}  →  ${count} IP${count !== 1 ? 's' : ''}`;
    $('resolving-log').prepend(line);
  });

  const result = await window.sf.startSession(totalMs, domains);

  window.sf.removeAllListeners('resolve-progress');

  if (result.error) {
    showScreen('setup');
    alert('Error: ' + result.error);
    return;
  }

  allowedIpCount = result.ipCount || 0;
  initActiveScreen(totalMs);
  showScreen('active');
});

// ─── Active Session UI ────────────────────────────────────────────────────────

const RING_CIRCUMFERENCE = 2 * Math.PI * 115; // 722.57

function initActiveScreen(durationMs) {
  totalMs = durationMs;

  // Populate stats
  $('stat-domains').textContent = domains.length;
  $('stat-ips').textContent     = allowedIpCount;
  $('stat-rules').textContent   = '✓';

  // Populate domain chips
  const container = $('active-domains');
  container.innerHTML = '';
  domains.forEach(d => {
    const chip = document.createElement('div');
    chip.className = 'active-domain-chip';
    chip.textContent = d;
    container.appendChild(chip);
  });

  // Inject SVG gradient def
  if (!document.getElementById('ringGrad')) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:absolute;width:0;height:0');
    svg.innerHTML = `<defs>
      <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%"   stop-color="#7C3AED"/>
        <stop offset="100%" stop-color="#06B6D4"/>
      </linearGradient>
    </defs>`;
    document.body.appendChild(svg);
  }

  // Motivation cycling
  rotateMotivation();
  setInterval(rotateMotivation, 30_000);

  // First render
  updateTimerRing(totalMs, totalMs);
}

function updateTimerRing(remainingMs, durationMs) {
  const display   = $('timer-display');
  const ring      = $('ring-progress');

  display.textContent = formatMs(remainingMs);

  const fraction = durationMs > 0 ? Math.max(0, remainingMs / durationMs) : 0;
  const offset   = RING_CIRCUMFERENCE * (1 - fraction);
  ring.style.strokeDashoffset = offset.toFixed(2);
}

function rotateMotivation() {
  const idx = Math.floor(Date.now() / 30_000) % MOTIVATIONS.length;
  $('motivation-text').textContent = MOTIVATIONS[idx];
}

// ─── IPC Events ───────────────────────────────────────────────────────────────

window.sf.onTick(({ remainingMs }) => {
  updateTimerRing(remainingMs, totalMs);
});

window.sf.onSessionEnded(() => {
  showScreen('done');
});

window.sf.onResolvingStart(() => {
  showScreen('resolving');
});

window.sf.onResolvingDone(({ ipCount }) => {
  allowedIpCount = ipCount;
  $('stat-ips').textContent = allowedIpCount;
});

window.sf.onIpCount(({ ipCount }) => {
  allowedIpCount = ipCount;
  $('stat-ips').textContent = allowedIpCount;
});

window.sf.onSessionRestored(({ remainingMs, whitelist }) => {
  domains = whitelist || [];
  totalMs = remainingMs; // approximate; will be updated by ticks
  initActiveScreen(remainingMs);
  showScreen('active');
});

// ─── Done screen ──────────────────────────────────────────────────────────────

$('btn-new-session').addEventListener('click', () => {
  renderDomains();
  showScreen('setup');
});

// ─── Admin check ──────────────────────────────────────────────────────────────

async function checkAdmin() {
  const status = await window.sf.getStatus();
  const warning = $('admin-warning');
  if (!status.isAdmin) {
    warning.classList.remove('hidden');
    $('btn-start').disabled = true;
    $('btn-start').style.opacity = '0.5';
    $('btn-start').style.cursor = 'not-allowed';
  } else {
    warning.classList.add('hidden');
  }

  // Restore active session if main process found one
  if (status.isActive && status.session) {
    domains = status.session.whitelist || [];
    totalMs = status.remainingMs;
    initActiveScreen(totalMs);
    showScreen('active');
  }
}
checkAdmin();

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (ms <= 0) return '00:00';
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(sec)}`
    : `${pad(m)}:${pad(sec)}`;
}

function formatMins(mins) {
  if (mins < 60) return `${mins}m`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function pulse(el) {
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.animation = 'bounceIn 0.3s ease';
  setTimeout(() => el.style.animation = '', 300);
}

// ─── Live Blocked Log ─────────────────────────────────────────────────────────

const blockedLogList = document.getElementById('blocked-log-list');

window.sf.onDnsBlocked(({ domain }) => {
  if (!blockedLogList) return;
  const item = document.createElement('div');
  item.className = 'blocked-item';
  item.textContent = `🚫 ${domain}`;
  blockedLogList.prepend(item);

  // Keep only the last 8 items
  while (blockedLogList.children.length > 8) {
    blockedLogList.removeChild(blockedLogList.lastChild);
  }
});

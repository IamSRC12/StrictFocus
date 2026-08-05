/**
 * main.js — StrictFocus Desktop (Electron main process)
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow & System Tray
 *  - Orchestrate firewallManager + dnsProxy + dnsResolver + sessionManager
 *  - Order of operations on session start:
 *      1. Resolve whitelist domains to IPs while internet still works.
 *      2. Persist session state.
 *      3. Add ALLOW rules for loopback, LAN, DHCP, app DNS, & whitelisted IPs.
 *      4. ONLY THEN flip DefaultOutboundAction to Block on all profiles.
 *      5. Start local DNS proxy (127.0.0.1:53) to return instant NXDOMAIN &
 *         dynamically discover new IPs to allow mid-session.
 *  - Handle app crash recovery (recoverIfStranded) on startup
 *  - Prevent app close during active session
 */

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path        = require('path');
const sessionMgr  = require('./blocker/sessionManager');
const dnsProxy    = require('./blocker/dnsProxy');
const firewall    = require('./blocker/firewallManager');
const dnsResolver = require('./blocker/dnsResolver');

let mainWindow   = null;
let tray         = null;
let tickInterval = null;
let allowedIps   = new Set();

// ─── Single instance & App lifecycle ──────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    firewall.writeRestoreScript();
    firewall.recoverIfStranded(sessionMgr.isActive());
    createWindow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           820,
    height:          680,
    minWidth:        760,
    minHeight:       580,
    resizable:       true,
    frame:           false,
    transparent:     true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (sessionMgr.isActive()) {
      const sess = sessionMgr.getSession();
      if (sess) {
        mainWindow.webContents.send('session-restored', {
          remainingMs: sessionMgr.getRemainingMs(),
          whitelist:   sess.whitelist
        });
        startTickLoop();
        restoreAfterRestart(sess.whitelist);
      }
    }
  });

  mainWindow.on('close', (e) => {
    if (sessionMgr.isActive()) {
      e.preventDefault();
      mainWindow.webContents.send('close-blocked');
      dialog.showMessageBox(mainWindow, {
        type:    'warning',
        title:   'Session Active',
        message: '🔒 Focus session is active!',
        detail:  `You cannot close StrictFocus while a session is running.\n\nRemaining: ${formatMs(sessionMgr.getRemainingMs())}`,
        buttons: ['OK']
      });
    } else {
      cleanup();
    }
  });

  createTray();
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray.ico');
    const icon     = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('StrictFocus');
    updateTrayMenu();
    tray.on('double-click', () => mainWindow && mainWindow.show());
  } catch (e) {
    console.warn('Tray creation failed:', e.message);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const active = sessionMgr.isActive();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: active ? `🔒 Session: ${formatMs(sessionMgr.getRemainingMs())}` : '✅ No Session', enabled: false },
    { type: 'separator' },
    { label: 'Show Window', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', enabled: !active, click: () => { cleanup(); app.quit(); } }
  ]));
}

// ─── Tick loop ────────────────────────────────────────────────────────────────

function startTickLoop() {
  stopTickLoop();
  tickInterval = setInterval(() => {
    const remaining = sessionMgr.getRemainingMs();
    mainWindow && mainWindow.webContents.send('tick', { remainingMs: remaining });
    updateTrayMenu();

    if (remaining <= 0) {
      endSession();
    }
  }, 500);
}

function stopTickLoop() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

async function startSession(durationMs, whitelist) {
  if (!firewall.isRunningAsAdmin()) return { error: 'Administrator privileges required.' };

  // 1. Resolve BEFORE locking down — resolution needs working internet.
  mainWindow && mainWindow.webContents.send('resolving-start');
  allowedIps = await dnsResolver.resolveWhitelist(whitelist, (domain, count) => {
    mainWindow && mainWindow.webContents.send('resolve-progress', { domain, count });
  });

  if (allowedIps.size === 0) {
    return { error: 'Could not resolve any whitelisted domain. Check your connection.' };
  }

  // 2. Persist session state.
  sessionMgr.startSession(durationMs, whitelist);

  // 3. Lock down the firewall (allow rules first, then deny-by-default).
  firewall.applyRules(allowedIps, {
    appPath:         process.execPath,
    upstreamDnsIps:  dnsProxy.UPSTREAMS,
    durationMinutes: durationMs / 60000
  });

  // 4. Start local DNS; new IPs discovered mid-session get allowed on the fly.
  dnsProxy.start(whitelist, (newIps) => {
    const added = firewall.addAllowedIps(newIps);
    if (added) {
      newIps.forEach(ip => allowedIps.add(ip));
      mainWindow && mainWindow.webContents.send('ip-count', { ipCount: allowedIps.size });
    }
  });

  startTickLoop();
  mainWindow && mainWindow.webContents.send('resolving-done', { ipCount: allowedIps.size });
  return { ipCount: allowedIps.size };
}

function endSession() {
  stopTickLoop();
  dnsProxy.stop();
  firewall.removeAllRules();
  sessionMgr.endSession();
  mainWindow && mainWindow.webContents.send('session-ended');
  updateTrayMenu();
}

async function restoreAfterRestart(whitelist) {
  allowedIps = await dnsResolver.resolveWhitelist(whitelist).catch(() => new Set());
  firewall.addAllowedIps(allowedIps);
  firewall.startWatchdog();
  dnsProxy.start(whitelist, (ips) => firewall.addAllowedIps(ips));
}

function cleanup() {
  stopTickLoop();
  if (!sessionMgr.isActive()) {
    dnsProxy.stop();
    firewall.removeAllRules();
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-status', () => ({
  isActive:    sessionMgr.isActive(),
  remainingMs: sessionMgr.getRemainingMs(),
  session:     sessionMgr.getSession(),
  isAdmin:     firewall.isRunningAsAdmin(),
  rulesActive: sessionMgr.isActive() ? firewall.verifyRulesActive() : false,
  ipCount:     allowedIps.size,
  restorePath: firewall.restoreScriptPath
}));

ipcMain.handle('start-session', async (_event, { durationMs, whitelist }) => {
  if (sessionMgr.isActive()) {
    return { error: 'Session already active' };
  }
  const result = await startSession(durationMs, whitelist);
  return { success: true, ...result };
});

ipcMain.on('minimize-window', () => mainWindow && mainWindow.minimize());

ipcMain.on('close-window', () => {
  if (!sessionMgr.isActive()) {
    cleanup();
    mainWindow && mainWindow.close();
  } else {
    mainWindow && mainWindow.webContents.send('close-blocked');
  }
});

ipcMain.on('open-external', (_e, url) => shell.openExternal(url));

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (!sessionMgr.isActive()) {
    cleanup();
    app.quit();
  }
});

app.on('before-quit', () => {
  if (!sessionMgr.isActive()) cleanup();
});

function formatMs(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

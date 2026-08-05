/**
 * main.js — StrictFocus Desktop (Electron main process)
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow
 *  - Handle IPC from renderer (start/stop session, check status)
 *  - Orchestrate firewallManager + dnsResolver + sessionManager
 *  - Prevent app close during active session
 *  - Watchdog timer to keep rules enforced
 */

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path        = require('path');
const sessionMgr  = require('./blocker/sessionManager');
const firewall    = require('./blocker/firewallManager');
const dnsResolver = require('./blocker/dnsResolver');

// ─── State ────────────────────────────────────────────────────────────────────

let mainWindow   = null;
let tray         = null;
let tickInterval = null;    // 1s countdown tick
let allowedIps   = new Set();

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           820,
    height:          680,
    minWidth:        760,
    minHeight:       580,
    resizable:       true,
    frame:           false,         // custom titlebar
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
    // If session was active when we launched (e.g., after a restart), restore UI
    if (sessionMgr.isActive()) {
      const sess = sessionMgr.getSession();
      if (sess) {
        mainWindow.webContents.send('session-restored', {
          remainingMs: sessionMgr.getRemainingMs(),
          whitelist:   sess.whitelist
        });
        startTickLoop();
        // Re-apply firewall rules with the persisted whitelist
        restoreFirewallRules(sess.whitelist);
      }
    }
  });

  // Prevent close during active session
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

// ─── Firewall restoration after restart ───────────────────────────────────────

async function restoreFirewallRules(whitelist) {
  try {
    mainWindow.webContents.send('resolving-start');
    allowedIps = await dnsResolver.resolveWhitelist(whitelist, (domain, count) => {
      mainWindow.webContents.send('resolve-progress', { domain, count });
    });
    firewall.applyRules(allowedIps);
    firewall.startWatchdog(allowedIps);
    mainWindow.webContents.send('resolving-done', { ipCount: allowedIps.size });
  } catch (e) {
    console.error('Failed to restore firewall rules:', e);
  }
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
  // 1. Save session state
  sessionMgr.startSession(durationMs, whitelist);

  // 2. Resolve IPs for whitelist
  mainWindow.webContents.send('resolving-start');
  try {
    allowedIps = await dnsResolver.resolveWhitelist(whitelist, (domain, count) => {
      mainWindow.webContents.send('resolve-progress', { domain, count });
    });
  } catch (e) {
    console.error('DNS resolution failed:', e);
    allowedIps = new Set();
  }
  mainWindow.webContents.send('resolving-done', { ipCount: allowedIps.size });

  // 3. Apply firewall rules
  firewall.applyRules(allowedIps);
  firewall.startWatchdog(allowedIps);

  // 4. Start countdown
  startTickLoop();

  return { ipCount: allowedIps.size };
}

function endSession() {
  stopTickLoop();
  firewall.removeAllRules();
  firewall.stopWatchdog();
  sessionMgr.endSession();
  allowedIps.clear();
  mainWindow && mainWindow.webContents.send('session-ended');
  updateTrayMenu();
}

function cleanup() {
  stopTickLoop();
  if (!sessionMgr.isActive()) {
    firewall.removeAllRules();
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-status', () => {
  return {
    isActive:      sessionMgr.isActive(),
    remainingMs:   sessionMgr.getRemainingMs(),
    session:       sessionMgr.getSession(),
    isAdmin:       firewall.isRunningAsAdmin(),
    rulesActive:   firewall.verifyRulesActive()
  };
});

ipcMain.handle('start-session', async (_event, { durationMs, whitelist }) => {
  if (sessionMgr.isActive()) {
    return { error: 'Session already active' };
  }
  const result = await startSession(durationMs, whitelist);
  return { success: true, ...result };
});

// Minimize window
ipcMain.on('minimize-window', () => mainWindow && mainWindow.minimize());

// Close window (only if no session)
ipcMain.on('close-window', () => {
  if (!sessionMgr.isActive()) {
    cleanup();
    mainWindow && mainWindow.close();
  } else {
    mainWindow && mainWindow.webContents.send('close-blocked');
  }
});

// Open external link
ipcMain.on('open-external', (_e, url) => shell.openExternal(url));

// ─── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Single instance lock
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  createWindow();
});

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
  // If session is active: keep running (tray only mode)
});

app.on('before-quit', () => {
  if (!sessionMgr.isActive()) cleanup();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

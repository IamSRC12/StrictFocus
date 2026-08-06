/**
 * main.js — StrictFocus Desktop (Electron main process)
 *
 * Responsibilities:
 *  - Create and manage the BrowserWindow & System Tray
 *  - Orchestrate firewallManager + dnsProxy + sessionManager
 *  - Order of operations on session start:
 *      1. Persist session state.
 *      2. Block known DoH IPs in Windows Firewall on TCP/UDP port 443.
 *      3. Start local DNS proxy (127.0.0.1:53) to return real IPs for whitelisted domains
 *         and NXDOMAIN for blocked domains.
 *  - Handle app crash recovery (recoverIfStranded) on startup
 *  - Prevent app close during active session
 */

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path       = require('path');
const sessionMgr = require('./blocker/sessionManager');
const dnsProxy   = require('./blocker/dnsProxy');
const firewall   = require('./blocker/firewallManager');
const aiExpander = require('./blocker/aiDomainExpander');

let mainWindow   = null;
let tray         = null;
let tickInterval = null;

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

async function startSession(durationMs, whitelist, groqApiKey) {
  if (!firewall.isRunningAsAdmin()) return { error: 'Administrator privileges required.' };

  // 1. AI Auto-Detection (Expand whitelist)
  mainWindow && mainWindow.webContents.send('resolving-start');
  let finalWhitelist = whitelist;

  if (groqApiKey) {
    mainWindow && mainWindow.webContents.send('resolve-progress', { domain: 'Asking AI for dependencies...', count: 0 });
    finalWhitelist = await aiExpander.expandWhitelist(whitelist, groqApiKey);
  }

  // 2. Persist session state.
  sessionMgr.startSession(durationMs, finalWhitelist);

  // 3. Block known DoH IPs in firewall.
  firewall.applyRules({
    durationMinutes: durationMs / 60000
  });

  // 4. Start local DNS proxy with expanded list.
  dnsProxy.start(finalWhitelist, null, (domain) => {
    mainWindow && mainWindow.webContents.send('dns-blocked', { domain, time: Date.now() });
  });

  startTickLoop();
  mainWindow && mainWindow.webContents.send('resolving-done', { ipCount: 0 });
  return { ipCount: 0, expandedDomains: finalWhitelist.length };
}

function endSession() {
  stopTickLoop();
  dnsProxy.stop();
  firewall.removeAllRules();
  sessionMgr.endSession();
  mainWindow && mainWindow.webContents.send('session-ended');
  updateTrayMenu();
}

function restoreAfterRestart(whitelist) {
  firewall.applyRules({ durationMinutes: sessionMgr.getRemainingMs() / 60000 });
  firewall.startWatchdog();
  dnsProxy.start(whitelist, null, (domain) => {
    mainWindow && mainWindow.webContents.send('dns-blocked', { domain, time: Date.now() });
  });
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
  ipCount:     0,
  restorePath: firewall.restoreScriptPath
}));

ipcMain.handle('start-session', async (_event, { durationMs, whitelist, groqApiKey }) => {
  if (sessionMgr.isActive()) {
    return { error: 'Session already active' };
  }
  const result = await startSession(durationMs, whitelist, groqApiKey);
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


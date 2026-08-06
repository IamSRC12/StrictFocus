/**
 * preload.js — Secure IPC bridge between main process and renderer.
 * Exposes a controlled API via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sf', {
  // ── Commands (renderer → main) ───────────────────────────────────────────
  getStatus:    ()                  => ipcRenderer.invoke('get-status'),
  startSession: (durationMs, list, groqApiKey) => ipcRenderer.invoke('start-session', { durationMs, whitelist: list, groqApiKey }),
  minimize:     ()                  => ipcRenderer.send('minimize-window'),
  closeApp:     ()                  => ipcRenderer.send('close-window'),
  openExternal: (url)               => ipcRenderer.send('open-external', url),

  // ── Events (main → renderer) ─────────────────────────────────────────────
  onTick:             (cb) => ipcRenderer.on('tick',              (_e, d) => cb(d)),
  onSessionRestored:  (cb) => ipcRenderer.on('session-restored',  (_e, d) => cb(d)),
  onSessionEnded:     (cb) => ipcRenderer.on('session-ended',     ()      => cb()),
  onResolvingStart:   (cb) => ipcRenderer.on('resolving-start',   ()      => cb()),
  onResolveProgress:  (cb) => ipcRenderer.on('resolve-progress',  (_e, d) => cb(d)),
  onResolvingDone:    (cb) => ipcRenderer.on('resolving-done',    (_e, d) => cb(d)),
  onIpCount:          (cb) => ipcRenderer.on('ip-count',          (_e, d) => cb(d)),
  onCloseBlocked:     (cb) => ipcRenderer.on('close-blocked',     ()      => cb()),
  onDnsBlocked:       (cb) => ipcRenderer.on('dns-blocked',       (_e, d) => cb(d)),

  // ── Cleanup ───────────────────────────────────────────────────────────────
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});

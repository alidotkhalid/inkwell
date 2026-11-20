const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('native', {
  legacyStorage: () => ipcRenderer.invoke('legacy-storage'),
  initialFile: () => ipcRenderer.invoke('initial-file'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (name, current) => ipcRenderer.invoke('save-dialog', name, current),
  recents: () => ipcRenderer.invoke('recents'),
  opened: (p) => ipcRenderer.invoke('opened', p),
  forget: (p) => ipcRenderer.invoke('forget', p),
  printers: () => ipcRenderer.invoke('printers'),
  print: (options) => ipcRenderer.invoke('print', options),
  contentReady: () => ipcRenderer.send('content-ready'),
  setTheme: (t) => ipcRenderer.send('theme', t),
  docState: (on) => ipcRenderer.send('doc-state', on),
  closeWindow: () => ipcRenderer.send('close-window'),
  // a file dragged in from Explorer: hand back its real location so Save can write to it
  pathForFile: (file) => { try { const p = webUtils.getPathForFile(file); if (p) ipcRenderer.send('grant-dropped', p); return p || null; } catch { return null; } },
  onOpenFile: (fn) => ipcRenderer.on('open-file', (e, p) => fn(p)),
  onSaveAndClose: (fn) => ipcRenderer.on('save-and-close', () => fn()),
});

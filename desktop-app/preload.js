const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fs', {
  login: (creds) => ipcRenderer.invoke('login', creds),
  checkSession: () => ipcRenderer.invoke('check-session'),
  startScan: (cfg) => ipcRenderer.invoke('start-scan', cfg),
  pause: () => ipcRenderer.send('pause'),
  resume: () => ipcRenderer.send('resume'),
  stop: () => ipcRenderer.send('stop'),
  decide: (mls, decision) => ipcRenderer.send('decide', { mls, decision }),
  setConfig: (c) => ipcRenderer.send('set-config', c),
  export: (leads) => ipcRenderer.invoke('export', { leads }),
  pushSheet: (leads, onlySurfacing) => ipcRenderer.invoke('push-sheet', { leads, onlySurfacing }),
  testSheet: () => ipcRenderer.invoke('test-sheet'),
  sheetDefaults: () => ipcRenderer.invoke('sheet-defaults'),
  kpiReport: (days) => ipcRenderer.invoke('kpi-report', { days }),
  kpiExport: (days) => ipcRenderer.invoke('kpi-export', { days }),
  kpiPush: () => ipcRenderer.invoke('kpi-push'),
  ledgerStats: () => ipcRenderer.invoke('ledger-stats'),
  ledgerClear: () => ipcRenderer.invoke('ledger-clear'),
  syncRejected: () => ipcRenderer.invoke('sync-rejected'),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
});

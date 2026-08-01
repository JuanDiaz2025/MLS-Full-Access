const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fs', {
  login: (creds) => ipcRenderer.invoke('login', creds),
  checkSession: () => ipcRenderer.invoke('check-session'),
  startScan: (cfg) => ipcRenderer.invoke('start-scan', cfg),
  pause: () => ipcRenderer.send('pause'),
  resume: () => ipcRenderer.send('resume'),
  stop: () => ipcRenderer.send('stop'),
  setConfig: (c) => ipcRenderer.send('set-config', c),
  export: (leads) => ipcRenderer.invoke('export', { leads }),
  kpiReport: (days) => ipcRenderer.invoke('kpi-report', { days }),
  kpiExport: (days) => ipcRenderer.invoke('kpi-export', { days }),
  ledgerStats: () => ipcRenderer.invoke('ledger-stats'),
  ledgerClear: () => ipcRenderer.invoke('ledger-clear'),
  // Direct Google Sheets connection
  googleStatus: () => ipcRenderer.invoke('google-status'),
  googleSave: (patch) => ipcRenderer.invoke('google-save', patch),
  googleSignIn: () => ipcRenderer.invoke('google-signin'),
  googleSignOut: () => ipcRenderer.invoke('google-signout'),
  googleTest: () => ipcRenderer.invoke('google-test'),
  googleSync: (leads, rejects) => ipcRenderer.invoke('google-sync', { leads, rejects }),
  backupStatus: () => ipcRenderer.invoke('backup-status'),
  showFile: (p) => ipcRenderer.send('show-file', p),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload)),
});

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zupu', {
  get: () => ipcRenderer.invoke('zupu:get'),
  save: (u) => ipcRenderer.invoke('zupu:save', u),
  retry: () => ipcRenderer.invoke('zupu:retry'),
  setup: () => ipcRenderer.invoke('zupu:setup'),
});

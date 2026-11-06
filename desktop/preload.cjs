const { contextBridge, ipcRenderer } = require('electron');

// 仅暴露本地目录选择；登录、模型配置和账号用量仍通过原有 API 完成。
contextBridge.exposeInMainWorld('zupuDesktop', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});

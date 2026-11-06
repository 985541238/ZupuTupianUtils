const { app, BrowserWindow, Menu, Tray, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// 使用独立端口，避免误复用浏览器开发服务或旧版 Nest 服务。
const PORT = Number(process.env.ZUPU_PORT || 8091);
let mainWindow = null;
let tray = null;
let serverProcess = null;
let quitting = false;
let logFile = null;

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: '选择本地图片文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  return { path: result.filePaths[0] };
});

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { if (logFile) fs.appendFileSync(logFile, line, 'utf8'); } catch { /* ignore logging failure */ }
}

function runtimeRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
}

function serverRoot() {
  return path.join(runtimeRoot(), 'server');
}

function serverEntry() {
  return path.join(serverRoot(), 'dist', 'main.js');
}

function serverIsReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await serverIsReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startServer() {
  log(`checking server port ${PORT}`);
  if (await serverIsReady()) {
    log('server already ready');
    return true;
  }
  const entry = serverEntry();
  if (!require('fs').existsSync(entry)) {
    dialog.showErrorBox('启动失败', `找不到服务端程序：${entry}`);
    return false;
  }
  const nodeBin = process.env.ZUPU_NODE_BIN || 'node';
  log(`starting server: ${nodeBin} ${entry}`);
  // 桌面版连接本机 MySQL，使用本地默认配置；不要加载部署环境 .env.production。
  serverProcess = spawn(nodeBin, [entry], {
    cwd: serverRoot(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      APP_ENV: 'desktop',
      PORT: String(PORT),
      DB_HOST: process.env.ZUPU_DB_HOST || 'localhost',
      DB_PORT: process.env.ZUPU_DB_PORT || '3306',
      DB_USER: process.env.ZUPU_DB_USER || 'zupu',
      DB_PASS: process.env.ZUPU_DB_PASS || 'zupu123',
      DB_NAME: process.env.ZUPU_DB_NAME || 'zupu_scan',
      ADMIN_DIST: path.join(runtimeRoot(), 'admin-web', 'dist'),
    },
  });
  let recentError = '';
  serverProcess.stdout?.on('data', (data) => log(`server: ${String(data).trim()}`));
  serverProcess.stderr?.on('data', (data) => {
    recentError = String(data).trim().slice(-2000);
    log(`server-error: ${recentError}`);
  });
  serverProcess.on('error', (error) => {
    log(`spawn-error: ${error.stack || error.message}`);
    dialog.showErrorBox('服务启动失败', `${error.message}\n请确认已安装 Node.js，或设置 ZUPU_NODE_BIN。`);
  });
  serverProcess.on('exit', (code, signal) => log(`server exited code=${code} signal=${signal || ''}`));
  const ready = await waitForServer();
  if (!ready) {
    log(`server did not become ready; recent error: ${recentError}`);
    dialog.showErrorBox('本地服务启动失败', `管理页面没有正常启动（端口 ${PORT}）。\n\n${recentError || '请检查 MySQL、Node.js 和日志：' + logFile}`);
  }
  return ready;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log(`preload-error ${preloadPath}: ${error?.stack || error?.message || error}`);
  });
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const bridgeReady = await mainWindow.webContents.executeJavaScript('Boolean(window.zupuDesktop && window.zupuDesktop.pickFolder)');
      log(`desktop bridge ready=${bridgeReady}`);
      if (!bridgeReady) dialog.showErrorBox('桌面功能加载失败', '本地目录选择功能没有加载成功，请退出程序后重新打开。');
    } catch (error) {
      log(`desktop bridge check failed: ${error?.stack || error?.message || error}`);
    }
  });
  // 清除历史版本缓存，并用启动时间区分入口 URL，保证每次都读取当前打包的 index.html。
  mainWindow.webContents.session.clearCache()
    .catch((error) => log(`clear cache failed: ${error?.message || error}`))
    .finally(() => mainWindow.loadURL(`http://127.0.0.1:${PORT}/?desktop=${Date.now()}`));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  tray = new Tray(require('electron').nativeImage.createEmpty());
  tray.setToolTip('族谱清晰化工作台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: '退出并停止本地服务', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(async () => {
  logFile = path.join(app.getPath('userData'), 'desktop-runtime.log');
  log(`desktop started; runtimeRoot=${runtimeRoot()}`);
  if (!(await startServer())) {
    app.quit();
    return;
  }
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

app.on('window-all-closed', (event) => event.preventDefault());

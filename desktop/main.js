// 桌面客户端：只是一个带地址记忆的浏览器窗口，打开已部署的服务器。
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; }
}
function writeCfg(c) {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2));
}
function normalize(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try { return new URL(s).origin; } catch { return ''; }
}

// 让 http://服务器IP 也被当作安全来源：浏览器的「选择文件夹」(showDirectoryPicker) 只在安全来源下可用
const initial = normalize(readCfg().serverUrl || process.env.ZUPU_SERVER || '');
if (initial) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', initial);

let win;
function show(file) {
  win.loadFile(path.join(__dirname, file));
}
function open() {
  const url = normalize(readCfg().serverUrl);
  if (!url) return show('setup.html');
  win.loadURL(url).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    title: '族谱清晰化工作台', autoHideMenuBar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    win.loadFile(path.join(__dirname, 'error.html'), { query: { url, desc } });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '修改服务器地址', click: () => show('setup.html') },
      { label: '刷新', accelerator: 'F5', click: () => open() },
      { type: 'separator' },
      { role: 'quit', label: '退出' },
    ] },
    { label: '视图', submenu: [
      { role: 'togglefullscreen', label: '全屏' },
      { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'resetZoom', label: '还原缩放' },
      { role: 'toggleDevTools', label: '开发者工具' },
    ] },
  ]));
  open();
}

ipcMain.handle('zupu:get', () => ({ serverUrl: readCfg().serverUrl || '' }));
ipcMain.handle('zupu:save', (_e, raw) => {
  const url = normalize(raw);
  if (!url) return { ok: false, error: '地址格式不对，例如 http://192.168.1.10:8081 或 https://zupu.example.com' };
  writeCfg({ serverUrl: url });
  app.relaunch(); app.exit(0); // 重启后新地址才会被当作安全来源
  return { ok: true };
});
ipcMain.handle('zupu:retry', () => open());
ipcMain.handle('zupu:setup', () => show('setup.html'));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}

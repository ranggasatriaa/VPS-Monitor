const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { ServerManager } = require('./src/servers');

const MOCK = process.argv.includes('--mock') || process.env.VPSMON_MOCK === '1';
let win = null;
let manager = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    title: MOCK ? 'VPS Monitor (mock data)' : 'VPS Monitor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // never let the renderer open other pages or windows
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// one window only: a second launch focuses the existing one
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

if (gotLock) app.whenReady().then(() => {
  manager = new ServerManager({
    configPath: path.join(app.getPath('userData'), MOCK ? 'config.mock.json' : 'config.json'),
    script: fs.readFileSync(path.join(__dirname, 'scripts', 'vpsmon-json.sh')),
    mock: MOCK,
    send,
  });

  ipcMain.handle('app:info', () => ({ mock: MOCK, version: app.getVersion() }));
  ipcMain.handle('servers:list', () => manager.list());
  ipcMain.handle('servers:save', (_e, profile) => manager.upsert(profile));
  ipcMain.handle('servers:delete', (_e, id) => manager.remove(id));
  ipcMain.handle('servers:setModules', (_e, id, disabled) => manager.setModules(id, disabled));
  ipcMain.handle('servers:reorder', (_e, ids) => manager.reorder(ids));
  ipcMain.handle('servers:test', (_e, profile, passphrase) => manager.test(profile, passphrase));
  ipcMain.handle('server:connect', (_e, id, passphrase) => manager.connect(id, passphrase));
  ipcMain.handle('server:disconnect', (_e, id) => manager.disconnect(id));
  ipcMain.handle('servers:connectAll', () => manager.connectAll());
  ipcMain.handle('servers:disconnectAll', () => manager.disconnectAll());
  ipcMain.handle('dialog:pickKey', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select SSH private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  createWindow();
  win.webContents.once('did-finish-load', () => manager.connectAuto());

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  manager?.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => manager?.shutdown());

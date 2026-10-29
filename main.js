const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { ServerManager } = require('./src/servers');

const MOCK = process.argv.includes('--mock') || process.env.VPSMON_MOCK === '1';
let win = null;
let manager = null;
let tray = null;
let quitting = false;   // true once the user really quits; until then closing only hides
let toldAboutTray = false;
const terminals = new Map(); // serverId -> { win, sess }

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

// 16x16 tray glyph (drawn at 2x): blue rounded square with a white line chart
function trayIcon() {
  const N = 32;
  const px = Buffer.alloc(N * N * 4);
  const put = (x, y, [r, g, b]) => { if (x < 0 || y < 0 || x >= N || y >= N) return; const i = (y * N + x) * 4; px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = 255; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = Math.max(0, 6 - x, x - (N - 7)); const dy = Math.max(0, 6 - y, y - (N - 7));
    if (dx * dx + dy * dy <= 36) put(x, y, [0x39, 0x87, 0xe5]);
  }
  const pts = [[5, 22], [11, 15], [16, 19], [21, 9], [27, 13]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps); const y = Math.round(y0 + ((y1 - y0) * s) / steps);
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(x + ox, y + oy, [255, 255, 255]);
    }
  }
  return nativeImage.createFromBitmap(px, { width: N, height: N, scaleFactor: 2 });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(MOCK ? 'VPS Monitor (mock data)' : 'VPS Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show VPS Monitor', click: showWindow },
    { type: 'separator' },
    { label: 'Connect all', click: () => manager.connectAll() },
    { label: 'Stop all', click: () => manager.disconnectAll() },
    { type: 'separator' },
    { label: 'Quit', click: quitApp },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

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
  // closing only hides the window: sessions and the chart history in the page keep running
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && process.platform === 'win32') {
      toldAboutTray = true;
      tray?.displayBalloon({ title: 'VPS Monitor is still running', content: 'Monitoring continues in the background. Use the tray icon to open it again or to quit.', iconType: 'info' });
    }
  });
  // terminals belong to the main window: close them with it
  win.on('closed', () => {
    win = null;
    for (const t of terminals.values()) if (!t.win.isDestroyed()) t.win.close();
  });
}

// One SSH terminal window per server; opening it again focuses the existing one.
function openTerminal(id) {
  const profile = manager.get(id);
  if (!profile) return;
  const open = terminals.get(id);
  if (open && !open.win.isDestroyed()) {
    if (open.win.isMinimized()) open.win.restore();
    open.win.focus();
    return;
  }
  const tw = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 480,
    minHeight: 280,
    backgroundColor: '#0d0d0d',
    title: `${profile.name} — terminal`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'terminal-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const t = { win: tw, sess: null };
  terminals.set(id, t);
  tw.loadFile(path.join(__dirname, 'renderer', 'terminal.html'));
  tw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  tw.webContents.on('will-navigate', (e) => e.preventDefault());
  tw.on('page-title-updated', (e) => e.preventDefault());
  tw.on('closed', () => {
    t.sess?.stop();
    if (terminals.get(id) === t) terminals.delete(id);
  });
}

function terminalFor(sender) {
  for (const [id, t] of terminals) if (!t.win.isDestroyed() && t.win.webContents === sender) return { id, t };
  return null;
}

// one window only: a second launch focuses the existing one
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => showWindow());

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
  ipcMain.handle('terminal:open', (_e, id) => openTerminal(id));
  ipcMain.handle('term:start', (e, cols, rows, passphrase) => {
    const found = terminalFor(e.sender);
    if (!found) return null;
    const { id, t } = found;
    t.sess?.stop();
    const sess = manager.terminal(id, passphrase);
    if (!sess) return null;
    t.sess = sess;
    const out = (channel, payload) => { if (t.sess === sess && !t.win.isDestroyed()) t.win.webContents.send(channel, payload); };
    sess.on('ready', () => out('term:ready'));
    sess.on('data', (data) => out('term:data', data));
    sess.on('exit', (info) => out('term:exit', info));
    sess.start(cols, rows);
    const p = manager.get(id);
    return { name: p.name, target: `${p.username}@${p.host}${p.port && p.port !== 22 ? ':' + p.port : ''}`, color: p.color };
  });
  ipcMain.on('term:input', (e, data) => terminalFor(e.sender)?.t.sess?.write(String(data)));
  ipcMain.on('term:resize', (e, cols, rows) => {
    const clamp = (v) => Math.max(2, Math.min(1000, Number(v) | 0));
    terminalFor(e.sender)?.t.sess?.resize(clamp(cols), clamp(rows));
  });
  ipcMain.handle('dialog:pickKey', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select SSH private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  createTray();
  createWindow();
  win.webContents.once('did-finish-load', () => manager.connectAuto());

  app.on('activate', showWindow);
});

// the main window only really closes when quitting, so this means the app is done
app.on('window-all-closed', () => {
  if (!quitting) return; // only terminal windows were closed while the main one is hidden
  manager?.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  manager?.shutdown();
});

/* global Terminal, FitAddon */
'use strict';

const api = window.term;
const $ = (s) => document.querySelector(s);

const xterm = new Terminal({
  cursorBlink: true,
  fontFamily: 'Cascadia Mono, Consolas, ui-monospace, monospace',
  fontSize: 14,
  scrollback: 5000,
  allowProposedApi: false,
  theme: {
    background: '#0d0d0d',
    foreground: '#f0efec',
    cursor: '#f0efec',
    selectionBackground: 'rgba(57, 135, 229, 0.4)',
  },
});
const fit = new FitAddon.FitAddon();
xterm.loadAddon(fit);
xterm.open($('#screen'));
fit.fit();

let live = false;

function setState(cls, text) {
  $('#state').className = `st ${cls}`;
  $('#state').textContent = text;
  $('#reconnect').hidden = cls !== 'crit' && cls !== 'idle';
}

async function connect(passphrase) {
  live = true;
  setState('warn', 'Connecting…');
  const info = await api.start(xterm.cols, xterm.rows, passphrase);
  if (!info) { setState('crit', 'Server not found'); live = false; return; }
  document.title = `${info.name} — terminal`;
  $('#name').textContent = info.name;
  $('#target').textContent = info.target;
  $('#swatch').style.background = info.color || '';
  xterm.focus();
}

api.onReady(() => setState('good', 'Connected'));
api.onData((data) => xterm.write(data));
api.onExit(({ message, code }) => {
  live = false;
  setState(code ? 'crit' : 'idle', code ? 'Error' : 'Disconnected');
  xterm.write(`\r\n\x1b[${code ? 31 : 90}m[${message}]\x1b[0m\r\n\x1b[90mPress Enter to reconnect.\x1b[0m\r\n`);
  if (code === 'NEED_PASSPHRASE') askPassphrase();
});

xterm.onData((data) => {
  if (live) api.input(data);
  else if (data === '\r' && !$('#passDialog').open) connect();
});
xterm.onResize(({ cols, rows }) => api.resize(cols, rows));
new ResizeObserver(() => fit.fit()).observe($('#screen'));

// Ctrl+Shift+C / Ctrl+Shift+V copy and paste; plain Ctrl+C still sends SIGINT.
xterm.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
  if (e.code === 'KeyC') {
    if (xterm.hasSelection()) navigator.clipboard.writeText(xterm.getSelection());
    return false;
  }
  if (e.code === 'KeyV') {
    navigator.clipboard.readText().then((t) => { if (t) xterm.paste(t); });
    return false;
  }
  return true;
});
// right click: copy the selection if there is one, otherwise paste
$('#screen').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (xterm.hasSelection()) { navigator.clipboard.writeText(xterm.getSelection()); xterm.clearSelection(); }
  else navigator.clipboard.readText().then((t) => { if (t) xterm.paste(t); });
});

function askPassphrase() {
  $('#passForm').reset();
  $('#passDialog').showModal();
}
$('#passCancel').addEventListener('click', () => { $('#passDialog').close(); xterm.focus(); });
$('#passForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pass = $('#passForm').elements.passphrase.value;
  $('#passDialog').close();
  if (pass) connect(pass);
});
$('#reconnect').addEventListener('click', () => connect());

connect();

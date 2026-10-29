const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('term', {
  start: (cols, rows, passphrase) => ipcRenderer.invoke('term:start', cols, rows, passphrase),
  input: (data) => ipcRenderer.send('term:input', data),
  resize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
  onReady: on('term:ready'),
  onData: on('term:data'),
  onExit: on('term:exit'),
});

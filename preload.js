const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('vpsmon', {
  info: () => ipcRenderer.invoke('app:info'),
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServer: (profile) => ipcRenderer.invoke('servers:save', profile),
  deleteServer: (id) => ipcRenderer.invoke('servers:delete', id),
  reorderServers: (ids) => ipcRenderer.invoke('servers:reorder', ids),
  testServer: (profile, passphrase) => ipcRenderer.invoke('servers:test', profile, passphrase),
  connect: (id, passphrase) => ipcRenderer.invoke('server:connect', id, passphrase),
  disconnect: (id) => ipcRenderer.invoke('server:disconnect', id),
  connectAll: () => ipcRenderer.invoke('servers:connectAll'),
  disconnectAll: () => ipcRenderer.invoke('servers:disconnectAll'),
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),
  onSample: on('sample'),
  onStatus: on('status'),
  onLog: on('log'),
  onServers: on('servers'),
});

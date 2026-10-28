const { contextBridge, ipcRenderer } = require('electron');

let seq = 0;

contextBridge.exposeInMainWorld('capri', {
  chat(messages, onToken) {
    const id = ++seq;
    const handler = (_e, msg) => {
      if (msg.id === id) onToken(msg);
    };
    ipcRenderer.on('chat:event', handler);
    return ipcRenderer.invoke('chat:start', { id, messages }).finally(() => {
      ipcRenderer.removeListener('chat:event', handler);
    });
  },
  abort: () => ipcRenderer.send('chat:abort'),
  getFeedback: () => ipcRenderer.invoke('feedback:get'),
  setFeedback: (on) => ipcRenderer.invoke('feedback:set', on),
  model: () => ipcRenderer.invoke('chat:model'),
  hide: () => ipcRenderer.invoke('window:hide'),
  mini: (on) => ipcRenderer.invoke('window:mini', on),
  getBounds: () => ipcRenderer.invoke('window:get-bounds'),
  setBounds: (b) => ipcRenderer.send('window:set-bounds', b),
  onCursor: (cb) => ipcRenderer.on('eyes:cursor', (_e, p) => cb(p)),
  quit: () => ipcRenderer.invoke('window:quit'),
  onShown: (cb) => ipcRenderer.on('window:shown', () => cb()),
  onRequestHide: (cb) => ipcRenderer.on('window:request-hide', () => cb()),
});

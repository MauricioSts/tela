const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('picker', {
  fontes: () => ipcRenderer.invoke('picker:fontes'),
  escolher: (escolha) => ipcRenderer.send('picker:escolher', escolha),
  cancelar: () => ipcRenderer.send('picker:cancelar'),
});

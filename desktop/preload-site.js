/* Ponte mínima pro site: só serve pra página saber que está rodando dentro do
   app (e, na fase 2, oferecer as opções de áudio por processo). Nada de node
   exposto — o site é remoto. Preload é sandboxed, então nem require de arquivo
   nosso rola aqui: a versão vem do processo principal. */
const { contextBridge, ipcRenderer } = require('electron');
let info = { versao: '?', plataforma: process.platform };
try { info = ipcRenderer.sendSync('mimo:info') || info; } catch (_) { /* sem app? segue */ }
contextBridge.exposeInMainWorld('mimoDesktop', info);

/* Fumaça da casca: sobe o app de verdade, tira foto da janela e do seletor.
   Roda no Linux com xvfb só pra provar que a estrutura funciona — o áudio por
   processo é Windows e só dá pra validar lá. */
require('../main.js');
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const SHOTS = process.env.SHOTS || '/home/ubuntu/shots/desktop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* getSources com thumbnail demora — esperar por estado, não por relógio */
async function esperar(wc, expr, limite = 20000) {
  const fim = Date.now() + limite;
  while (Date.now() < fim) {
    if (await wc.executeJavaScript(expr)) return true;
    await sleep(250);
  }
  return false;
}
const salvar = async (win, nome) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, nome), img.toPNG());
  console.log('shot:', nome);
};
app.whenReady().then(async () => {
  setTimeout(() => { console.log('watchdog: passou do tempo, encerrando'); app.exit(1); }, 60000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const win = BrowserWindow.getAllWindows()[0];
  const erros = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') erros.push(e.message); });
  win.webContents.on('did-fail-load', (_e, code, desc) => erros.push('load falhou: ' + code + ' ' + desc));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(2500);
  console.log('url:', win.webContents.getURL());
  console.log('ponte mimoDesktop:', JSON.stringify(await win.webContents.executeJavaScript('window.mimoDesktop')));
  console.log('tem getDisplayMedia:', await win.webContents.executeJavaScript('!!navigator.mediaDevices.getDisplayMedia'));
  await salvar(win, 'app.png');

  // dispara o pedido de tela: quem responde é o nosso seletor
  win.webContents.executeJavaScript(
    'navigator.mediaDevices.getDisplayMedia({video:true,audio:true}).then(s=>({tracks:s.getTracks().map(t=>t.kind)}),e=>({erro:e.name}))', true)
    .then((r) => console.log('getDisplayMedia →', JSON.stringify(r)));
  await sleep(2500);
  const picker = BrowserWindow.getAllWindows().find((w) => w !== win);
  console.log('seletor abriu:', !!picker);
  if (picker) {
    picker.webContents.on('console-message', (e) => console.log('picker console[' + e.level + ']:', e.message));
    console.log('tem ponte picker:', await picker.webContents.executeJavaScript('typeof window.picker'));
    console.log('listou alguma fonte:', await esperar(picker.webContents, 'document.querySelectorAll(".src").length>0'));
    console.log('grid:', (await picker.webContents.executeJavaScript('document.getElementById("grid").innerText')).slice(0,120));
    console.log('fontes listadas:', await picker.webContents.executeJavaScript('document.querySelectorAll(".src").length'));
    console.log('abas:', await picker.webContents.executeJavaScript('[...document.querySelectorAll(".tab")].map(t=>t.textContent).join(" | ")'));
    await salvar(picker, 'picker.png');
    // escolhe a primeira fonte e confirma. O áudio 'loopback' é Windows/macOS,
    // então no teste do Linux desliga pra não derrubar a captura de vídeo.
    await picker.webContents.executeJavaScript('document.querySelector(".src") ? (document.querySelector(".src").click(), 1) : 0');
    if (process.platform === 'linux') await picker.webContents.executeJavaScript('document.getElementById("aud").click()');
    console.log('botão liberado:', await picker.webContents.executeJavaScript('!document.getElementById("go").disabled'));
    await picker.webContents.executeJavaScript('document.getElementById("go").click()');
    await sleep(5000);
  }
  console.log('ERROS:', erros.length ? erros : 'nenhum');
  app.quit();
}).catch((e) => { console.error('smoke quebrou:', e); app.exit(1); });

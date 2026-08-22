/* MIMO desktop — casca nativa em volta do app web.
 *
 * Por que existe: no navegador o áudio da transmissão só pode vir do mix inteiro
 * do PC (vaza o Discord) ou de uma janela só (Chrome 141+). Num app nativo o
 * Windows deixa capturar o áudio POR PROCESSO — incluir só o jogo ou excluir só
 * o Discord — sem cabo virtual e sem depender do que a pessoa marcou na janela
 * do navegador. Esta casca é o que dá acesso a essa API; a interface continua
 * sendo a mesma página de sempre, carregada do site (deploy segue igual).
 */
const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, screen } = require('electron');
const path = require('node:path');

const SITE = process.env.MIMO_URL || 'https://tela.mauriciosts.com';
const ORIGEM = new URL(SITE).origin;

const debug = (...a) => { if (process.env.MIMO_DEBUG) console.log('[mimo]', ...a); };

let win = null;          // janela do app
let picker = null;       // janela do seletor de tela
let pedido = null;       // callback do getDisplayMedia esperando resposta
let cacheFontes = [];    // o que o seletor listou por último (ids valem só pra essa lista)

// uma instância só: clicar no atalho de novo traz a janela existente pra frente
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function criarJanela() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 380, minHeight: 560,
    backgroundColor: '#07080a',            // evita o flash branco antes da página pintar
    autoHideMenuBar: true,
    title: 'MIMO',
    webPreferences: {
      preload: path.join(__dirname, 'preload-site.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(SITE);

  // link de fora (Discord, vb-audio, etc.) abre no navegador do sistema
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ORIGEM)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGEM)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

/* Câmera/mic/tela: o app é o nosso próprio site, então não faz sentido perguntar
   de novo o que a página já perguntou — mas só pra ele. */
function configurarPermissoes(ses) {
  ses.setPermissionRequestHandler((wc, permissao, cb) => {
    const daCasa = (wc.getURL() || '').startsWith(ORIGEM);
    cb(daCasa && ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permissao));
  });
  ses.setPermissionCheckHandler((wc, permissao, origem) => {
    return (origem || '').startsWith(ORIGEM) &&
      ['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permissao);
  });
}

/* No Electron a janela nativa "escolha o que compartilhar" não existe: quem
   responde ao getDisplayMedia somos nós. Isso é o que destrava capturar a tela
   inteira e, na fase 2, o áudio sem o Discord. */
function configurarCaptura(ses) {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    debug('pedido de tela: video', request.videoRequested, '| audio', request.audioRequested);
    /* o callback é de uso único e recusar levanta TypeError no Electron (a
       página recebe AbortError do mesmo jeito) — então engole e nunca repete */
    let respondido = false;
    const responder = (r) => {
      if (respondido) return;
      respondido = true;
      debug('respondendo', { video: !!r.video, audio: r.audio || 'nenhum' });
      try { callback(r); } catch (e) { debug('callback recusou:', e.message); }
    };
    try {
      const escolha = await abrirPicker();
      if (!escolha) return responder({});                 // cancelou
      /* usa a MESMA lista que o seletor mostrou: enumerar de novo aqui devolve
         ids diferentes quando alguma janela abre ou fecha no meio do caminho */
      let fonte = cacheFontes.find((f) => f.id === escolha.id);
      if (!fonte) fonte = (await listarFontes()).find((f) => f.id === escolha.id);
      if (!fonte) { debug('a fonte escolhida sumiu:', escolha.id); return responder({}); }
      // 'loopback' = mix do PC (o que o navegador já fazia). A captura por
      // processo entra aqui na fase 2, trocando este campo por uma faixa nossa.
      // A chave 'audio' não pode existir valendo undefined: o Electron só aceita
      // WebFrameMain, 'loopback' ou 'loopbackWithMute'.
      const resposta = { video: fonte.src };
      if (escolha.audio) resposta.audio = 'loopback';
      responder(resposta);
    } catch (e) {
      console.error('captura:', e);
      responder({});
    }
  }, { useSystemPicker: false });
}

async function listarFontes() {
  const tam = { width: 320, height: 180 };
  const fontes = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: tam, fetchWindowIcons: true,
  });
  return fontes.map((f) => ({
    id: f.id,
    src: f,                                               // objeto cru pro callback
    nome: f.name,
    tipo: f.id.startsWith('screen') ? 'screen' : 'window',
    thumb: f.thumbnail.isEmpty() ? null : f.thumbnail.toDataURL(),
    icone: f.appIcon && !f.appIcon.isEmpty() ? f.appIcon.toDataURL() : null,
  }));
}

function abrirPicker() {
  return new Promise((resolve) => {
    if (picker) { picker.focus(); return resolve(null); }
    pedido = resolve;
    const pai = win;
    const area = screen.getPrimaryDisplay().workAreaSize;
    picker = new BrowserWindow({
      width: Math.min(900, area.width - 80), height: Math.min(640, area.height - 80),
      parent: pai || undefined, modal: !!pai, resizable: false, minimizable: false, maximizable: false,
      backgroundColor: '#0e1116', title: 'Compartilhar tela', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload-picker.js'), contextIsolation: true, sandbox: true },
    });
    picker.loadFile(path.join(__dirname, 'picker.html'));
    picker.on('closed', () => { picker = null; if (pedido) { pedido(null); pedido = null; } });
  });
}

ipcMain.on('mimo:info', (e) => { e.returnValue = { versao: app.getVersion(), plataforma: process.platform }; });
ipcMain.handle('picker:fontes', async () => {
  cacheFontes = await listarFontes();
  return cacheFontes.map(({ src, ...resto }) => resto);   // o objeto cru não atravessa o IPC
});
ipcMain.on('picker:escolher', (_e, escolha) => {
  if (pedido) { pedido(escolha); pedido = null; }
  if (picker) picker.close();
});
ipcMain.on('picker:cancelar', () => { if (picker) picker.close(); });

app.whenReady().then(() => {
  configurarPermissoes(session.defaultSession);
  configurarCaptura(session.defaultSession);
  criarJanela();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) criarJanela(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

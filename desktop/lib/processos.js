/* Lista de processos pro usuário escolher o que capturar (ou o que excluir).
 *
 * O modo EXCLUDE do WASAPI é por ÁRVORE: dá o PID do pai e ele tira os filhos
 * junto. Isso importa porque Discord, navegadores e a maioria dos jogos rodam
 * como vários processos — mirar num filho qualquer deixaria o resto passando. */
const { execFile } = require('node:child_process');

const ps = (script) => new Promise((resolve, reject) => {
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      if (err) return reject(err);
      const txt = (stdout || '').trim();
      if (!txt) return resolve([]);
      try {
        const j = JSON.parse(txt);
        resolve(Array.isArray(j) ? j : [j]);       // 1 item só não vira array
      } catch (e) { reject(new Error('não deu pra ler a lista de processos: ' + e.message)); }
    });
});

/* Só o que tem janela: é o que a pessoa reconhece na hora de escolher
   ("Discord", "League of Legends") em vez de 300 serviços do Windows. */
async function comJanela() {
  const lista = await ps(
    'Get-Process | Where-Object { $_.MainWindowTitle } | ' +
    'Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress');
  return lista
    .map((p) => ({ pid: p.Id, nome: p.ProcessName, titulo: p.MainWindowTitle }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

/* A raiz da árvore de um programa: o processo cujo pai não é do mesmo nome.
   Passar um filho pro modo EXCLUDE deixaria os irmãos vazando som. */
async function raizDe(nomeExe) {
  const nome = nomeExe.toLowerCase().endsWith('.exe') ? nomeExe : nomeExe + '.exe';
  const lista = await ps(
    `Get-CimInstance Win32_Process -Filter "Name='${nome.replace(/'/g, "''")}'" | ` +
    'Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress');
  if (!lista.length) return null;
  const pids = new Set(lista.map((p) => p.ProcessId));
  const raizes = lista.filter((p) => !pids.has(p.ParentProcessId));
  const escolhida = (raizes.length ? raizes : lista)
    .sort((a, b) => new Date(a.CreationDate) - new Date(b.CreationDate))[0];   // a mais antiga
  return escolhida ? escolhida.ProcessId : null;
}

const raizDoDiscord = () => raizDe('Discord');

module.exports = { comJanela, raizDe, raizDoDiscord };

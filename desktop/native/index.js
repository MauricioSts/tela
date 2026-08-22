/* O addon só existe no Windows. Em qualquer outro sistema (a VM de
   desenvolvimento é Linux) o require falha de propósito e quem chama trata:
   `disponivel()` responde false e o app segue com o mix do sistema. */
let nativo = null, erroCarga = null;
if (process.platform === 'win32') {
  try { nativo = require('./build/Release/mimo_loopback.node'); }
  catch (e) { erroCarga = e.message; }
}

const disponivel = () => !!nativo && nativo.suportado();

module.exports = {
  disponivel,
  motivo: () => (process.platform !== 'win32' ? 'só existe no Windows'
    : !nativo ? ('addon não carregou: ' + erroCarga)
    : !nativo.suportado() ? 'precisa do Windows 10 build 20348 ou mais novo' : null),
  formato: () => (nativo ? nativo.formato : { taxa: 48000, canais: 2, bits: 16 }),
  /* modo 'excluir' = tudo MENOS esse processo e filhos (ex.: tudo menos o Discord)
     modo 'incluir' = só esse processo e filhos (ex.: só o jogo) */
  start({ pid, modo = 'incluir', onData, onError }) {
    if (!disponivel()) throw new Error(module.exports.motivo() || 'indisponível');
    return nativo.start({ pid, modo, onData, onError: onError || (() => {}) });
  },
};

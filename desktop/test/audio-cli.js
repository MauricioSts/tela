/* Teste do addon nativo SEM envolver o app: grava alguns segundos em WAV.
 *
 * Só roda no Windows. Serve pra separar dois problemas que seriam difíceis de
 * distinguir juntos — "a captura por processo funciona?" e "o áudio chega
 * direito na transmissão?".
 *
 *   node test/audio-cli.js                     -> tudo MENOS o Discord, 8 s
 *   node test/audio-cli.js --lista             -> mostra os programas com janela
 *   node test/audio-cli.js --incluir 1234      -> só o processo 1234 (e filhos)
 *   node test/audio-cli.js --excluir 1234 -s 5 -> tudo menos o 1234, por 5 s
 */
const fs = require('node:fs');
const path = require('node:path');
const loopback = require('mimo-loopback');
const processos = require('../lib/processos');

const arg = (nome) => { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : null; };
const tem = (nome) => process.argv.includes(nome);

function cabecalhoWav({ taxa, canais, bits }, bytesDados) {
  const b = Buffer.alloc(44);
  const blockAlign = canais * bits / 8;
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytesDados, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(canais, 22); b.writeUInt32LE(taxa, 24);
  b.writeUInt32LE(taxa * blockAlign, 28); b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(bytesDados, 40);
  return b;
}

// pico do bloco, pra dizer na hora se está entrando som ou só silêncio
function pico(buf) {
  let max = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) max = Math.max(max, Math.abs(buf.readInt16LE(i)));
  return max / 32768;
}

(async () => {
  if (!loopback.disponivel()) {
    console.error('addon indisponível:', loopback.motivo());
    process.exit(1);
  }
  if (tem('--lista')) {
    const lista = await processos.comJanela();
    for (const p of lista) console.log(String(p.pid).padStart(7), p.nome.padEnd(24), p.titulo.slice(0, 50));
    return;
  }

  let pid = Number(arg('--incluir') || arg('--excluir')) || null;
  const modo = arg('--incluir') ? 'incluir' : 'excluir';
  let alvo = pid ? ('PID ' + pid) : 'Discord';
  if (!pid) {
    pid = await processos.raizDoDiscord();
    if (!pid) { console.error('Discord não está aberto — abra ele, ou passe --excluir <pid>'); process.exit(1); }
  }
  const segundos = Number(arg('-s') || arg('--segundos') || 8);
  const saida = path.resolve(arg('-o') || `captura-${modo}-${pid}.wav`);
  const fmt = loopback.formato();

  console.log(`${modo === 'excluir' ? 'TUDO MENOS' : 'SÓ'} ${alvo} (pid ${pid}) — ${segundos}s`);
  console.log('toque algum som agora (jogo, vídeo, música)…');

  const pedacos = [];
  let ultimoAviso = 0, maiorPico = 0;
  const cap = loopback.start({
    pid, modo,
    onData: (buf) => {
      pedacos.push(Buffer.from(buf));
      const p = pico(buf);
      maiorPico = Math.max(maiorPico, p);
      const agora = Date.now();
      if (agora - ultimoAviso > 1000) {
        ultimoAviso = agora;
        const barras = '#'.repeat(Math.round(p * 30));
        process.stdout.write(`\r  nível: ${barras.padEnd(30)} ${(p * 100).toFixed(0)}%   `);
      }
    },
    onError: (msg) => { console.error('\nerro na captura:', msg); },
  });

  setTimeout(() => {
    cap.stop();
    const dados = Buffer.concat(pedacos);
    fs.writeFileSync(saida, Buffer.concat([cabecalhoWav(fmt, dados.length), dados]));
    const dur = dados.length / (fmt.taxa * fmt.canais * fmt.bits / 8);
    console.log(`\n\ngravado: ${saida}`);
    console.log(`${dur.toFixed(1)}s de áudio, pico ${(maiorPico * 100).toFixed(0)}%`);
    if (maiorPico === 0) console.log('SÓ SILÊNCIO — nada tocou, ou o alvo/modo está errado.');
    else console.log('Abra o arquivo e confira: o que era pra ficar de fora está fora?');
  }, segundos * 1000);
})();

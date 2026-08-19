# PROMPT PARA A IA QUE VAI IMPLEMENTAR O MIMO

Cole este arquivo inteiro no chat da outra IA (Cursor / Claude Code / Copilot / etc.) junto com o arquivo `MIMO-standalone.html` (é o design de referência: abre em qualquer navegador, offline, e é interativo — clique em tudo antes de começar).

---

## 1. CONTEXTO — O QUE JÁ EXISTE HOJE

O app atual é um clone simples de Discord e, na prática, **a única coisa que funciona é a transmissão**. Confirmado pelo dono do produto:

**Funciona hoje:**
- entrar numa call (sala única, sem servidores)
- **transmitir a tela — o vídeo funciona bem, é o ponto forte atual**
- baixar o volume da transmissão
- chat de texto dentro da call

**NÃO existe (precisa ser criado do zero):**
- microfone (não captura / não é ouvido) — **é a maior prioridade**
- login com conta (e-mail e senha)
- servidores e canais
- chat de texto fora da call
- amizades, pedidos, presença/status
- grupos e DMs
- call persistente ao navegar entre telas
- sons de sistema (entrar, sair, mensagem)

Ou seja: **preserve e reaproveite o pipeline de vídeo/transmissão que já funciona**, e construa todo o resto em volta dele.

O produto final se chama **MIMO** — app de voz/vídeo para gamers, com identidade visual própria (nada de roxo/blurple, nada de cara de Discord).

## 2. ARQUIVO DE DESIGN (COMPARAR PIXEL A PIXEL)

`MIMO-standalone.html` — protótipo funcional completo, offline e clicável. Ele contém:

- tela de login/cadastro (e-mail + senha + nick), com a logo MIMO e uma lista curta do que o app faz
- shell do app: rail de servidores (logo no topo), sidebar com `#chat-geral` + salas de voz, painel do usuário com medidor de microfone
- `#chat-geral` do servidor (chat de texto do grupo, histórico por servidor)
- tela de amigos (pedidos recebidos/enviados, aceitar/recusar, chamar, criar grupo)
- tela de call com tiles dos participantes, indicador de quem está falando, chat da call
- **barra de voz persistente no rodapé**: continua visível em qualquer tela enquanto você estiver conectado, com mic, modo de áudio, transmitir tela, volume da transmissão e desligar
- sons de entrada, saída, mensagem, toggle e transmissão (WebAudio sintetizado, sem arquivos)
- responsivo: rail vira faixa horizontal e sidebar vira gaveta (☰) abaixo de 860px; chat da call vira overlay abaixo de 1180px

**Regra:** o resultado final deve ficar visualmente idêntico a esse arquivo. Extraia dele cores, tipografia, espaçamentos, estados de hover e microinterações.

### Marca

- Nome: **MIMO** (caixa alta, Chakra Petch 700, `letter-spacing: .3em`).
- Logo: monograma "M" em lima `#ceff36` sobre disco escuro, formato circular. Usada no login (64px), no login mobile (44px) e no topo do rail (38px).

### Tokens de design (retirados do protótipo)

```
Fundo base        #07080a      Painel        #0e1116 / #0a0c10
Linhas            rgba(255,255,255,.07)
Texto             #e8ecf2      Secundário    #8d95a5     Terciário #5f6777
Acento primário   #ceff36  (lima ácido — ações, "falando", mic ativo)
Alerta / live     #ff2d7a  (rosa — sair, gravando, pedidos)
Info              #35e5ff  (ciano — amigos, grupos, modo de áudio)
Transmissão       #ffb020  (âmbar — tela compartilhada)
Especiais         #a97bff (torneio)  #5df2a0 (foco/conectado)

Display/UI: Chakra Petch 600/700 (títulos, nomes, botões)
Corpo:      Barlow 400/500/600
Dados/HUD:  JetBrains Mono 400/700, letter-spacing .12–.26em, CAIXA ALTA

Formas: cantos cortados (clip-path polygon) em cards/botões primários;
avatares e emblemas em hexágono; grid de fundo 56px; glows radiais lima e rosa.
Sem bordas arredondadas grandes, sem gradientes coloridos de fundo, sem emoji.
```

## 3. CORREÇÃO PRIORITÁRIA: MICROFONE COM QUALIDADE ABSURDA

O mic é o coração do produto e hoje **não funciona**. Requisitos:

1. **Captura**
   ```js
   navigator.mediaDevices.getUserMedia({ audio: {
     echoCancellation: false, noiseSuppression: false, autoGainControl: false,
     channelCount: 2, sampleRate: 48000, sampleSize: 24, latency: 0.01
   }})
   ```
   Dois modos alternáveis pelo usuário, mostrados na barra de voz:
   - **ESTÚDIO**: constraints acima (cru, estéreo, 48kHz) — para quem tem interface/microfone bom.
   - **VOZ**: `echoCancellation/noiseSuppression/autoGainControl = true`, mono — para notebook/fone bluetooth.
   Ao trocar o modo, re-obter o track e refazer o pipeline.

2. **Transporte (WebRTC)**
   - Codec **Opus** com `sdpFmtpLine`: `maxaveragebitrate=128000; stereo=1; sprop-stereo=1; useinbandfec=1; usedtx=0; cbr=0`
   - Reordenar o SDP para priorizar Opus e aplicar via `RTCRtpSender.setParameters` (`maxBitrate: 128000`, `priority: 'high'`, `networkPriority: 'high'`).
   - `ptime=10` para latência baixa; DTX desligado (evita cortes no começo da fala).
   - SFU repassando sem transcodificar o áudio.

3. **Pipeline local**
   - `AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })`
   - `AnalyserNode` (fftSize 1024, smoothing .7) para o medidor de nível — o medidor aparece no painel do usuário, na barra de voz e como anel no tile de quem fala.
   - Gate opcional (limiar ~-50dB) e limiter suave só no modo VOZ; **nada** no modo ESTÚDIO.
   - Seletor de dispositivo de entrada (`enumerateDevices`) e teste de mic ("fale para ver o nível").
   - Tratar rejeição de permissão com aviso claro e botão para tentar de novo.

4. **Diagnóstico visível**: mostrar no HUD o real `sampleRate`/`channelCount` obtidos via `track.getSettings()` — o usuário precisa ver "48kHz · 2ch".

## 4. CALL PERSISTENTE (COMO NO DISCORD)

- Estado da conexão de voz **fora** da rota/tela. Trocar de servidor, abrir amigos, ler o `#chat-geral` — nada disso derruba a call.
- **Barra de voz fixa no rodapé** sempre que houver conexão, contendo: emblema + nome da sala, tempo conectado, ping, especificação de áudio, medidor ao vivo, botão MIC, botão de modo (ESTÚDIO/VOZ), **TRANSMITIR/PARAR TELA**, slider de volume da transmissão e DESLIGAR. Clicar no nome volta para a tela da call.
- Transmitir a tela **direto da barra**, sem precisar abrir a call.
- No mobile a barra fica acima do conteúdo, com wrap dos controles; alvos de toque ≥ 44px.

## 5. TELA COMPARTILHADA (já funciona — só elevar)

- `getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: { channelCount: 2, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`
- Mostrar a especificação real da captura (`2560×1440 · 60fps`) no rótulo "TRANSMITINDO".
- Ouvir o evento `ended` do track (usuário para pela barra do navegador) e sincronizar o estado.
- Slider de volume controla o áudio da transmissão recebida (`audioElement.volume` / GainNode por participante), não o mic.
- No SFU: `contentHint = 'detail'` para tela, `maxBitrate` 8–12 Mbps, `degradationPreference: 'maintain-resolution'`.

## 6. FEATURES A CRIAR (ordem sugerida)

1. **Microfone funcionando** (seção 3) — sem isso o resto não importa.
2. **Contas**: e-mail + senha (hash argon2/bcrypt), sessão JWT + refresh, "esqueci a senha" por e-mail, nick separado do e-mail.
3. **Call persistente** + barra de voz (seção 4).
4. **Servidores**: criar (nome + cor do emblema), entrar por convite, cada servidor nasce com `#chat-geral` + 1 sala de voz. Emblema = iniciais em hexágono na cor escolhida.
5. **Chat de texto** (`#chat-geral` e canais extras): histórico persistente, mensagens em tempo real (WebSocket), autor + horário + badge de cargo, indicador de "digitando", presença no cabeçalho.
6. **Salas de voz com formato**: VOZ, VÍDEO, PALCO (poucos falam, muitos ouvem), ASSISTIR (tela em foco), TORNEIO, ESTUDO (mudo por padrão). O formato define layout e permissões.
7. **Amizades**: pedido por `nick#0000`, listas online/todos/pedidos/enviados, aceitar/recusar/cancelar, status (online, em call, offline com "visto há X").
8. **Grupos/DM**: criar grupo selecionando amigos, chamada de grupo em 1 clique, DM 1-a-1 com histórico.
9. **Sons do sistema** (WebAudio sintetizado, sem assets): entrar (523→784Hz), sair (587→330Hz), mensagem (1046Hz sine), toggle on/off (880/420Hz square), transmissão (660→990→1320Hz), erro (180Hz saw). Volume configurável e opção de silenciar.
10. **Extras que valem muito**: push-to-talk com tecla configurável, indicador de quem está falando na sidebar, "modo ninja" (entrar mudo), gravação local da call, overlay in-game (Electron), estatísticas de conexão (jitter, packet loss, bitrate real).

## 7. ARQUITETURA SUGERIDA

- Front: React + TypeScript, estado de voz num contexto global (fora do router) para a call sobreviver à navegação.
- Voz/vídeo: SFU **LiveKit** ou **mediasoup** (não use full-mesh acima de 4 pessoas).
- Tempo real de texto/presença: WebSocket próprio ou Socket.IO, com Redis pub/sub.
- Banco: Postgres (users, servers, members, channels, messages, rooms, friendships, groups).
- TURN próprio (coturn) — sem isso ~15% dos usuários não conectam.

## 8. CRITÉRIOS DE ACEITE

- [ ] Falar no mic e ser ouvido em 48kHz estéreo, sem cortes no início da fala, com medidor reagindo em tempo real.
- [ ] Trocar de tela/servidor/aba sem cair da call.
- [ ] Transmitir a tela a partir da barra de voz, com áudio, e parar pela barra ou pelo navegador.
- [ ] Criar conta, criar servidor, criar sala, mandar e aceitar pedido de amizade, criar grupo e chamar o grupo.
- [ ] Mensagens do `#chat-geral` persistem após recarregar.
- [ ] Sons de entrada/saída/mensagem tocando e silenciáveis.
- [ ] Visual idêntico ao `MIMO-standalone.html` no desktop, no intervalo 860–1180px e no mobile.

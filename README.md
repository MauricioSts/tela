# tela

Call de vídeo/compartilhamento de tela P2P via WebRTC — uma sala fixa em full mesh
(até 5 pessoas), estilo call do Discord: todos transmitem e assistem numa grade,
com chat e volume master. PCs transmitem (`getDisplayMedia`); celulares só assistem
(Safari/iOS não tem `getDisplayMedia`).

## Componentes

- `server.js` — servidor HTTP estático + sinalização WebSocket (`ws`) numa sala fixa.
  Roda na porta `8080` (systemd `tela.service`).
- `public/room.html` — página única da sala (perfect negotiation, grade de tiles, chat).
- `turnserver.conf` — template do coturn (TURN de fallback, credenciais estáticas).
- `Caddyfile` — bloco do reverse proxy (`/ws` → `:8080`) + file server, HTTPS/wss.

## Configuração

Os segredos (token de auth e credencial do TURN) **não** ficam no código. Copie o
exemplo e preencha:

```sh
cp .env.example .env   # edite os valores
npm install
npm start
```

O `server.js` lê `TELA_TOKEN` / `TELA_TURN_*` do ambiente e os injeta no `room.html`
em tempo de request. Em produção o `.env` é carregado pelo systemd (`EnvironmentFile`).

Veja `setup.md` para o passo a passo completo (coturn, Caddy, iptables, DNS).

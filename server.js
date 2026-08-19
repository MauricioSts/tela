'use strict';

// Sinalização mesh: uma sala fixa com até MAX_PEERS pessoas.
// Todo mundo pode transmitir e assistir (full mesh). O servidor só roteia
// mensagens direcionadas (campo `to`), marca o remetente (`from`) e faz
// broadcast do chat. Também serve os arquivos estáticos.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Auth mínima: token fixo na query string, vindo do ambiente (.env / systemd).
const TOKEN = process.env.TELA_TOKEN || '';
// Sala comporta 5 pessoas: assim cada tela pode ter até 4 assistindo.
const MAX_PEERS = 5;

// Config do cliente injetada no room.html em tempo de request — mantém o token
// e a credencial do TURN fora do código versionado (vêm todos do .env / systemd).
const TURN_URL = process.env.TELA_TURN_URL || 'turn:tela.mauriciosts.com:3478?transport=udp';
const TURN_USER = process.env.TELA_TURN_USER || 'telauser';
const TURN_PASSWORD = process.env.TELA_TURN_PASSWORD || '';
const ICE_JSON = JSON.stringify([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: TURN_URL, username: TURN_USER, credential: TURN_PASSWORD },
]);

if (!TOKEN) console.warn('[aviso] TELA_TOKEN não definido — configure o .env (veja .env.example).');

// ---- Servidor HTTP estático ----------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/room.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = data;
    if (path.extname(filePath) === '.html') {
      body = data.toString('utf8')
        .replaceAll('__TELA_TOKEN__', TOKEN)
        .replaceAll('__TELA_ICE_JSON__', ICE_JSON);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  });
});

// ---- Sinalização WebSocket -----------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

const peers = new Map(); // id -> socket
let nextId = 1;

function send(sock, obj) {
  if (sock && sock.readyState === sock.OPEN) sock.send(JSON.stringify(obj));
}

// Chat: broadcast pra todos menos quem enviou.
function relayChat(msg, from) {
  const out = { type: 'chat', name: String(msg.name || '?').slice(0, 24), text: String(msg.text || '').slice(0, 500), system: !!msg.system };
  if (!out.text) return;
  for (const ps of peers.values()) if (ps !== from) send(ps, out);
}

wss.on('connection', (sock, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  if (params.get('token') !== TOKEN) {
    send(sock, { type: 'error', reason: 'auth' });
    sock.close();
    return;
  }
  if (peers.size >= MAX_PEERS) {
    send(sock, { type: 'full' });
    sock.close();
    return;
  }

  const id = nextId++;
  peers.set(id, sock);
  console.log(`[+] peer#${id} entrou (total=${peers.size})`);

  // Novo peer recebe a lista dos existentes; os existentes são avisados do novo.
  send(sock, { type: 'welcome', id, peers: [...peers.keys()].filter((p) => p !== id) });
  for (const [pid, ps] of peers) if (pid !== id) send(ps, { type: 'new-peer', id });

  sock.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.type === 'chat') { relayChat(msg, sock); return; }
    // Sinalização direcionada a um peer específico.
    if (msg.to != null) {
      const target = peers.get(msg.to);
      if (target) { msg.from = id; send(target, msg); }
    }
  });

  sock.on('close', () => {
    if (peers.get(id) === sock) {
      peers.delete(id);
      console.log(`[-] peer#${id} saiu (total=${peers.size})`);
      for (const ps of peers.values()) send(ps, { type: 'peer-left', id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`tela-share (mesh) ouvindo em http://0.0.0.0:${PORT} (max ${MAX_PEERS} na sala)`);
});

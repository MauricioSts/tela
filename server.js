'use strict';

// ===========================================================================
// MIMO — backend
// Contas (e-mail+senha), servidores/canais, chat de texto persistente e
// sinalização de voz (mesh) escopada por sala. Sem dependências externas de
// infra: banco em node:sqlite (arquivo local), hash de senha via scrypt e
// tokens assinados via HMAC (ambos do módulo `crypto`).
// A voz continua em full mesh (até MAX_VOICE por sala) — SFU fica pra depois.
// ===========================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'mimo.db');
const MAX_VOICE = 5;

// Segredo estável pra assinar tokens: reusa o TELA_TOKEN do .env (já secreto e
// persistente). Sem ele, gera um efêmero (tokens caem no restart).
const SECRET = process.env.TELA_JWT_SECRET || process.env.TELA_TOKEN || crypto.randomBytes(32).toString('hex');

// Config do cliente injetada no HTML em tempo de request (fora do versionado).
const TURN_URL = process.env.TELA_TURN_URL || 'turn:tela.mauriciosts.com:3478?transport=udp';
const TURN_USER = process.env.TELA_TURN_USER || 'telauser';
const TURN_PASSWORD = process.env.TELA_TURN_PASSWORD || '';
const ICE_JSON = JSON.stringify([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: TURN_URL, username: TURN_USER, credential: TURN_PASSWORD },
]);

// ===================== Banco =============================================
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    nick TEXT NOT NULL,
    tag TEXT NOT NULL,            -- discriminador nick#0000
    pass TEXT NOT NULL,
    color TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    invite TEXT UNIQUE NOT NULL,
    owner INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    server INTEGER NOT NULL,
    user INTEGER NOT NULL,
    PRIMARY KEY (server, user)
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,          -- 'text' | 'voice'
    fmt TEXT,                    -- formato da sala de voz
    pos INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel INTEGER NOT NULL,
    user INTEGER NOT NULL,
    nick TEXT NOT NULL,
    color TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel, id);
  CREATE TABLE IF NOT EXISTS friendships (
    a INTEGER NOT NULL,          -- quem pediu
    b INTEGER NOT NULL,          -- quem recebeu
    status TEXT NOT NULL,        -- 'pending' | 'accepted'
    ts INTEGER NOT NULL,
    PRIMARY KEY (a, b)
  );
`);
// migração idempotente: capacidade da sala de voz (salas antigas ficam null → 5)
try { db.exec('ALTER TABLE channels ADD COLUMN cap INTEGER'); } catch { /* já existe */ }

const COLORS = ['#ceff36', '#ff2d7a', '#35e5ff', '#ffb020', '#a97bff', '#5df2a0'];
const FORMATS = ['voz', 'video', 'palco', 'assistir', 'torneio', 'estudo'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const now = () => Date.now();

// Seed: servidor MIMO com #chat-geral e uma sala de voz.
function seed() {
  const s = db.prepare('SELECT id FROM servers WHERE invite = ?').get('MIMO');
  if (s) return s.id;
  const info = db.prepare('INSERT INTO servers (name,color,invite,owner,created) VALUES (?,?,?,?,?)')
    .run('MIMO', '#ceff36', 'MIMO', 0, now());
  const sid = info.lastInsertRowid;
  db.prepare('INSERT INTO channels (server,name,kind,fmt,pos) VALUES (?,?,?,?,?)').run(sid, 'chat-geral', 'text', null, 0);
  db.prepare('INSERT INTO channels (server,name,kind,fmt,pos) VALUES (?,?,?,?,?)').run(sid, 'Sala Geral', 'voice', 'voz', 1);
  return sid;
}
const MIMO_SERVER = seed();

// ===================== Auth =============================================
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${dk}`;
}
function verifyPass(pw, stored) {
  const [, salt, dk] = stored.split('$');
  if (!salt || !dk) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const a = Buffer.from(dk, 'hex');
  return a.length === test.length && crypto.timingSafeEqual(a, test);
}
const b64u = (b) => Buffer.from(b).toString('base64url');
function signToken(payload) {
  const body = b64u(JSON.stringify({ ...payload, exp: now() + 30 * 864e5 })); // 30 dias
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== good) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < now()) return null;
    return p;
  } catch { return null; }
}
function uniqueTag(nick) {
  for (let i = 0; i < 20; i++) {
    const tag = String(Math.floor(1000 + Math.random() * 9000));
    if (!db.prepare('SELECT 1 FROM users WHERE nick=? AND tag=?').get(nick, tag)) return tag;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

function publicUser(u) {
  return { id: u.id, nick: u.nick, tag: u.tag, color: u.color, email: u.email };
}
function userServers(uid) {
  const rows = db.prepare(`
    SELECT s.* FROM servers s JOIN members m ON m.server=s.id WHERE m.user=? ORDER BY s.id
  `).all(uid);
  return rows.map((s) => ({
    id: s.id, name: s.name, color: s.color, invite: s.invite,
    channels: db.prepare('SELECT id,name,kind,fmt,pos,cap FROM channels WHERE server=? ORDER BY pos,id').all(s.id),
  }));
}
function ensureMember(uid, sid) {
  db.prepare('INSERT OR IGNORE INTO members (server,user) VALUES (?,?)').run(sid, uid);
}
function friendsOf(uid) {
  const rows = db.prepare(`
    SELECT * FROM friendships WHERE a=? OR b=?
  `).all(uid, uid);
  const map = (id) => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(id); return u ? publicUser(u) : null; };
  return {
    friends: rows.filter((r) => r.status === 'accepted').map((r) => map(r.a === uid ? r.b : r.a)).filter(Boolean),
    incoming: rows.filter((r) => r.status === 'pending' && r.b === uid).map((r) => map(r.a)).filter(Boolean),
    outgoing: rows.filter((r) => r.status === 'pending' && r.a === uid).map((r) => map(r.b)).filter(Boolean),
  };
}

// ===================== HTTP API =========================================
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const p = verifyToken(h.replace(/^Bearer\s+/i, ''));
  if (!p) return null;
  return db.prepare('SELECT * FROM users WHERE id=?').get(p.uid) || null;
}

async function api(req, res, url) {
  const p = url.pathname;
  try {
    if (p === '/api/register' && req.method === 'POST') {
      const { email, password, nick } = await readBody(req);
      const em = String(email || '').trim().toLowerCase();
      const nk = String(nick || '').trim().slice(0, 22);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return sendJSON(res, 400, { error: 'E-mail inválido.' });
      if (String(password || '').length < 6) return sendJSON(res, 400, { error: 'Senha precisa de 6+ caracteres.' });
      if (nk.length < 2) return sendJSON(res, 400, { error: 'Escolha um nick.' });
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(em)) return sendJSON(res, 409, { error: 'E-mail já cadastrado.' });
      const color = pick(COLORS);
      const info = db.prepare('INSERT INTO users (email,nick,tag,pass,color,created) VALUES (?,?,?,?,?,?)')
        .run(em, nk, uniqueTag(nk), hashPass(String(password)), color, now());
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
      ensureMember(u.id, MIMO_SERVER);
      return sendJSON(res, 200, { token: signToken({ uid: u.id }), user: publicUser(u), servers: userServers(u.id) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
      if (!u || !verifyPass(String(password || ''), u.pass)) return sendJSON(res, 401, { error: 'E-mail ou senha incorretos.' });
      ensureMember(u.id, MIMO_SERVER);
      return sendJSON(res, 200, { token: signToken({ uid: u.id }), user: publicUser(u), servers: userServers(u.id) });
    }

    // daqui pra baixo exige auth
    const me = authUser(req);
    if (!me) return sendJSON(res, 401, { error: 'auth' });

    if (p === '/api/me' && req.method === 'GET') {
      ensureMember(me.id, MIMO_SERVER);
      return sendJSON(res, 200, { user: publicUser(me), servers: userServers(me.id), ...friendsOf(me.id) });
    }

    if (p === '/api/messages' && req.method === 'GET') {
      const ch = Number(url.searchParams.get('channel'));
      const rows = db.prepare('SELECT id,user,nick,color,text,ts FROM messages WHERE channel=? ORDER BY id DESC LIMIT 50').all(ch);
      return sendJSON(res, 200, { messages: rows.reverse() });
    }

    if (p === '/api/servers' && req.method === 'POST') {
      const { name, color } = await readBody(req);
      const nm = String(name || '').trim().slice(0, 30);
      if (nm.length < 2) return sendJSON(res, 400, { error: 'Nome curto demais.' });
      const invite = crypto.randomBytes(4).toString('hex');
      const info = db.prepare('INSERT INTO servers (name,color,invite,owner,created) VALUES (?,?,?,?,?)')
        .run(nm, COLORS.includes(color) ? color : pick(COLORS), invite, me.id, now());
      const sid = info.lastInsertRowid;
      db.prepare('INSERT INTO channels (server,name,kind,fmt,pos) VALUES (?,?,?,?,?)').run(sid, 'chat-geral', 'text', null, 0);
      db.prepare('INSERT INTO channels (server,name,kind,fmt,pos) VALUES (?,?,?,?,?)').run(sid, 'Sala Geral', 'voice', 'voz', 1);
      ensureMember(me.id, sid);
      return sendJSON(res, 200, { servers: userServers(me.id) });
    }

    if (p === '/api/rooms' && req.method === 'POST') {
      const { server, name, fmt, cap } = await readBody(req);
      const sid = Number(server);
      if (!db.prepare('SELECT 1 FROM members WHERE server=? AND user=?').get(sid, me.id)) return sendJSON(res, 403, { error: 'Você não está nesse servidor.' });
      const nm = String(name || '').trim().slice(0, 30);
      if (nm.length < 2) return sendJSON(res, 400, { error: 'Nome curto demais.' });
      const f = FORMATS.includes(fmt) ? fmt : 'voz';
      const cp = Math.max(2, Math.min(200, Math.round(Number(cap) || 5)));
      const pos = (db.prepare('SELECT MAX(pos) m FROM channels WHERE server=?').get(sid).m || 0) + 1;
      db.prepare('INSERT INTO channels (server,name,kind,fmt,pos,cap) VALUES (?,?,?,?,?,?)').run(sid, nm, 'voice', f, pos, cp);
      return sendJSON(res, 200, { servers: userServers(me.id) });
    }

    if (p === '/api/join' && req.method === 'POST') {
      const { invite } = await readBody(req);
      const s = db.prepare('SELECT id FROM servers WHERE invite=?').get(String(invite || '').trim());
      if (!s) return sendJSON(res, 404, { error: 'Convite inválido.' });
      ensureMember(me.id, s.id);
      return sendJSON(res, 200, { servers: userServers(me.id) });
    }

    if (p === '/api/friends/request' && req.method === 'POST') {
      const { handle } = await readBody(req);
      const m = String(handle || '').match(/^(.+)#(\d{4})$/);
      if (!m) return sendJSON(res, 400, { error: 'Use nick#0000.' });
      const other = db.prepare('SELECT * FROM users WHERE nick=? AND tag=?').get(m[1].trim(), m[2]);
      if (!other) return sendJSON(res, 404, { error: 'Ninguém com esse nick#tag.' });
      if (other.id === me.id) return sendJSON(res, 400, { error: 'Esse é você :)' });
      const exists = db.prepare('SELECT * FROM friendships WHERE (a=? AND b=?) OR (a=? AND b=?)').get(me.id, other.id, other.id, me.id);
      if (exists) return sendJSON(res, 409, { error: 'Já existe pedido/amizade.' });
      db.prepare('INSERT INTO friendships (a,b,status,ts) VALUES (?,?,?,?)').run(me.id, other.id, 'pending', now());
      pushTo(other.id, { type: 'friend-update' });
      return sendJSON(res, 200, friendsOf(me.id));
    }

    if (p === '/api/friends/accept' && req.method === 'POST') {
      const { id } = await readBody(req);
      db.prepare('UPDATE friendships SET status=? WHERE a=? AND b=?').run('accepted', Number(id), me.id);
      pushTo(Number(id), { type: 'friend-update' });
      return sendJSON(res, 200, friendsOf(me.id));
    }
    if (p === '/api/friends/decline' && req.method === 'POST') {
      const { id } = await readBody(req);
      db.prepare('DELETE FROM friendships WHERE (a=? AND b=?) OR (a=? AND b=?)').run(Number(id), me.id, me.id, Number(id));
      pushTo(Number(id), { type: 'friend-update' });
      return sendJSON(res, 200, friendsOf(me.id));
    }

    return sendJSON(res, 404, { error: 'rota' });
  } catch (e) {
    console.error('api', e);
    return sendJSON(res, 500, { error: 'erro interno' });
  }
}

// ===================== HTTP estático ====================================
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return void api(req, res, url);
  if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }

  const rel = url.pathname === '/' ? '/room.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    let body = data;
    if (path.extname(filePath) === '.html') {
      body = data.toString('utf8').replaceAll('__TELA_ICE_JSON__', ICE_JSON);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  });
});

// ===================== WebSocket ========================================
// Uma conexão por usuário (a última vence). Presença por servidor e mesh de
// voz por sala. Sinalização direcionada por userId.
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map();           // userId -> Set(socket)  (vários aparelhos)
const voiceSock = new Map();         // userId -> socket que está na sala de voz
const voiceRooms = new Map();        // channelId -> Set(userId)

function send(sock, obj) { if (sock && sock.readyState === sock.OPEN) sock.send(JSON.stringify(obj)); }
function pushTo(uid, obj) { const set = sockets.get(uid); if (set) for (const s of set) send(s, obj); }
function pushVoice(uid, obj) { send(voiceSock.get(uid), obj); }  // só a sessão que está na call

function roomOf(uid) { for (const [cid, set] of voiceRooms) if (set.has(uid)) return cid; return null; }
function leaveVoice(uid) {
  voiceSock.delete(uid);
  const cid = roomOf(uid); if (cid == null) return;
  voiceRooms.get(cid).delete(uid);
  for (const pid of voiceRooms.get(cid)) pushVoice(pid, { type: 'voice-left', room: cid, id: uid });
  if (voiceRooms.get(cid).size === 0) voiceRooms.delete(cid);
}

// ---- aviso no Discord quando alguém começa a transmitir ----
// A URL vem do .env (é um segredo: quem tem ela posta no canal). Um aviso por
// pessoa a cada 45s, pra um clique errado em transmitir/parar não virar spam.
const DISCORD_WEBHOOKS = (process.env.TELA_DISCORD_WEBHOOK || '')
  .split(/[\s,;]+/).map((u) => u.trim()).filter((u) => u.startsWith('http'));   // um ou vários canais
const SITE_URL = process.env.TELA_SITE_URL || 'https://tela.mauriciosts.com';
const lastShareNotify = new Map();
function notifyShareStarted(uid, user, cid) {
  if (!DISCORD_WEBHOOKS.length) return;
  const t = Date.now();
  if (t - (lastShareNotify.get(uid) || 0) < 45000) return;
  lastShareNotify.set(uid, t);
  const ch = db.prepare('SELECT name,server FROM channels WHERE id=?').get(cid);
  const srv = ch && db.prepare('SELECT name FROM servers WHERE id=?').get(ch.server);
  const gente = (voiceRooms.get(cid)?.size) || 1;
  // o convite vai junto: quem ainda não é do servidor entra pelo próprio link
  const inv = srv && db.prepare('SELECT invite FROM servers WHERE id=?').get(ch.server)?.invite;
  const link = `${SITE_URL}/?sala=${cid}${inv ? `&convite=${inv}` : ''}`;
  const body = {
    username: 'MIMO',
    avatar_url: `${SITE_URL}/logo.jpg`,
    content: `🔴 **${user.nick}** está transmitindo em **${ch?.name || 'call'}** — assista: ${link}`,
    embeds: [{
      title: `▶ Assistir a transmissão de ${user.nick}`,
      url: link,
      description: `Sala **${ch?.name || 'call'}**${srv ? ` · ${srv.name}` : ''}\n${gente} ${gente === 1 ? 'pessoa' : 'pessoas'} na call\n\nO link entra direto na sala (pede login na primeira vez).`,
      color: 0xceff36,
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },      // nunca marca @everyone/@here
  };
  for (const hook of DISCORD_WEBHOOKS) {
    const url = hook + (hook.includes('?') ? '&' : '?') + 'wait=true';
    const alvo = hook.split('/').slice(-2, -1)[0];   // id do webhook, só pro log
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    }).then((r) => console.log(r.ok
        ? `discord[${alvo}]: avisou que ${user.nick} está transmitindo`
        : `discord[${alvo}]: webhook respondeu ${r.status}`))
      .catch((e) => console.warn(`discord[${alvo}]: falhou —`, e.message));   // nunca derruba a call
  }
}

function doVoiceJoin(sock, uid, user, cid) {
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(cid);
  if (!ch || ch.kind !== 'voice') return;
  const prev = voiceSock.get(uid);
  if (prev && prev !== sock) send(prev, { type: 'voice-taken' });  // a call mudou de aparelho
  leaveVoice(uid);
  voiceSock.set(uid, sock);
  if (!voiceRooms.has(cid)) voiceRooms.set(cid, new Set());
  const set = voiceRooms.get(cid);
  if (set.size >= MAX_VOICE) { send(sock, { type: 'voice-full', room: cid }); return; }
  const peers = [...set].map((pid) => ({ id: pid, nick: db.prepare('SELECT nick FROM users WHERE id=?').get(pid)?.nick || '?' }));
  set.add(uid);
  send(sock, { type: 'voice-peers', room: cid, peers });
  for (const pid of set) if (pid !== uid) pushVoice(pid, { type: 'voice-joined', room: cid, id: uid, nick: user.nick });
}

wss.on('connection', (sock, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const payload = verifyToken(params.get('token'));
  if (!payload) { send(sock, { type: 'error', reason: 'auth' }); sock.close(); return; }
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid);
  if (!user) { sock.close(); return; }
  const uid = user.id;

  // várias sessões por conta convivem (PC + celular). Só a voz é exclusiva:
  // quem entra na call por último fica com ela. Derrubar a sessão antiga aqui
  // fazia os dois aparelhos se expulsarem em loop de ~1s.
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid).add(sock);
  send(sock, { type: 'ready', user: publicUser(user) });

  sock.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'msg') {
      const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(Number(m.channel));
      if (!ch || ch.kind !== 'text') return;
      if (!db.prepare('SELECT 1 FROM members WHERE server=? AND user=?').get(ch.server, uid)) return;
      const text = String(m.text || '').slice(0, 800).trim();
      if (!text) return;
      const info = db.prepare('INSERT INTO messages (channel,user,nick,color,text,ts) VALUES (?,?,?,?,?,?)')
        .run(ch.id, uid, user.nick, user.color, text, now());
      const msg = { id: info.lastInsertRowid, user: uid, nick: user.nick, color: user.color, text, ts: now() };
      const out = { type: 'msg', channel: ch.id, msg };
      for (const mem of db.prepare('SELECT user FROM members WHERE server=?').all(ch.server)) pushTo(mem.user, out);
      return;
    }

    if (m.type === 'typing') {
      const ch = db.prepare('SELECT server FROM channels WHERE id=?').get(Number(m.channel));
      if (!ch) return;
      for (const mem of db.prepare('SELECT user FROM members WHERE server=?').all(ch.server))
        if (mem.user !== uid) pushTo(mem.user, { type: 'typing', channel: Number(m.channel), nick: user.nick });
      return;
    }

    if (m.type === 'voice-join') { doVoiceJoin(sock, uid, user, Number(m.room)); return; }

    // sincronização não destrutiva: o cliente pede a lista de quem está na sala
    // sem sair e entrar de novo (usado em toda reconexão e a cada 15s)
    if (m.type === 'voice-sync') {
      const want = Number(m.room);
      const cid = roomOf(uid);
      if (cid != null && cid === want && voiceSock.get(uid) === sock) {
        const set = voiceRooms.get(cid);
        const peers = [...set].filter((p) => p !== uid)
          .map((pid) => ({ id: pid, nick: db.prepare('SELECT nick FROM users WHERE id=?').get(pid)?.nick || '?' }));
        send(sock, { type: 'voice-peers', room: cid, peers, sync: true });
        return;
      }
      doVoiceJoin(sock, uid, user, want);   // não estava mesmo na sala: entra
      return;
    }
    if (m.type === 'sharing') {
      const cid = roomOf(uid);
      if (cid == null || voiceSock.get(uid) !== sock) return;   // só quem está mesmo na call
      if (m.on) notifyShareStarted(uid, user, cid);
      return;
    }

    if (m.type === 'voice-leave') { if (!voiceSock.has(uid) || voiceSock.get(uid) === sock) leaveVoice(uid); return; }

    // sinalização mesh direcionada (description/candidate/state)
    if (m.to != null) {
      const cid = roomOf(uid);
      if (cid == null || voiceSock.get(uid) !== sock) return;            // só a sessão que está na call
      if (!voiceRooms.get(cid).has(Number(m.to))) return;                // só dentro da mesma sala
      m.from = uid; pushVoice(Number(m.to), m);
    }
  });

  sock.on('close', () => {
    const set = sockets.get(uid);
    if (set) { set.delete(sock); if (!set.size) sockets.delete(uid); }
    if (voiceSock.get(uid) === sock) leaveVoice(uid);
  });
});

server.listen(PORT, () => {
  console.log(`MIMO ouvindo em http://0.0.0.0:${PORT} — db=${DB_PATH}, voz mesh até ${MAX_VOICE}/sala`);
});

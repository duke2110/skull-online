// Skull online - server có thẩm quyền: thông tin đĩa úp không bao giờ gửi cho người không được xem.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const SPEED = Number(process.env.SKULL_SPEED || 1); // chỉ dùng để chạy test nhanh
const INDEX = path.join(__dirname, 'public', 'index.html');

// ---------- Icon app (PNG sinh bằng code, không cần file ảnh) ----------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = CRC_T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(size, pix) {
  const stride = size * 4 + 1, raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b] = pix((x + .5) / size, (y + .5) / size), o = y * stride + 1 + x * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function iconPixel(size) {
  const clamp = v => Math.min(1, Math.max(0, v));
  return (x, y) => {
    let c = [20, 17, 15];
    const mix = (col, a) => { c = [c[0] + (col[0] - c[0]) * a, c[1] + (col[1] - c[1]) * a, c[2] + (col[2] - c[2]) * a]; };
    const aa = d => clamp(.5 - d * size);
    const BONE = [232, 220, 196], DARK = [30, 22, 20], RED = [125, 31, 46];
    mix(RED, aa(Math.hypot(x - .5, y - .5) - .44));
    mix(BONE, aa(Math.hypot(x - .5, y - .45) - .23));
    const jx = Math.abs(x - .5) - .1, jy = Math.abs(y - .67) - .05;
    mix(BONE, aa(Math.hypot(Math.max(jx, 0), Math.max(jy, 0)) + Math.min(Math.max(jx, jy), 0) - .04));
    mix(DARK, aa(Math.hypot(x - .41, y - .47) - .06));
    mix(DARK, aa(Math.hypot(x - .59, y - .47) - .06));
    mix(DARK, aa(Math.hypot(x - .5, y - .58) - .025));
    for (const tx of [.44, .5, .56]) mix(DARK, aa(Math.max(Math.abs(x - tx) - .004, Math.abs(y - .68) - .035)));
    return c.map(Math.round);
  };
}
const ICONS = { '/icon-192.png': makePng(192, iconPixel(192)), '/icon-512.png': makePng(512, iconPixel(512)), '/apple-touch-icon.png': makePng(180, iconPixel(180)) };
const MANIFEST = JSON.stringify({
  name: 'Skull Online', short_name: 'Skull', start_url: '/', display: 'standalone', orientation: 'portrait',
  background_color: '#14110f', theme_color: '#14110f',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
});
const SW = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});";

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') return res.end('ok');
  if (url === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(ICONS['/icon-192.png']); }
  if (ICONS[url]) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(ICONS[url]); }
  if (url === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); return res.end(MANIFEST); }
  if (url === '/sw.js') { res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }); return res.end(SW); }
  if (url !== '/') { res.writeHead(404); return res.end('not found'); }
  fs.readFile(INDEX, (e, d) => {
    if (e) { res.writeHead(500); return res.end('error'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map();

const rid = () => crypto.randomBytes(8).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rnd = a => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const err = (ws, msg, fatal) => send(ws, { t: 'err', msg, fatal: !!fatal });
const bad = (ws, msg) => { err(ws, msg); return false; };
const sendAll = (room, o) => room.players.forEach(p => send(p.ws, o));
const EMOTES = ['😏', '🤨', '😱', '😂', '😈', '🤞', '🙏', '👀'];
const BOT_NAMES = ['Bot Mèo', 'Bot Cáo', 'Bot Gấu', 'Bot Cú', 'Bot Sói', 'Bot Rùa'];
const TIMERS = [0, 15, 30, 60, 90];
const mkPlayer = (name, extra) => Object.assign({ id: rid(), token: rid(), name, ws: null, connected: true, bot: false, afk: false, timeouts: 0, voice: false, lastMsg: 0, hand: [], stack: [], revealed: 0, wins: 0, out: false, passed: false }, extra);

// ---------- Logic game ----------
const log = (room, s) => { room.log.push(s); if (room.log.length > 60) room.log.shift(); };
const idx = (room, p) => room.players.indexOf(p);
const total = room => room.players.reduce((n, p) => n + p.stack.length, 0);
const unrevealed = p => p.stack.length - p.revealed;
function nextAlive(room, i, skipPassed) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n, q = room.players[j];
    if (!q.out && (!skipPassed || !q.passed)) return j;
  }
  return i;
}
const allPlaced = room => room.players.every(p => p.out || p.stack.length >= 1);

function startGame(room) {
  room.players = shuffle(room.players);
  room.players.forEach(p => { p.hand = ['F', 'F', 'F', 'S']; p.stack = []; p.revealed = 0; p.wins = 0; p.out = false; p.passed = false; p.afk = false; p.timeouts = 0; });
  room.log = []; room.winner = null; room.round = 0; room.history = [];
  startRound(room, 0);
}
function startRound(room, starter) {
  room.snap = null; room.result = null;
  room.players.forEach(p => { p.stack = []; p.revealed = 0; p.passed = false; });
  room.phase = 'place'; room.turn = starter; room.bid = 0; room.bidder = -1; room.challenger = -1; room.flowers = 0;
  room.round++;
  log(room, `— Ván ${room.round}: ${room.players[starter].name} đi trước —`);
}
function endRound(room) {
  room.snap = {};
  room.players.forEach(p => { room.snap[p.id] = p.stack.slice(); p.hand = p.hand.concat(p.stack); p.stack = []; p.revealed = 0; });
}
function startFlip(room, i) {
  room.phase = 'flip'; room.challenger = i; room.turn = i; room.flowers = 0;
  log(room, `${room.players[i].name} thách đấu: lật ${room.bid} hoa hồng!`);
}
function gameOver(room, winner) {
  room.phase = 'gameover'; room.winner = winner.id;
  room.players.forEach(p => {
    const s = room.scores[p.id] || (room.scores[p.id] = { name: p.name, games: 0, wins: 0 });
    s.name = p.name; s.games++; if (p === winner) s.wins++;
  });
  room.past.push({ n: room.past.length + 1, winner: winner.name, rounds: room.round });
  if (room.past.length > 20) room.past.shift();
  log(room, `🏆 ${winner.name} thắng!`);
  botReact(room, winner.bot ? '😈' : '😱');
}
function botReact(room, e) {
  const bots = room.players.filter(p => p.bot);
  if (bots.length && Math.random() < .5) { const b = rnd(bots); setTimeout(() => sendAll(room, { t: 'emote', from: b.id, e }), 500 / SPEED); }
}
function success(room) {
  const ch = room.players[room.challenger];
  ch.wins++;
  endRound(room);
  room.result = { type: 'success', challenger: ch.id, bid: room.bid };
  room.history.push({ r: room.round, ch: ch.name, bid: room.bid, ok: true });
  log(room, `${ch.name} thành công! (${ch.wins}/2 điểm)`);
  if (ch.wins >= 2) return gameOver(room, ch);
  room.nextStarter = room.challenger; room.phase = 'roundend';
  botReact(room, rnd(['🤨', '👀']));
}
function fail(room, owner) {
  const ch = room.players[room.challenger];
  endRound(room);
  room.result = { type: 'fail', challenger: ch.id, owner: owner.id, bid: room.bid, own: owner === ch };
  room.history.push({ r: room.round, ch: ch.name, bid: room.bid, ok: false, owner: owner.name });
  log(room, `💀 ${ch.name} lật trúng đầu lâu của ${owner === ch ? 'chính mình' : owner.name}!`);
  botReact(room, rnd(['😂', '😈']));
  if (owner === ch) {
    if (ch.hand.every(t => t === ch.hand[0])) loseDisc(room, ch, ch.hand[0], owner);
    else room.phase = 'choose';
  } else loseDisc(room, ch, null, owner);
}
function loseDisc(room, ch, type, owner) {
  const i = type ? ch.hand.indexOf(type) : Math.floor(Math.random() * ch.hand.length);
  const lost = ch.hand.splice(i, 1)[0];
  log(room, `${ch.name} mất 1 đĩa${type ? ' (' + (lost === 'S' ? 'đầu lâu' : 'hoa hồng') + ')' : ''}.`);
  if (ch.hand.length === 0) { ch.out = true; log(room, `${ch.name} bị loại.`); }
  const alive = room.players.filter(p => !p.out);
  if (alive.length === 1) return gameOver(room, alive[0]);
  room.nextStarter = owner !== ch ? idx(room, owner) : (ch.out ? nextAlive(room, idx(room, ch)) : idx(room, ch));
  room.phase = 'roundend';
}

// trả về true nếu hành động hợp lệ và đã áp dụng
function act(room, p, m, ws) {
  const me = idx(room, p);
  const myTurn = room.turn === me;
  switch (m.t) {
    case 'place': {
      if (room.phase !== 'place' || !myTurn) return bad(ws, 'Chưa tới lượt bạn.');
      if (!['F', 'S'].includes(m.type) || !p.hand.includes(m.type)) return bad(ws, 'Bạn không có đĩa đó.');
      p.hand.splice(p.hand.indexOf(m.type), 1); p.stack.push(m.type);
      log(room, `${p.name} đặt 1 đĩa úp.`);
      room.turn = nextAlive(room, me);
      return true;
    }
    case 'bid': {
      const n = parseInt(m.n, 10);
      const inPlace = room.phase === 'place' && allPlaced(room), inBid = room.phase === 'bid';
      if (!myTurn || !(inPlace || inBid)) return bad(ws, 'Bây giờ chưa thể cược.');
      if (!(n >= 1 && n <= total(room)) || n <= room.bid) return bad(ws, 'Mức cược không hợp lệ.');
      room.bid = n; room.bidder = me; room.phase = 'bid';
      log(room, `${p.name} cược ${n}.`);
      if (n === total(room)) startFlip(room, me); else room.turn = nextAlive(room, me, true);
      return true;
    }
    case 'pass': {
      if (room.phase !== 'bid' || !myTurn) return bad(ws, 'Bây giờ chưa thể bỏ qua.');
      p.passed = true; log(room, `${p.name} bỏ qua.`);
      const rest = room.players.filter(q => !q.out && !q.passed);
      if (rest.length === 1) startFlip(room, room.bidder); else room.turn = nextAlive(room, me, true);
      return true;
    }
    case 'flip': {
      if (room.phase !== 'flip' || room.challenger !== me) return bad(ws, 'Bạn không phải người thách đấu.');
      const t = room.players.find(q => q.id === m.target);
      if (!t || t.out) return bad(ws, 'Mục tiêu không hợp lệ.');
      if (unrevealed(p) > 0 && t !== p) return bad(ws, 'Phải lật hết đĩa của mình trước.');
      if (unrevealed(t) <= 0) return bad(ws, 'Người này hết đĩa để lật.');
      const card = t.stack[t.stack.length - 1 - t.revealed]; t.revealed++;
      log(room, `${p.name} lật đĩa của ${t === p ? 'mình' : t.name}: ${card === 'S' ? '💀' : '🌹'}`);
      if (card === 'S') fail(room, t);
      else { room.flowers++; if (room.flowers >= room.bid) success(room); }
      return true;
    }
    case 'choose': {
      if (room.phase !== 'choose' || room.challenger !== me) return bad(ws, 'Không phải việc của bạn.');
      if (!p.hand.includes(m.type)) return bad(ws, 'Bạn không có đĩa đó.');
      loseDisc(room, p, m.type, p);
      return true;
    }
    case 'next': {
      if (room.phase !== 'roundend') return false;
      startRound(room, room.nextStarter);
      return true;
    }
    case 'restart': {
      if (room.phase !== 'gameover' || room.hostId !== p.id) return bad(ws, 'Chỉ chủ phòng mới chơi lại được.');
      room.phase = 'lobby'; room.log = []; room.snap = null; room.result = null; room.deadline = null;
      return true;
    }
    default: return false;
  }
}

// ---------- Bot AI ----------
function botMove(room, p) {
  const own = p.stack, ownHasSkull = own.includes('S');
  let safe = 0; for (let i = own.length - 1; i >= 0 && own[i] !== 'S'; i--) safe++;
  const ownSafe = ownHasSkull ? safe : own.length;
  const others = room.players.filter(q => q !== p && !q.out);
  const othersCount = others.reduce((n, q) => n + q.stack.length, 0);
  const T = total(room);
  const bidFor = (extra = 0) => clamp(Math.max(1, ownSafe + (ownHasSkull ? 0 : Math.floor(othersCount * .3 * Math.random() + extra))), 1, T);
  const pickDisc = () => {
    if (p.hand.includes('S') && !ownHasSkull && Math.random() < .3) return 'S';
    return p.hand.includes('F') ? 'F' : 'S';
  };
  switch (room.phase) {
    case 'place': {
      if (!allPlaced(room)) return { t: 'place', type: p.hand.includes('S') && Math.random() < .25 ? 'S' : (p.hand.includes('F') ? 'F' : 'S') };
      if (!p.hand.length) return { t: 'bid', n: bidFor() };
      const want = clamp(.12 + .2 * ownSafe + (own.length >= 3 ? .1 : 0), 0, .8);
      if (Math.random() < want) return { t: 'bid', n: bidFor(Math.random() < .5 ? 1 : 0) };
      return { t: 'place', type: pickDisc() };
    }
    case 'bid': {
      const est = ownSafe + (ownHasSkull ? 0 : Math.floor(othersCount * .4)) + (Math.random() < .3 ? 1 : 0);
      const nb = room.bid + 1;
      if (nb <= T && nb <= est && Math.random() < .85) return { t: 'bid', n: nb };
      return { t: 'pass' };
    }
    case 'flip': {
      if (unrevealed(p) > 0) return { t: 'flip', target: p.id };
      const c = others.filter(q => unrevealed(q) > 0);
      return { t: 'flip', target: (c.length ? rnd(c) : p).id };
    }
    case 'choose': return { t: 'choose', type: p.hand.includes('F') ? 'F' : 'S' };
  }
  return { t: 'next' };
}
function fallbackMove(room, p) {
  switch (room.phase) {
    case 'place': return p.hand.length && !allPlaced(room) ? { t: 'place', type: p.hand[0] } : (allPlaced(room) ? { t: 'bid', n: 1 } : { t: 'place', type: p.hand[0] });
    case 'bid': return { t: 'pass' };
    case 'flip': { const t = unrevealed(p) > 0 ? p : room.players.find(q => q !== p && unrevealed(q) > 0); return { t: 'flip', target: t.id }; }
    case 'choose': return { t: 'choose', type: p.hand[0] };
  }
  return { t: 'next' };
}

// ---------- Đồng hồ lượt ----------
function actor(room) {
  if (room.phase === 'place' || room.phase === 'bid') return room.players[room.turn];
  if (room.phase === 'flip' || room.phase === 'choose') return room.players[room.challenger];
  return null;
}
function setDeadline(room) {
  let ms = null, show = false;
  const a = actor(room);
  if (room.phase === 'roundend') { ms = 12000; show = true; }
  else if (a) {
    if (a.bot) ms = 1100 + Math.random() * 1400;
    else if (!a.connected) ms = 4000;
    else if (a.afk) ms = 3500;
    else if (room.settings.timer > 0) { ms = room.settings.timer * 1000; show = true; }
  }
  room.deadline = ms == null ? null : Date.now() + ms / SPEED;
  room.deadlineShow = show;
}
function play(room, p, m, ws, human) {
  if (!act(room, p, m, ws)) return false;
  if (human) { p.afk = false; p.timeouts = 0; }
  setDeadline(room); broadcast(room);
  return true;
}
function tick(room) {
  room.deadline = null;
  if (room.phase === 'roundend') { startRound(room, room.nextStarter); setDeadline(room); return broadcast(room); }
  const a = actor(room); if (!a) return;
  if (!a.bot && a.connected && !a.afk) {
    a.timeouts++; log(room, `${a.name} hết giờ — bot chơi thay.`);
    if (a.timeouts >= 2) a.afk = true;
  }
  if (!play(room, a, botMove(room, a), null, false)) play(room, a, fallbackMove(room, a), null, false);
}
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.deadline || now < room.deadline) continue;
    if (!room.players.some(p => !p.bot && p.connected)) { room.deadline = null; continue; } // không ai xem thì tạm dừng
    try { tick(room); } catch (e) { console.error(e); room.deadline = null; }
  }
}, 250);

// ---------- Views ----------
function view(room, me) {
  const matOf = q => {
    if (room.snap) return (room.snap[q.id] || []).map(t => ({ up: true, t }));
    const L = q.stack.length;
    return q.stack.map((t, i) => { const up = i >= L - q.revealed; return { up, t: (up || q.id === me.id) ? t : null }; });
  };
  const cur = room.players[room.turn];
  return {
    code: room.code, phase: room.phase, hostId: room.hostId, you: me.id, round: room.round,
    turn: room.phase === 'lobby' || !cur ? null : cur.id,
    bid: room.bid, bidder: room.bidder >= 0 && room.players[room.bidder] ? room.players[room.bidder].id : null,
    challenger: room.challenger >= 0 ? room.players[room.challenger].id : null,
    flowers: room.flowers, result: room.result, winner: room.winner,
    nextStarter: room.phase === 'roundend' ? room.players[room.nextStarter].id : null,
    total: room.snap ? 0 : total(room),
    hand: me.hand || [],
    log: room.log.slice(-40),
    settings: room.settings,
    timeLeft: room.deadline && room.deadlineShow ? Math.max(0, Math.round((room.deadline - Date.now()) * SPEED)) : null,
    scores: Object.entries(room.scores).map(([id, s]) => ({ id, name: s.name, games: s.games, wins: s.wins })).sort((a, b) => b.wins - a.wins || a.games - b.games),
    history: room.history.slice(-30), past: room.past.slice(-10),
    chat: room.chat.slice(-50),
    players: room.players.map(q => ({
      id: q.id, name: q.name, connected: q.connected, voice: !!q.voice, bot: !!q.bot, afk: !!q.afk, out: !!q.out, wins: q.wins || 0, passed: !!q.passed,
      handCount: (q.hand || []).length, mat: room.phase === 'lobby' ? [] : matOf(q),
    })),
  };
}
function broadcast(room) {
  room.lastActive = Date.now();
  room.players.forEach(p => send(p.ws, { t: 'state', s: view(room, p) }));
}

// ---------- Kết nối ----------
function ensureHost(room) {
  const h = room.players.find(p => p.id === room.hostId);
  if (h && !h.bot && h.connected) return;
  const n = room.players.find(p => !p.bot && p.connected);
  if (n) room.hostId = n.id;
}
function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch {} }
  p.ws = ws; p.connected = true; ws.ctx = { room, p };
  send(ws, { t: 'welcome', token: p.token, code: room.code });
  if (room.phase !== 'lobby' && room.phase !== 'gameover' && (!room.deadline || actor(room) === p)) setDeadline(room);
  broadcast(room);
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    const c = ws.ctx; if (!c) return;
    const { room, p } = c; if (p.ws !== ws) return;
    p.ws = null; p.connected = false; p.voice = false;
    if (room.phase === 'lobby') {
      setTimeout(() => {
        if (p.connected || room.phase !== 'lobby' || !rooms.has(room.code) || !room.players.includes(p)) return;
        room.players = room.players.filter(q => q !== p);
        if (!room.players.some(q => !q.bot)) { rooms.delete(room.code); return; }
        ensureHost(room); broadcast(room);
      }, 20000);
    } else {
      ensureHost(room);
      if (actor(room) === p) setDeadline(room);
    }
    broadcast(room);
  });
});

function handle(ws, m) {
  if (m.t === 'create') {
    const name = clean(m.name); if (!name) return err(ws, 'Nhập tên của bạn.');
    const room = { code: newCode(), players: [], phase: 'lobby', log: [], round: 0, hostId: null, lastActive: Date.now(), settings: { timer: 60 }, scores: {}, history: [], past: [], chat: [], chatSeq: 0, deadline: null };
    const p = mkPlayer(name); room.players.push(p); room.hostId = p.id; rooms.set(room.code, room);
    return attach(ws, room, p);
  }
  if (m.t === 'join') {
    const name = clean(m.name); if (!name) return err(ws, 'Nhập tên của bạn.');
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return err(ws, 'Không tìm thấy phòng.');
    if (room.phase !== 'lobby') return err(ws, 'Phòng đã bắt đầu chơi.');
    if (room.players.length >= 6) return err(ws, 'Phòng đã đủ 6 người.');
    if (room.players.some(q => q.name.toLowerCase() === name.toLowerCase())) return err(ws, 'Tên này đã có người dùng trong phòng.');
    const p = mkPlayer(name); room.players.push(p);
    return attach(ws, room, p);
  }
  if (m.t === 'rejoin') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && m.token && room.players.find(q => q.token === m.token);
    if (!p) return err(ws, 'Phòng không còn tồn tại hoặc bạn đã bị đưa ra khỏi phòng.', true);
    return attach(ws, room, p);
  }
  const c = ws.ctx; if (!c) return;
  const { room, p } = c;
  const now = Date.now();
  if (m.t === 'voice') { p.voice = !!m.on; return broadcast(room); }
  if (m.t === 'rtc') {
    const to = room.players.find(q => q.id === m.to);
    if (to && to !== p && m.data && typeof m.data === 'object') send(to.ws, { t: 'rtc', from: p.id, data: m.data });
    return;
  }
  if (m.t === 'chat') {
    const text = String(m.text || '').replace(/[<>]/g, '').trim().slice(0, 140);
    if (!text || now - p.lastMsg < 600) return;
    p.lastMsg = now; room.chat.push({ n: ++room.chatSeq, id: p.id, name: p.name, text }); if (room.chat.length > 80) room.chat.shift();
    return broadcast(room);
  }
  if (m.t === 'emote') {
    if (!EMOTES.includes(m.e) || now - p.lastMsg < 400) return;
    p.lastMsg = now; return sendAll(room, { t: 'emote', from: p.id, e: m.e });
  }
  const host = room.hostId === p.id;
  if (m.t === 'settings') {
    if (!host || room.phase !== 'lobby' || !TIMERS.includes(m.timer)) return;
    room.settings.timer = m.timer; return broadcast(room);
  }
  if (m.t === 'addbot') {
    if (!host || room.phase !== 'lobby') return;
    if (room.players.length >= 6) return err(ws, 'Phòng đã đủ 6 người.');
    const used = new Set(room.players.map(q => q.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + rid().slice(0, 3));
    room.players.push(mkPlayer(name, { bot: true, token: null }));
    return broadcast(room);
  }
  if (m.t === 'kick') {
    const t = room.players.find(q => q.id === m.id);
    if (!host || !t || t === p) return;
    if (room.phase === 'lobby') {
      room.players = room.players.filter(q => q !== t);
      if (t.ws) { err(t.ws, 'Bạn đã bị chủ phòng mời ra khỏi phòng.', true); t.ws.ctx = null; }
    } else {
      if (t.bot) return;
      log(room, `${t.name} bị chủ phòng thay bằng bot.`);
      t.bot = true; t.token = null; t.connected = true; t.voice = false;
      if (t.ws) { err(t.ws, 'Bạn đã bị chủ phòng thay bằng bot.', true); t.ws.ctx = null; t.ws = null; }
      if (actor(room) === t) setDeadline(room);
    }
    return broadcast(room);
  }
  if (m.t === 'start') {
    if (!host || room.phase !== 'lobby') return;
    if (room.players.length < 2) return err(ws, 'Cần ít nhất 2 người (nên chơi 3–6 người). Có thể thêm bot.');
    startGame(room); setDeadline(room); return broadcast(room);
  }
  if (m.t === 'leave') {
    if (room.phase === 'lobby') {
      room.players = room.players.filter(q => q !== p); ws.ctx = null;
      if (!room.players.some(q => !q.bot)) rooms.delete(room.code);
      else { ensureHost(room); if (room.hostId === p.id) room.hostId = room.players.find(q => !q.bot).id; broadcast(room); }
    }
    return;
  }
  if (room.phase === 'lobby') return;
  play(room, p, m, ws, true);
}

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  for (const [k, r] of rooms) if (Date.now() - r.lastActive > 3 * 3600e3 && r.players.every(p => !p.connected || p.bot)) rooms.delete(k);
}, 30000);

server.listen(PORT, () => console.log('Skull server on :' + PORT));

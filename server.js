// Skull online - server có thẩm quyền (authoritative): thông tin đĩa úp không bao giờ gửi cho người không được xem.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok');
  fs.readFile(INDEX, (e, d) => {
    if (e) { res.writeHead(500); return res.end('error'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map();

const rid = () => crypto.randomBytes(8).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const err = (ws, msg, fatal) => send(ws, { t: 'err', msg, fatal: !!fatal });

// ---------- Game logic ----------
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
  room.players.forEach(p => { p.hand = ['F', 'F', 'F', 'S']; p.stack = []; p.revealed = 0; p.wins = 0; p.out = false; p.passed = false; });
  room.log = []; room.winner = null; room.round = 0;
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
function success(room) {
  const ch = room.players[room.challenger];
  ch.wins++;
  endRound(room);
  room.result = { type: 'success', challenger: ch.id, bid: room.bid };
  log(room, `${ch.name} thành công! (${ch.wins}/2 điểm)`);
  if (ch.wins >= 2) { room.phase = 'gameover'; room.winner = ch.id; log(room, `🏆 ${ch.name} thắng!`); return; }
  room.nextStarter = room.challenger; room.phase = 'roundend';
}
function fail(room, owner) {
  const ch = room.players[room.challenger];
  endRound(room);
  room.result = { type: 'fail', challenger: ch.id, owner: owner.id, bid: room.bid, own: owner === ch };
  log(room, `💀 ${ch.name} lật trúng đầu lâu của ${owner === ch ? 'chính mình' : owner.name}!`);
  if (owner === ch) {
    if (ch.hand.every(t => t === ch.hand[0])) loseDisc(room, ch, ch.hand[0], owner);
    else room.phase = 'choose';
  } else {
    loseDisc(room, ch, null, owner);
  }
}
function loseDisc(room, ch, type, owner) {
  let i = type ? ch.hand.indexOf(type) : Math.floor(Math.random() * ch.hand.length);
  const lost = ch.hand.splice(i, 1)[0];
  log(room, `${ch.name} mất 1 đĩa${type ? ' (' + (lost === 'S' ? 'đầu lâu' : 'hoa hồng') + ')' : ''}.`);
  if (ch.hand.length === 0) { ch.out = true; log(room, `${ch.name} bị loại.`); }
  const alive = room.players.filter(p => !p.out);
  if (alive.length === 1) { room.phase = 'gameover'; room.winner = alive[0].id; log(room, `🏆 ${alive[0].name} là người sống sót cuối cùng!`); return; }
  room.nextStarter = owner !== ch ? idx(room, owner) : (ch.out ? nextAlive(room, idx(room, ch)) : idx(room, ch));
  room.phase = 'roundend';
}

function act(room, p, m, ws) {
  const me = idx(room, p);
  const myTurn = room.turn === me;
  switch (m.t) {
    case 'place': {
      if (room.phase !== 'place' || !myTurn) return err(ws, 'Chưa tới lượt bạn.');
      if (!['F', 'S'].includes(m.type) || !p.hand.includes(m.type)) return err(ws, 'Bạn không có đĩa đó.');
      p.hand.splice(p.hand.indexOf(m.type), 1); p.stack.push(m.type);
      log(room, `${p.name} đặt 1 đĩa úp.`);
      room.turn = nextAlive(room, me);
      break;
    }
    case 'bid': {
      const n = parseInt(m.n, 10);
      const inPlace = room.phase === 'place' && allPlaced(room), inBid = room.phase === 'bid';
      if (!myTurn || !(inPlace || inBid)) return err(ws, 'Bây giờ chưa thể cược.');
      if (!(n >= 1 && n <= total(room)) || n <= room.bid) return err(ws, 'Mức cược không hợp lệ.');
      room.bid = n; room.bidder = me; room.phase = 'bid';
      log(room, `${p.name} cược ${n}.`);
      if (n === total(room)) startFlip(room, me); else room.turn = nextAlive(room, me, true);
      break;
    }
    case 'pass': {
      if (room.phase !== 'bid' || !myTurn) return err(ws, 'Bây giờ chưa thể bỏ qua.');
      p.passed = true; log(room, `${p.name} bỏ qua.`);
      const rest = room.players.filter(q => !q.out && !q.passed);
      if (rest.length === 1) startFlip(room, room.bidder); else room.turn = nextAlive(room, me, true);
      break;
    }
    case 'flip': {
      if (room.phase !== 'flip' || room.challenger !== me) return err(ws, 'Bạn không phải người thách đấu.');
      const t = room.players.find(q => q.id === m.target);
      if (!t || t.out) return err(ws, 'Mục tiêu không hợp lệ.');
      if (unrevealed(p) > 0 && t !== p) return err(ws, 'Phải lật hết đĩa của mình trước.');
      if (unrevealed(t) <= 0) return err(ws, 'Người này hết đĩa để lật.');
      const card = t.stack[t.stack.length - 1 - t.revealed]; t.revealed++;
      log(room, `${p.name} lật đĩa của ${t === p ? 'mình' : t.name}: ${card === 'S' ? '💀' : '🌹'}`);
      if (card === 'S') fail(room, t);
      else { room.flowers++; if (room.flowers >= room.bid) success(room); }
      break;
    }
    case 'choose': {
      if (room.phase !== 'choose' || room.challenger !== me) return err(ws, 'Không phải việc của bạn.');
      if (!p.hand.includes(m.type)) return err(ws, 'Bạn không có đĩa đó.');
      loseDisc(room, p, m.type, p);
      break;
    }
    case 'next': {
      if (room.phase !== 'roundend') return;
      startRound(room, room.nextStarter);
      break;
    }
    case 'restart': {
      if (room.phase !== 'gameover' || room.hostId !== p.id) return err(ws, 'Chỉ chủ phòng mới chơi lại được.');
      room.phase = 'lobby'; room.log = []; room.snap = null; room.result = null;
      break;
    }
    default: return;
  }
  broadcast(room);
}

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
    players: room.players.map(q => ({
      id: q.id, name: q.name, connected: q.connected, voice: !!q.voice, out: !!q.out, wins: q.wins || 0, passed: !!q.passed,
      handCount: (q.hand || []).length, mat: room.phase === 'lobby' ? [] : matOf(q),
    })),
  };
}
function broadcast(room) {
  room.lastActive = Date.now();
  room.players.forEach(p => send(p.ws, { t: 'state', s: view(room, p) }));
}

// ---------- Connections ----------
function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch {} }
  p.ws = ws; p.connected = true; ws.ctx = { room, p };
  send(ws, { t: 'welcome', token: p.token, code: room.code });
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
        if (p.connected || room.phase !== 'lobby' || !rooms.has(room.code)) return;
        room.players = room.players.filter(q => q !== p);
        if (!room.players.length) { rooms.delete(room.code); return; }
        if (room.hostId === p.id) room.hostId = room.players[0].id;
        broadcast(room);
      }, 20000);
    }
    broadcast(room);
  });
});

function handle(ws, m) {
  if (m.t === 'create') {
    const name = clean(m.name); if (!name) return err(ws, 'Nhập tên của bạn.');
    const room = { code: newCode(), players: [], phase: 'lobby', log: [], round: 0, hostId: null, lastActive: Date.now() };
    const p = { id: rid(), token: rid(), name, ws: null, connected: true, hand: [], stack: [], revealed: 0, wins: 0, out: false, passed: false };
    room.players.push(p); room.hostId = p.id; rooms.set(room.code, room);
    return attach(ws, room, p);
  }
  if (m.t === 'join') {
    const name = clean(m.name); if (!name) return err(ws, 'Nhập tên của bạn.');
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return err(ws, 'Không tìm thấy phòng.');
    if (room.phase !== 'lobby') return err(ws, 'Phòng đã bắt đầu chơi.');
    if (room.players.length >= 6) return err(ws, 'Phòng đã đủ 6 người.');
    if (room.players.some(q => q.name.toLowerCase() === name.toLowerCase())) return err(ws, 'Tên này đã có người dùng trong phòng.');
    const p = { id: rid(), token: rid(), name, ws: null, connected: true, hand: [], stack: [], revealed: 0, wins: 0, out: false, passed: false };
    room.players.push(p);
    return attach(ws, room, p);
  }
  if (m.t === 'rejoin') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && room.players.find(q => q.token === m.token);
    if (!p) return err(ws, 'Phòng không còn tồn tại.', true);
    return attach(ws, room, p);
  }
  const c = ws.ctx; if (!c) return;
  const { room, p } = c;
  if (m.t === 'voice') { p.voice = !!m.on; return broadcast(room); }
  if (m.t === 'rtc') {
    const to = room.players.find(q => q.id === m.to);
    if (to && to !== p && m.data && typeof m.data === 'object') send(to.ws, { t: 'rtc', from: p.id, data: m.data });
    return;
  }
  if (m.t === 'start') {
    if (room.hostId !== p.id || room.phase !== 'lobby') return;
    if (room.players.length < 2) return err(ws, 'Cần ít nhất 2 người (nên chơi 3–6 người).');
    startGame(room); return broadcast(room);
  }
  if (m.t === 'leave') {
    if (room.phase === 'lobby') {
      room.players = room.players.filter(q => q !== p); ws.ctx = null;
      if (!room.players.length) rooms.delete(room.code);
      else { if (room.hostId === p.id) room.hostId = room.players[0].id; broadcast(room); }
    }
    return;
  }
  if (room.phase === 'lobby') return;
  act(room, p, m, ws);
}

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  for (const [k, r] of rooms) if (Date.now() - r.lastActive > 3 * 3600e3 && r.players.every(p => !p.connected)) rooms.delete(k);
}, 30000);

server.listen(PORT, () => console.log('Skull server on :' + PORT));

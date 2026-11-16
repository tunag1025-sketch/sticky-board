// 실시간 메모 보드 서버 (Express + Socket.io)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // QR에 넣을 주소 (비우면 접속한 주소 기준)
const MAX_LEN = Number(process.env.MAX_LEN || 100);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3000);
const MAX_STORED = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'notes.json');

// ---------- 금칙어 필터 (해당 부분을 ***로 가림) ----------
// 추가 금칙어: BANNED_WORDS="단어1,단어2"   필터 끄기: FILTER=off
const BANNED = [
  '시발', '씨발', '씨빨', '씨바', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '븅신', '좆', 'ㅈㄹ', '지랄', '개새끼', '개새',
  '미친놈', '미친년', '닥쳐', '꺼져', '엿먹어', '존나', '졸라', 'ㅈㄴ', '니애미', '느금마', '썅', '쌍놈', '썅년',
  '등신', '또라이', 'fuck', 'shit', 'bitch',
  ...(process.env.BANNED_WORDS || '').split(',').map((w) => w.trim()).filter(Boolean),
];
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 글자 사이에 공백·기호·숫자를 끼워 넣어 우회하는 것도 잡음 (예: 시 1 발)
const BANNED_RE = BANNED.length
  ? new RegExp(BANNED.map((w) => [...w].map(esc).join('[\\s\\d_.,!?~*^\\-]*')).join('|'), 'gi')
  : null;
function clean(text) {
  if (!BANNED_RE || process.env.FILTER === 'off') return text;
  return text.replace(BANNED_RE, (m) => '*'.repeat([...m.replace(/\s/g, '')].length));
}

const COLORS = [
  '#F3E9D2', '#F4A3C0', '#B98DE3', '#F2524F', '#F7C1E8', '#E07E7E',
  '#63E3A0', '#F6B0B2', '#A6E3A9', '#F7B267', '#E2CF78', '#BEE3FA',
];

// ---------- 저장소 (메모리 + JSON 파일) ----------
let state = { notes: [], open: true };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  console.log(`기존 메모 ${state.notes.length}개 불러옴`);
} catch { /* 첫 실행 */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFile(DATA_FILE, JSON.stringify(state), (e) => e && console.error('저장 실패', e));
  }, 500);
}

// ---------- HTTP ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e4, // 메모는 작으니 큰 페이로드 차단
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Pretendard 폰트를 직접 서빙 (외부 CDN 없이도 동작)
app.use('/fonts/pretendard', express.static(path.join(__dirname, 'node_modules/pretendard/dist/web/variable'), { maxAge: '30d', immutable: true }));

function joinUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '') + '/';
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}/`;
}
app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(joinUrl(req), { type: 'svg', margin: 1, color: { dark: '#2b2118', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});
app.get('/join-url', (req, res) => res.json({ url: joinUrl(req) }));
app.get('/health', (req, res) => res.json({ ok: true, notes: state.notes.length, clients: io.engine.clientsCount }));

// ---------- 실시간 ----------
const lastDeleted = new Map();

io.on('connection', (socket) => {
  let lastPost = 0;
  let isAdmin = false;
  let authFails = 0;

  socket.emit('settings', { open: state.open, maxLen: MAX_LEN, colors: COLORS });

  socket.on('board:join', () => {
    socket.join('board');
    socket.emit('notes:init', state.notes); // 전체 메모 (스크롤로 열람)
  });

  socket.on('note:create', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!state.open) return reply({ ok: false, error: '지금은 메모 접수가 마감되었어요.' });
    const now = Date.now();
    if (now - lastPost < COOLDOWN_MS) return reply({ ok: false, error: '잠시 후 다시 보내주세요.' });

    let text = String(payload?.text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return reply({ ok: false, error: '내용을 입력해주세요.' });
    if ([...text].length > MAX_LEN) return reply({ ok: false, error: `${MAX_LEN}자 이내로 써주세요.` });
    const color = COLORS.includes(payload?.color) ? payload.color : COLORS[Math.floor(Math.random() * COLORS.length)];

    lastPost = now;
    const note = { id: crypto.randomUUID(), text: clean(text), color, ts: now };
    state.notes.push(note);
    if (state.notes.length > MAX_STORED) state.notes.splice(0, state.notes.length - MAX_STORED);
    save();
    io.to('board').to('admin').emit('note:new', note);
    reply({ ok: true });
  });

  // --- 관리자 ---
  socket.on('admin:auth', (pw, ack) => {
    if (authFails >= 5) return typeof ack === 'function' && ack({ ok: false });
    const ok = typeof pw === 'string' && pw === ADMIN_PASSWORD;
    if (!ok) authFails++;
    if (ok) {
      isAdmin = true;
      socket.join('admin');
    }
    typeof ack === 'function' && ack(ok ? { ok, notes: state.notes.slice().reverse() } : { ok });
  });

  socket.on('admin:delete', (id) => {
    if (!isAdmin) return;
    const i = state.notes.findIndex((n) => n.id === id);
    if (i === -1) return;
    const [removed] = state.notes.splice(i, 1);
    lastDeleted.set(removed.id, removed); // 되돌리기용
    if (lastDeleted.size > 50) lastDeleted.delete(lastDeleted.keys().next().value);
    save();
    io.to('board').to('admin').emit('note:delete', id);
  });

  socket.on('admin:restore', (id) => {
    if (!isAdmin) return;
    const note = lastDeleted.get(id);
    if (!note) return;
    lastDeleted.delete(id);
    let i = state.notes.length; // 원래 시간 순서 위치에 다시 넣기
    while (i > 0 && state.notes[i - 1].ts > note.ts) i--;
    state.notes.splice(i, 0, note);
    save();
    io.to('board').to('admin').emit('note:restore', note);
  });

  socket.on('admin:clear', () => {
    if (!isAdmin) return;
    state.notes = [];
    save();
    io.to('board').to('admin').emit('notes:init', []);
  });

  socket.on('admin:open', (open) => {
    if (!isAdmin) return;
    state.open = !!open;
    save();
    io.emit('settings', { open: state.open, maxLen: MAX_LEN, colors: COLORS });
  });

  socket.on('admin:stats', (ack) => {
    if (!isAdmin || typeof ack !== 'function') return;
    ack({ clients: io.engine.clientsCount, notes: state.notes.length });
  });
});

server.listen(PORT, () => {
  console.log(`메모 보드 실행 중: http://localhost:${PORT}`);
  console.log(`  작성: /   화면: /board   관리: /admin`);
  if (ADMIN_PASSWORD === 'admin1234') console.log('  ⚠ ADMIN_PASSWORD 환경변수를 꼭 바꿔주세요.');
});

// 부하 테스트: N명의 관객이 동시에 접속해 메모를 보냄
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const N = Number(process.env.N || 150);
const ROUNDS = Number(process.env.ROUNDS || 3);
let ok = 0, fail = 0, received = 0; const lat = [];
const board = io(URL, { transports: ['websocket'] });
board.on('connect', () => board.emit('board:join'));
board.on('note:new', () => received++);
const clients = Array.from({ length: N }, () => io(URL, { transports: ['websocket'] }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  await Promise.all(clients.map(c => new Promise(r => c.connected ? r() : c.on('connect', r))));
  console.log(`${N}명 접속 완료`);
  for (let r = 0; r < ROUNDS; r++) {
    await Promise.all(clients.map((c, i) => new Promise(res => {
      const t = Date.now();
      c.emit('note:create', { text: `테스트 메모 ${r}-${i}`, color: '#F4A3C0' }, (a) => { lat.push(Date.now() - t); a.ok ? ok++ : fail++; res(); });
    })));
    await sleep(3100);
  }
  await sleep(500);
  lat.sort((a, b) => a - b);
  console.log({ sent: ok, rejected: fail, boardReceived: received, p50ms: lat[lat.length >> 1], p99ms: lat[Math.floor(lat.length * .99)] });
  clients.forEach(c => c.close()); board.close();
})();

// 32명 동시 접속을 흉내내서 서버 부하와 통신량을 잰다.
// (브라우저 없이 WebSocket 만 붙이므로 서버 쪽 한계를 보는 테스트)
const URL = (process.env.URL || 'http://localhost:3000').replace('http', 'ws');
const N = parseInt(process.env.N || '32', 10);
const SECONDS = parseInt(process.env.SEC || '20', 10);

const bots = [];
let totalRx = 0, totalMsgs = 0;

for (let i = 0; i < N; i++) {
  const ws = new WebSocket(URL);
  const bot = { ws, i, rx: 0, msgs: 0, ready: false, a: (i / N) * Math.PI * 2 };
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', nick: `봇${i + 1}`, team: i % 8 }));
    bot.ready = true;
  };
  ws.onmessage = (e) => {
    const len = typeof e.data === 'string' ? Buffer.byteLength(e.data) : e.data.byteLength;
    bot.rx += len; bot.msgs++;
    totalRx += len; totalMsgs++;
  };
  ws.onerror = () => {};
  bots.push(bot);
}

await new Promise(r => setTimeout(r, 2500));
console.log(`접속 완료: ${bots.filter(b => b.ready).length}/${N}`);

// 선생님이 게임을 시작해야 실제 플레이 부하가 된다 (그 전엔 전원 대기 공간)
const tws = new WebSocket(URL);
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await new Promise(r => setTimeout(r, 500));
tws.send(JSON.stringify({ t: 'startGame' }));
await new Promise(r => setTimeout(r, 8000));      // 5초 카운트다운 + 여유
console.log('게임 시작 — 실제 플레이 상태로 측정합니다');

const t0 = Date.now();
totalRx = 0; totalMsgs = 0;

// 15Hz 로 원을 그리며 움직인다
const timer = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  for (const b of bots) {
    if (b.ws.readyState !== 1) continue;
    const r = 40 + (b.i % 5) * 14;
    const a = b.a + t * 0.35;
    b.ws.send(JSON.stringify({
      t: 'in',
      x: +(Math.cos(a) * r).toFixed(2),
      y: 0,
      z: +(Math.sin(a) * r).toFixed(2),
      yaw: +a.toFixed(3), pitch: 0, f: 3,
    }));
  }
}, 1000 / 15);

// 가끔 쏘기도 한다
const shooter = setInterval(() => {
  const b = bots[Math.floor(Math.random() * bots.length)];
  if (b.ws.readyState !== 1) return;
  b.ws.send(JSON.stringify({
    t: 'shoot', ammo: 'tranq',
    ox: 0, oy: 2, oz: 0, hx: 10, hy: 2, hz: 10,
  }));
}, 120);

await new Promise(r => setTimeout(r, SECONDS * 1000));
clearInterval(timer); clearInterval(shooter);
tws.close();

const secs = SECONDS;
const perBot = totalRx / N / secs;
console.log('─'.repeat(56));
console.log(`동시 접속        : ${bots.filter(b => b.ws.readyState === 1).length}명`);
console.log(`측정 시간        : ${secs}초`);
console.log(`학생 1명당 수신  : ${(perBot / 1024).toFixed(1)} KB/s  ≈ ${(perBot * 8 / 1000).toFixed(0)} kbps`);
console.log(`서버 총 송신     : ${(totalRx / secs / 1024 / 1024).toFixed(2)} MB/s ≈ ${(totalRx / secs * 8 / 1e6).toFixed(1)} Mbps`);
console.log(`초당 메시지      : ${(totalMsgs / secs).toFixed(0)}개 (전체 합)`);
console.log('─'.repeat(56));

// ============================================================
//  ★ 슈팅 모드 부하 — 여기가 훨씬 빡세다.
//  30명이 기관단총을 계속 난사하면 총격 이펙트만 초당 수백 건이 된다.
//  (그래서 서버는 총격 이펙트를 '150m 안에 있는 사람에게만' 보낸다)
// ============================================================
const tws2 = new WebSocket(URL);
await new Promise(r => { tws2.onopen = r; });
tws2.send(JSON.stringify({ t: 'teacher' }));
await new Promise(r => setTimeout(r, 400));
tws2.send(JSON.stringify({ t: 'battleLobby' }));
await new Promise(r => setTimeout(r, 1200));
tws2.send(JSON.stringify({ t: 'battleStart' }));
await new Promise(r => setTimeout(r, 8000));
console.log('\n⚔ 슈팅 모드로 전환 — 전원 난사 상태로 측정합니다');

const b0 = Date.now();
totalRx = 0; totalMsgs = 0;
const timer2 = setInterval(() => {
  const t = (Date.now() - b0) / 1000;
  for (const b of bots) {
    if (b.ws.readyState !== 1) continue;
    const r = 30 + (b.i % 5) * 12;
    const a = b.a + t * 0.35;
    b.ws.send(JSON.stringify({
      t: 'in', x: +(Math.cos(a) * r).toFixed(2), y: 0, z: +(Math.sin(a) * r).toFixed(2),
      yaw: +a.toFixed(3), pitch: 0, f: 3,
    }));
  }
}, 1000 / 15);
// 전원이 최대 속도로 난사 (최악의 경우)
const shooter2 = setInterval(() => {
  for (const b of bots) {
    if (b.ws.readyState !== 1) continue;
    b.ws.send(JSON.stringify({
      t: 'shoot', ox: 0, oy: 2, oz: 0, hx: 10, hy: 2, hz: 10,
    }));
  }
}, 100);

await new Promise(r => setTimeout(r, SECONDS * 1000));
clearInterval(timer2); clearInterval(shooter2);

const bPerBot = totalRx / N / secs;
console.log('─'.repeat(56));
console.log(`⚔ 슈팅 모드 — 32명 전원 난사`);
console.log(`학생 1명당 수신  : ${(bPerBot / 1024).toFixed(1)} KB/s  ≈ ${(bPerBot * 8 / 1000).toFixed(0)} kbps`);
console.log(`서버 총 송신     : ${(totalRx / secs / 1024 / 1024).toFixed(2)} MB/s ≈ ${(totalRx / secs * 8 / 1e6).toFixed(1)} Mbps`);
console.log(`초당 메시지      : ${(totalMsgs / secs).toFixed(0)}개 (전체 합)`);
console.log('─'.repeat(56));

tws2.send(JSON.stringify({ t: 'scienceMode' }));
await new Promise(r => setTimeout(r, 300));
tws2.close();
for (const b of bots) b.ws.close();
await new Promise(r => setTimeout(r, 500));
process.exit(0);

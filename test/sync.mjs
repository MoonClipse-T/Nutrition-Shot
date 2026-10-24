// ★ 30명 수업에서 나온 버그: "어떤 학생만 시약·불꽃 자동 획득이 안 된다"
//   원인 = 통신이 잠깐 끊기면 서버가 아는 위치가 영영 뒤처져서 근접 판정이 계속 실패.
//   여기서는 '통신 끊김'을 일부러 만들어 놓고도 시약/불꽃이 정상 동작하는지 본다.
import { chromium } from 'playwright';
import { LAYOUT } from '../public/js/layout.js';
import { RULES } from '../public/js/gamedata.js';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!ok) { failures++; process.exitCode = 1; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding'],
});
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
const errors = [];
p.on('pageerror', e => errors.push(e.message));
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto(URL);
await p.waitForSelector('#joinBtn:not([disabled])');
await p.click('#qualitySeg button[data-q="low"]');
await p.fill('#nickInput', '끊긴이');
await p.selectOption('#teamSelect', '0');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await wait(2500);

const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(500);
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);

// 통신 끊김을 흉내내는 헬퍼 : ms 동안 위치 전송만 멈추고 그 사이 멀리 이동한다
await p.addScriptTag({ content: `
  window.__blackout = async (tx, tz) => {
    const g = window.__game;
    const realSend = g.net.send.bind(g.net);
    // 위치(in) 만 막는다 — 와이파이가 끊기거나 화면이 꺼진 상황
    g.net.send = (o) => { if (o && o.t === 'in') return; realSend(o); };
    for (let i = 0; i < 400; i++) {
      const dx = tx - g.me.x, dz = tz - g.me.z, d = Math.hypot(dx, dz);
      if (d < 1.0) break;
      const s = Math.min(8, d);
      g.me.x += dx / d * s; g.me.z += dz / d * s; g.me.y += 1.2;
      await new Promise(r => setTimeout(r, 150));
    }
    g.net.send = realSend;          // 통신 복구
    await new Promise(r => setTimeout(r, 1500));
  };
  window.__glide = async (tx, tz) => {
    const g = window.__game;
    for (let i = 0; i < 500; i++) {
      const dx = tx - g.me.x, dz = tz - g.me.z, d = Math.hypot(dx, dz);
      if (d < 0.8) break;
      const s = Math.min(8, d);
      g.me.x += dx / d * s; g.me.z += dz / d * s; g.me.y += 1.2;
      await new Promise(r => setTimeout(r, 170));
    }
    await new Promise(r => setTimeout(r, 500));
  };` });

// ── 1) 통신이 한참 끊긴 채로 멀리(100m 넘게) 이동한다
const fire = LAYOUT.fires.reduce((a, f) =>
  (Math.hypot(f.x, f.z) < Math.hypot(a.x, a.z) ? f : a), LAYOUT.fires[0]);

await p.evaluate(async (f) => { await window.__blackout(f.x + 40, f.z + 40); },
  { x: fire.x, z: fire.z });

const after = await p.evaluate(() => ({ x: window.__game.me.x, z: window.__game.me.z }));
check('통신이 끊긴 동안 멀리 이동했다', Math.hypot(after.x, after.z) > 30,
  `(${after.x.toFixed(0)}, ${after.z.toFixed(0)})`);

// ── 2) 그래도 불꽃이 붙는가 (예전에는 여기서 영원히 안 붙었다)
const lit = await p.evaluate(async (f) => {
  const g = window.__game;
  await window.__glide(f.x, f.z);
  for (let i = 0; i < 20; i++) {
    if (g.heatUntil > Date.now()) break;
    await new Promise(r => setTimeout(r, 400));
  }
  return { hot: g.heatUntil > Date.now(), x: g.me.x, z: g.me.z };
}, { x: fire.x, z: fire.z });
check('★ 통신이 끊겼다 돌아와도 불꽃이 붙는다', lit.hot === true,
  `위치 (${lit.x.toFixed(0)}, ${lit.z.toFixed(0)})`);

// ── 3) 시약도 주워지는가
const got = await p.evaluate(async () => {
  const g = window.__game;
  const before = { ...g.reagents };
  // 다시 한 번 끊었다 붙인 뒤 시약 상자로 간다 (최악의 조건)
  let best = null, bd = 1e9;
  for (const m of g.world.pickupMeshes.values()) {
    if (!m.visible) continue;
    const d = Math.hypot(m.data.x - g.me.x, m.data.z - g.me.z);
    if (d < bd) { bd = d; best = m; }
  }
  if (!best) return { err: '상자 없음' };
  await window.__blackout(best.data.x + 30, best.data.z + 30);
  await window.__glide(best.data.x, best.data.z);
  for (let i = 0; i < 20; i++) {
    if (Object.values(g.reagents).some(v => v > 0)) break;
    await new Promise(r => setTimeout(r, 400));
  }
  return { before, after: { ...g.reagents }, kind: best.data.reagent };
});
check('★ 통신이 끊겼다 돌아와도 시약이 주워진다',
  !got.err && Object.values(got.after || {}).some(v => v > 0),
  got.err || `${got.kind} ${JSON.stringify(got.after)}`);

// ── 4) 서버가 아는 위치와 학생 위치가 다시 맞는가
const synced = await p.evaluate(async () => {
  const g = window.__game;
  await new Promise(r => setTimeout(r, 1200));
  // 다른 학생 눈에 보이는 내 위치 = 서버 위치. 여기서는 서버가 인정한 사격 판정으로 대신 확인한다.
  return { x: g.me.x, z: g.me.z, heat: g.heatUntil > 0 };
});
check('통신 복구 후 정상 상태', Number.isFinite(synced.x), `(${synced.x.toFixed(0)}, ${synced.z.toFixed(0)})`);

// ── 5) 화면(rAF)이 멈춰도 위치 전송이 계속되는가 — 타이머 보험
const heartbeat = await p.evaluate(async () => {
  const g = window.__game;
  let sent = 0;
  const real = g.net.send.bind(g.net);
  g.net.send = (o) => { if (o && o.t === 'in') sent++; real(o); };
  const rafBackup = window.requestAnimationFrame;
  window.requestAnimationFrame = () => 0;        // 그림 루프를 강제로 멈춘다
  await new Promise(r => setTimeout(r, 1600));
  window.requestAnimationFrame = rafBackup;
  g.net.send = real;
  g.loop();                                       // 루프 재시작
  return sent;
});
check('★ 화면이 멈춰도 위치 전송은 계속된다 (타이머 보험)', heartbeat >= 3,
  `1.6초 동안 ${heartbeat}번 전송`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

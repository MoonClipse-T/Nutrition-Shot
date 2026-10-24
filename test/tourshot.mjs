// 새 기능 스크린샷: 대기 공간 → 창고(안전구역) → 옥상
import { chromium } from 'playwright';
import { LAYOUT } from '../public/js/layout.js';

const URL = 'http://localhost:3000';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding'],
});
const p = await b.newPage({ viewport: { width: 1100, height: 660 } });
await p.goto(URL);
await p.waitForSelector('#joinBtn:not([disabled])');
await p.click('#qualitySeg button[data-q="low"]');
await p.fill('#nickInput', '2반 홍길동');
await p.selectOption('#teamSelect', '0');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(4000);

// 1) 대기 공간
await p.evaluate(async () => {
  const g = window.__game;
  g.me.yaw = Math.PI * 0.25; g.me.pitch = -0.05;
  await new Promise(r => setTimeout(r, 1200));
});
await sleep(1500);
await p.screenshot({ path: '/tmp/tour1_lobby.png' });

// 2) 게임 시작 → 창고 안 (안전구역)
const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await sleep(500);
tws.send(JSON.stringify({ t: 'startGame' }));
await sleep(9000);
await p.evaluate(async (b0) => {
  const g = window.__game;
  g.me.yaw = Math.atan2(-b0.x, -b0.z);   // 출입구(섬 중심) 쪽을 본다
  g.me.pitch = -0.05;
  await new Promise(r => setTimeout(r, 1500));
}, { x: LAYOUT.bases[0].x, z: LAYOUT.bases[0].z });
await sleep(1500);
await p.screenshot({ path: '/tmp/tour2_safezone.png' });

// 3) 계단으로 옥상까지 걸어 올라가서 섬을 내려다본다
const base = LAYOUT.bases[0];
const stairs = LAYOUT.solids.filter(s => s.kind === 'stair' &&
  Math.hypot(s.x - base.x, s.z - base.z) < 30).sort((a, c) => (a.y + a.sy / 2) - (c.y + c.sy / 2));
const first = stairs[0], last = stairs[stairs.length - 1];
const dirX = Math.sign(last.x - first.x), dirZ = Math.sign(last.z - first.z);
const entry = { x: first.x - dirX * (first.sx / 2 + 0.6), z: first.z - dirZ * (first.sz / 2 + 0.6) };
await p.evaluate(async ({ entry, dirX, dirZ }) => {
  const g = window.__game;
  const sl = (ms) => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  while (Date.now() - t0 < 14000) {
    const dx = entry.x - g.me.x, dz = entry.z - g.me.z;
    if (Math.hypot(dx, dz) < 1.2) break;
    g.me.yaw = Math.atan2(dx, dz);
    g.input.move.x = 0; g.input.move.y = 1;
    await sl(90);
  }
  g.me.yaw = Math.atan2(dirX, dirZ);
  g.input.move.x = 0; g.input.move.y = 1; g.input.running = false;
  const y0 = g.me.y;
  for (let i = 0; i < 220; i++) {
    g.me.yaw = Math.atan2(dirX, dirZ);
    await sl(120);
    if (g.me.y > y0 + 7.9) break;
  }
  for (let i = 0; i < 14; i++) { g.me.yaw = Math.atan2(dirX, dirZ); await sl(120); }
  g.input.move.y = 0;
  await sl(600);
  // 섬 중심을 내려다본다
  g.me.yaw = Math.atan2(-g.me.x, -g.me.z);
  g.me.pitch = -0.16;
  await sl(1500);
}, { entry, dirX, dirZ });
await sleep(1800);
await p.screenshot({ path: '/tmp/tour3_roof.png' });

const st = await p.evaluate(() => ({ y: window.__game.me.y, safe: !!window.__game.inSafe }));
console.log('옥상 y =', st.y.toFixed(2), '· 안전구역 =', st.safe);
tws.close();
await b.close();

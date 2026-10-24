// 창고 계단으로 실제로 옥상까지 올라가지는지 '걸어서' 확인
import { chromium } from 'playwright';
import { LAYOUT } from '../public/js/layout.js';

const URL = 'http://localhost:3000';
const BASE_I = Number(process.argv[2] || 0);
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!ok) { failures++; process.exitCode = 1; } };

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
await p.fill('#nickInput', '계단');
await p.selectOption('#teamSelect', String(BASE_I));
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await new Promise(r => setTimeout(r, 2000));

// 게임 시작
const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await new Promise(r => setTimeout(r, 500));
tws.send(JSON.stringify({ t: 'startGame' }));
await new Promise(r => setTimeout(r, 7000));

const base = LAYOUT.bases[BASE_I];
console.log(`— ${base.name} 창고 (출입구 ${base.door}) —`);
const stairs = LAYOUT.solids.filter(s => s.kind === 'stair' &&
  Math.hypot(s.x - base.x, s.z - base.z) < 30).sort((a, b2) => (a.y + a.sy / 2) - (b2.y + b2.sy / 2));
const first = stairs[0], last = stairs[stairs.length - 1];
const roofY = base.y + base.H + 0.5;

// 계단 '아래쪽 끝'에서 시작해 위로 걸어 올라간다 (텔레포트 금지 — 실제 물리로만)
const dirZ = Math.sign(last.z - first.z);
const dirX = Math.sign(last.x - first.x);
// 첫 계단 바로 앞(창고 안쪽) — 벽 속으로 들어가지 않도록 half+0.6 만 물러난다
const entry = {
  x: first.x - dirX * (first.sx / 2 + 0.6),
  z: first.z - dirZ * (first.sz / 2 + 0.6),
};
const climb = await p.evaluate(async ({ entry, last, dirX, dirZ }) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const startY = g.me.y;

  const walkTo = async (tx, tz, maxMs = 14000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const dx = tx - g.me.x, dz = tz - g.me.z;
      if (Math.hypot(dx, dz) < 1.2) { g.input.move.y = 0; return true; }
      g.me.yaw = Math.atan2(dx, dz);
      g.input.move.x = 0; g.input.move.y = 1; g.input.running = false;
      await sleep(90);
    }
    g.input.move.y = 0;
    return false;
  };

  const reachedEntry = await walkTo(entry.x, entry.z);
  const entryY = g.me.y;

  // 계단 방향으로 계속 전진 (한 칸씩 올라가야 한다)
  g.me.yaw = Math.atan2(dirX, dirZ);
  g.input.move.x = 0; g.input.move.y = 1; g.input.running = false;
  const climbLog = [];
  for (let i = 0; i < 90; i++) {
    await sleep(120);
    g.me.yaw = Math.atan2(dirX, dirZ);
    if (i % 8 === 0) climbLog.push(`${g.me.y.toFixed(1)}@(${g.me.x.toFixed(0)},${g.me.z.toFixed(0)})`);
    if (g.me.y > entryY + 7) break;
  }
  const stairTopY = g.me.y;
  // 계단 끝에서 한 발 더 — 옥상 바닥(슬래브) 위로 올라선다
  for (let i = 0; i < 16; i++) { g.me.yaw = Math.atan2(dirX, dirZ); await sleep(120); }
  g.input.move.y = 0;
  await sleep(500);
  return { startY, entryY, stairTopY, topY: g.me.y, reachedEntry, climbLog, x: g.me.x, z: g.me.z };
}, { entry, last, dirX, dirZ });

check('계단 입구까지 걸어감', climb.reachedEntry, `y=${climb.entryY.toFixed(1)}`);
check('계단을 걸어 올라감', climb.topY > climb.entryY + 5,
  `바닥 y=${climb.entryY.toFixed(1)} → 위 y=${climb.topY.toFixed(1)} · 상승 기록 ${climb.climbLog.join(' → ')}`);
check('옥상 바닥 위에 올라섬', climb.topY >= base.y + base.H + 0.3,
  `y=${climb.topY.toFixed(2)} · 옥상 바닥 ${(base.y + base.H + 0.5).toFixed(2)} · 계단 끝 ${climb.stairTopY.toFixed(2)}`);

// 옥상에서 걸어다니기 (난간 안쪽에 머무는지)
const onRoof = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const y0 = g.me.y;
  let minY = y0;
  for (let i = 0; i < 24; i++) {
    g.me.yaw = i * 0.5;
    g.input.move.y = 1; g.input.running = true;
    await sleep(160);
    minY = Math.min(minY, g.me.y);
  }
  g.input.move.y = 0; g.input.running = false;
  await sleep(400);
  return { y0, minY, endY: g.me.y, x: g.me.x, z: g.me.z };
});
// 난간이 있으므로 옥상 밖(=창고 바깥 땅)으로 튕겨 나가면 안 된다.
// 계단 구멍으로 내려가는 건 정상 — 그래도 창고 바닥(y0) 아래로는 못 간다.
check('옥상에서 뛰어다녀도 밖으로 떨어지지 않음', onRoof.minY >= base.y - 0.2,
  `최저 y=${onRoof.minY.toFixed(1)} · 창고 바닥 ${base.y.toFixed(1)} (시작 ${onRoof.y0.toFixed(1)})`);
const inFootprint = Math.abs(onRoof.x - base.x) <= base.W / 2 + 1.5 &&
                    Math.abs(onRoof.z - base.z) <= base.D / 2 + 1.5;
check('난간 안쪽에 머무름', inFootprint,
  `(${onRoof.x.toFixed(0)}, ${onRoof.z.toFixed(0)}) · 창고 중심 (${base.x.toFixed(0)}, ${base.z.toFixed(0)})`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await p.screenshot({ path: '/tmp/s15_roof.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

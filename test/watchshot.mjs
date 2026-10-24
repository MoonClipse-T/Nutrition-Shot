// 교사 화면에서 학생 화면을 보는 모습 + 실험노트 후보 목록 + 비커 결과판 캡처
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { DRINKS, REAGENTS } from '../public/js/gamedata.js';

const URL = 'http://localhost:3000';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});

// --- 학생 ---
const s = await b.newPage({ viewport: { width: 1024, height: 640 } });
s.on('pageerror', e => console.log('S-ERR', e.message));
await s.goto(URL);
await s.waitForSelector('#joinBtn:not([disabled])');
await s.click('#qualitySeg button[data-q="mid"]');
await s.fill('#nickInput', '홍길동');
await s.click('#joinBtn');
await s.waitForFunction(() => !!window.__game);
await new Promise(r => setTimeout(r, 2500));

await s.addScriptTag({ content: `
  window.__glide = async (tx, tz) => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 300; i++) {
      const dx = tx - g.me.x, dz = tz - g.me.z, d = Math.hypot(dx, dz);
      if (d < 0.8) break;
      const st = Math.min(8, d);
      g.me.x += dx / d * st; g.me.z += dz / d * st; g.me.y += 1.2;
      await sleep(150);
    }
    await sleep(400);
  };`});

// 시약을 좀 줍고 비커 A 앞으로
await s.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (const w of ['iodine', 'benedict', 'biuret', 'sudan']) {
    let best = null, bd = 1e9;
    for (const m of g.world.pickupMeshes.values()) {
      if (m.data.reagent !== w || !m.visible) continue;
      const d = Math.hypot(m.data.x - g.me.x, m.data.z - g.me.z);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) { await window.__glide(best.data.x, best.data.z); await sleep(400); }
  }
  await window.__glide(0, 17);
  g.me.yaw = Math.PI; g.me.pitch = 0.13;
  await sleep(900);
});

// 실험노트 (후보 8종)
await s.click('#btnNote');
await new Promise(r => setTimeout(r, 700));
await s.screenshot({ path: '/tmp/s3_note.png' });
await s.click('#panelNote .x');
await new Promise(r => setTimeout(r, 400));

// 비커에 쏴서 결과판 띄우기
await s.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const e = g.camera.matrixWorld.elements;
  const bk = g.world.beakers[0];
  for (let i = 0; i < 4; i++) {
    const el = g.camera.matrixWorld.elements;
    const fx = -el[8], fy = -el[9], fz = -el[10];
    const cp = g.camera.position;
    let dx = bk.x - cp.x, dy = (bk.y + 4.2) - cp.y, dz = bk.z - cp.z;
    const d = Math.hypot(dx, dy, dz); dx /= d; dy /= d; dz /= d;
    let dyaw = Math.atan2(dx, dz) - Math.atan2(fx, fz);
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    g.me.yaw += dyaw;
    g.me.pitch += Math.asin(Math.max(-1, Math.min(1, dy))) - Math.asin(Math.max(-1, Math.min(1, fy)));
    await sleep(220);
  }
  g.selectAmmo(1); g.lastShot = 0; g.tryShoot();
  await sleep(800);
});
await s.screenshot({ path: '/tmp/s11_beakerlabel.png' });

// --- 교사 ---
const t = await b.newPage({ viewport: { width: 1320, height: 1080 } });
await t.goto(`${URL}/teacher`);
await new Promise(r => setTimeout(r, 2500));
await t.evaluate(() => {
  const tr = document.querySelector('#students tr[data-id]');
  if (tr) tr.click();
});
// 학생이 계속 움직이도록
s.evaluate(async () => {
  const g = window.__game;
  for (let i = 0; i < 40; i++) {
    g.input.move.x = Math.sin(i / 3); g.input.move.y = 1; g.input.running = true;
    await new Promise(r => setTimeout(r, 200));
  }
  g.input.move.x = 0; g.input.move.y = 0; g.input.running = false;
}).catch(() => {});
await new Promise(r => setTimeout(r, 5000));
await t.screenshot({ path: '/tmp/s12_watch.png', fullPage: false });

console.log('done');
await b.close();
process.exit(0);

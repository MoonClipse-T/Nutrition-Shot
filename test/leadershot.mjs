// 선두 모둠 발표 배너 캡처 (추격자 시점 / 선두 본인 시점)
import { chromium } from 'playwright';
import { LAYOUT } from '../public/js/layout.js';

const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});
const pages = [];
const NICKS = ['2반 홍길동', '2반 김서연', '2반 박지훈'];
for (let i = 0; i < 3; i++) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 660 } });
  const pg = await ctx.newPage();
  await pg.goto(URL);
  await pg.waitForSelector('#joinBtn:not([disabled])');
  await pg.click('#qualitySeg button[data-q="mid"]');
  await pg.fill('#nickInput', NICKS[i]);
  await pg.selectOption('#teamSelect', i === 2 ? '1' : '0');   // 0,1번 = 1모둠 / 2번 = 2모둠
  await pg.click('#joinBtn');
  await pg.waitForFunction(() => !!window.__game);
  pages.push(pg);
}
const [lead1, lead2, chase] = pages;
await sleep(2500);

const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await sleep(400);
tws.send(JSON.stringify({ t: 'startGame' }));
await sleep(9000);
tws.send(JSON.stringify({ t: 'supply', kind: 'reagent', amount: 12 }));
await sleep(1000);

const GLIDE = `
  window.__glide = async (tx, tz) => {
    const g = window.__game;
    for (let i = 0; i < 500; i++) {
      const dx = tx - g.me.x, dz = tz - g.me.z, d = Math.hypot(dx, dz);
      if (d < 0.8) break;
      const s = Math.min(8, d);
      g.me.x += dx / d * s; g.me.z += dz / d * s; g.me.y += 1.2;
      await new Promise(r => setTimeout(r, 190));
    }
    await new Promise(r => setTimeout(r, 400));
  };
  window.__aim = async (getT) => {
    const g = window.__game;
    for (let i = 0; i < 18; i++) {
      const T = getT(); if (!T) return false;
      const e = g.camera.matrixWorld.elements;
      const fx = -e[8], fy = -e[9], fz = -e[10];
      const cp = g.camera.position;
      let dx = T.x - cp.x, dy = T.y - cp.y, dz = T.z - cp.z;
      const d = Math.hypot(dx, dy, dz); dx /= d; dy /= d; dz /= d;
      let dyaw = Math.atan2(dx, dz) - Math.atan2(fx, fz);
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      g.me.yaw += dyaw;
      g.me.pitch += Math.asin(Math.max(-1, Math.min(1, dy))) - Math.asin(Math.max(-1, Math.min(1, fy)));
      await new Promise(r2 => setTimeout(r2, 180));
    }
    return true;
  };`;
for (const pg of pages) await pg.addScriptTag({ content: GLIDE });

// 1모둠이 검사해서 앞서 나간다
const bk = LAYOUT.beakers[0];
await lead1.evaluate(async (b0) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const near = g.world.nearestFire(b0.x, b0.z);
  if (near) { await window.__glide(near.fire.x, near.fire.z); await sleep(400); }
  await window.__glide(b0.x, b0.z + 13);
  await window.__aim(() => ({ x: b0.x, y: b0.y + 4.2, z: b0.z }));
  for (let a = 1; a <= 4; a++) { g.selectAmmo(a); g.lastShot = 0; g.tryShoot(); await sleep(550); }
}, { x: bk.x, y: bk.y, z: bk.z });

// 추격자를 1모둠 근처로 옮겨 이름표(왕관)가 보이게 한다
await chase.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 90; i++) {
    const foe = [...g.remote.values()].find(r => r.team !== g.myTeam);
    if (!foe) { await sleep(300); continue; }
    const dx = foe.x - g.me.x, dz = foe.z - g.me.z, d = Math.hypot(dx, dz);
    if (d < 15) break;
    const s = Math.min(7, d - 13);
    g.me.x += dx / d * s; g.me.z += dz / d * s; g.me.y += 1.2;
    await sleep(200);
  }
  const foe = [...g.remote.values()].find(r => r.team !== g.myTeam);
  if (foe) { g.me.yaw = Math.atan2(foe.x - g.me.x, foe.z - g.me.z); g.me.pitch = 0.02; }
  await sleep(1500);
});

// 발표를 기다린다
console.log('   발표 대기 중…');
await chase.evaluate(async () => {
  // 배너가 '실제로 떠 있는' 순간을 잡는다 (발표는 주기적으로 반복된다)
  for (let i = 0; i < 400; i++) {
    if (!document.getElementById('leaderBanner').hidden) break;
    await new Promise(r => setTimeout(r, 400));
  }
  await new Promise(r => setTimeout(r, 400));
});
await sleep(400);
await chase.screenshot({ path: '/tmp/leader1_chase.png' });
await lead1.screenshot({ path: '/tmp/leader2_self.png' });

const st = await chase.evaluate(() => ({
  banner: document.getElementById('leaderBanner').textContent.replace(/\s+/g, ' ').trim(),
  chip: document.getElementById('leaderChip').textContent.replace(/\s+/g, ' ').trim(),
}));
console.log('배너:', st.banner);
console.log('칩  :', st.chip);
tws.close();
await b.close();

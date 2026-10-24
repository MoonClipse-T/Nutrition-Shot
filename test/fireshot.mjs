// 가열대(불꽃) + 몸에 붙은 불 + 실험노트 가열 안내 캡처
import { chromium } from 'playwright';
import { LAYOUT } from '../public/js/layout.js';

const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding'],
});
const p = await b.newPage({ viewport: { width: 1100, height: 660 } });
await p.goto(URL);
await p.waitForSelector('#joinBtn:not([disabled])');
await p.click('#qualitySeg button[data-q="mid"]');
await p.fill('#nickInput', '2반 홍길동');
await p.selectOption('#teamSelect', '0');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await sleep(3000);

const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await sleep(400);
tws.send(JSON.stringify({ t: 'startGame' }));
await sleep(9000);
tws.send(JSON.stringify({ t: 'supply', kind: 'reagent', amount: 12 }));
await sleep(1000);

await p.addScriptTag({ content: `
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
  };`});

// 중앙 비커 근처의 불로 간다
const beaker = LAYOUT.beakers[0];
let near = null, nd = Infinity;
for (const f of LAYOUT.fires) {
  const d = Math.hypot(f.x - beaker.x, f.z - beaker.z);
  if (d < nd) { nd = d; near = f; }
}

// 1) 불 앞 (몸에 불이 붙은 상태)
await p.evaluate(async (f) => {
  const g = window.__game;
  await window.__glide(f.x - 7, f.z - 7);
  g.me.yaw = Math.atan2(f.x - g.me.x, f.z - g.me.z);
  g.me.pitch = -0.02;
  await new Promise(r => setTimeout(r, 2000));
}, { x: near.x, z: near.z });
await sleep(1600);
await p.screenshot({ path: '/tmp/fire1_heat.png' });

// 2) 실험노트 (가열 안내)
await p.click('#btnNote');
await sleep(900);
await p.screenshot({ path: '/tmp/fire2_note.png' });
await p.click('#panelNote .x');
await sleep(400);

// 3) 가열된 채로 비커 앞
await p.evaluate(async (bk) => {
  const g = window.__game;
  await window.__glide(bk.x + 2, bk.z + 16);
  g.me.yaw = Math.atan2(bk.x - g.me.x, bk.z - g.me.z);
  g.me.pitch = 0.06;
  await new Promise(r => setTimeout(r, 1500));
}, { x: beaker.x, z: beaker.z });
await sleep(1400);
await p.screenshot({ path: '/tmp/fire3_beaker.png' });

const st = await p.evaluate(() => ({
  hot: window.__game.heatUntil > Date.now(),
  badge: document.getElementById('heatBadge').textContent.trim(),
}));
console.log('가열=', st.hot, '·', st.badge);
tws.close();
await b.close();

import { chromium } from 'playwright';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 1000, height: 620 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('http://localhost:3000');
await p.waitForSelector('#joinBtn:not([disabled])');
await p.fill('#nickInput', 'fps');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await new Promise(r => setTimeout(r, 1500));
const r = await p.evaluate(async () => {
  const g = window.__game;
  let f = 0; const t0 = performance.now();
  const tick = () => { f++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await new Promise(r => setTimeout(r, 2200));
  const p0 = { ...g.me };
  g.input.move.x = 0; g.input.move.y = 1; g.input.running = true;
  await new Promise(r => setTimeout(r, 2000));
  g.input.move.y = 0; g.input.running = false;
  const p1 = { ...g.me };
  return {
    fps: f / 2, moved: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2), p0, p1,
    down: g.down, speed: g.me.speed, onGround: g.me.onGround,
    panels: [...document.querySelectorAll('.panel:not([hidden])')].map(e => e.id),
  };
});
console.log(JSON.stringify(r, null, 1));
await p.screenshot({ path: '/tmp/fps.png' });
await b.close();

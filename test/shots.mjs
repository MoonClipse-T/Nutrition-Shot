// 화면이 실제로 어떻게 보이는지 스크린샷으로 확인
import { chromium } from 'playwright';

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

// --- 학생 화면 ---
const p = await b.newPage({ viewport: { width: 1024, height: 640 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('http://localhost:3000');
await p.waitForSelector('#joinBtn:not([disabled])');
await p.screenshot({ path: '/tmp/s0_lobby.png' });
await p.click('#qualitySeg button[data-q="mid"]');
await p.fill('#nickInput', '홍길동');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await new Promise(r => setTimeout(r, 2500));

await p.addScriptTag({ content: `
  window.__glide = async (tx, tz) => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 300; i++) {
      const dx = tx - g.me.x, dz = tz - g.me.z, d = Math.hypot(dx, dz);
      if (d < 0.8) break;
      const s = Math.min(5, d);
      g.me.x += dx / d * s; g.me.z += dz / d * s; g.me.y += 1.2;
      await sleep(120);
    }
    await sleep(400);
  };`});

// 비커 A 앞 (컨테이너 야드 광장)
await p.evaluate(async () => {
  const g = window.__game;
  await window.__glide(0, 16);
  g.me.yaw = Math.PI; g.me.pitch = 0.12;
  await new Promise(r => setTimeout(r, 900));
});
await p.screenshot({ path: '/tmp/s1_beaker.png' });

// 시약 여러 개 줍고 반응 일으키기
await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (const w of ['iodine', 'benedict', 'biuret', 'sudan']) {
    let best = null, bd = 1e9;
    for (const m of g.world.pickupMeshes.values()) {
      if (m.data.reagent !== w || !m.visible) continue;
      const d = Math.hypot(m.data.x - g.me.x, m.data.z - g.me.z);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) { await window.__glide(best.data.x, best.data.z); await sleep(500); }
  }
  await window.__glide(0, 15);
  g.me.yaw = Math.PI; g.me.pitch = 0.1;
  await sleep(800);
});
await p.screenshot({ path: '/tmp/s2_armed.png' });

// 자격시험 패널
await p.click('#btnQuiz');
await new Promise(r => setTimeout(r, 1400));
await p.screenshot({ path: '/tmp/s7_quiz.png' });
await p.click('#panelQuiz .x');
await new Promise(r => setTimeout(r, 300));

// 정답 제출 패널 (A·B·C 한 번에)
await p.click('#btnAnswer');
await new Promise(r => setTimeout(r, 600));
await p.evaluate(() => {
  document.querySelectorAll('.drink[data-bi="0"]')[3]?.click();
  document.querySelectorAll('.drink[data-bi="1"]')[4]?.click();
  document.querySelectorAll('.drink[data-bi="2"]')[6]?.click();
});
await new Promise(r => setTimeout(r, 400));
await p.screenshot({ path: '/tmp/s8_answer.png' });
await p.click('#panelAnswer .x');
await new Promise(r => setTimeout(r, 300));

// 실험노트 패널
await p.click('#btnNote');
await new Promise(r => setTimeout(r, 500));
await p.screenshot({ path: '/tmp/s3_note.png' });
await p.click('#panelNote .x');

// 창고 쪽 풍경
await p.evaluate(async () => {
  const g = window.__game;
  await window.__glide(-80, -8);
  g.me.yaw = Math.PI; g.me.pitch = 0.05;
  await new Promise(r => setTimeout(r, 900));
});
await p.screenshot({ path: '/tmp/s4_warehouse.png' });

// --- 선생님 화면 ---
const t = await b.newPage({ viewport: { width: 1280, height: 860 } });
await t.goto('http://localhost:3000/teacher');
await new Promise(r => setTimeout(r, 1500));
await t.click('#peek');
await t.screenshot({ path: '/tmp/s5_teacher.png', fullPage: true });

// --- 학습지 ---
const w = await b.newPage({ viewport: { width: 900, height: 1200 } });
await w.goto('http://localhost:3000/worksheet');
await new Promise(r => setTimeout(r, 800));
await w.screenshot({ path: '/tmp/s6_worksheet.png', fullPage: true });
await w.pdf({ path: '/tmp/worksheet.pdf', format: 'A4', printBackground: true });

console.log('done');
await b.close();

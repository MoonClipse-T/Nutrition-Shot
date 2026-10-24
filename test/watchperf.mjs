// 선생님이 학생 화면을 볼 때 — 실제로 뜨는가 / 학생 쪽이 얼마나 느려지는가
import { chromium } from 'playwright';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!ok) { failures++; process.exitCode = 1; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});
const errors = [];

// --- 학생 ---
const s = await b.newPage({ viewport: { width: 900, height: 560 } });
s.on('pageerror', e => errors.push(`[학생] ${e.message}`));
s.on('console', m => { if (m.type() === 'error') errors.push(`[학생] ${m.text()}`); });
await s.goto(URL);
await s.waitForSelector('#joinBtn:not([disabled])');
await s.click('#qualitySeg button[data-q="low"]');
await s.fill('#nickInput', '관찰대상');
await s.selectOption('#teamSelect', '0');
await s.click('#joinBtn');
await s.waitForFunction(() => !!window.__game);
await wait(2500);

// --- 선생님 화면 (사람처럼 클릭해서 관찰 시작) ---
const t = await b.newPage({ viewport: { width: 1280, height: 900 } });
t.on('pageerror', e => errors.push(`[교사] ${e.message}`));
t.on('console', m => { if (m.type() === 'error') errors.push(`[교사] ${m.text()}`); });
await t.goto(`${URL}/teacher`);
await wait(1500);

// 게임 시작 — 교사 화면의 진짜 버튼을 누른다
await t.click('#btnStart');
await wait(9000);
const phase = await s.evaluate(() => window.__game.phase);
check('교사 화면 버튼으로 게임 시작', phase === 'playing', `phase=${phase}`);

// ── 1) 관찰 전 학생의 프레임 수 (기준값)
const fpsBefore = await s.evaluate(async () => {
  let f = 0; const t0 = performance.now();
  await new Promise(res => {
    const tick = () => { f++; if (performance.now() - t0 < 6000) requestAnimationFrame(tick); else res(); };
    requestAnimationFrame(tick);
  });
  return f / ((performance.now() - t0) / 1000);
});

// ── 2) 학생 이름을 클릭해서 관찰 시작 (사람이 하는 그대로)
await t.waitForSelector('#students tr');
await t.click('#students tr');
await wait(6000);

const shown = await t.evaluate(() => {
  const img = document.getElementById('watchImg');
  const w = document.getElementById('watchWait');
  return {
    src: (img.src || '').slice(0, 5),
    hasBlob: (img.src || '').startsWith('blob:'),
    natural: img.naturalWidth,
    waitHidden: w.hidden,
    state: document.getElementById('watchState').textContent.replace(/\s+/g, ' ').trim().slice(0, 90),
  };
});
check('학생 화면이 실제로 뜬다', shown.hasBlob && shown.natural > 100,
  `src=${shown.src}… 가로 ${shown.natural}px`);
check('"불러오는 중" 안내가 사라진다', shown.waitHidden === true, `숨김=${shown.waitHidden}`);
check('학생 상태값도 같이 표시된다', /점수/.test(shown.state), shown.state);

// ── 3) 관찰 중 학생의 프레임 수 — 얼마나 떨어지나
const during = await s.evaluate(async () => {
  let f = 0; const t0 = performance.now();
  await new Promise(res => {
    const tick = () => { f++; if (performance.now() - t0 < 6000) requestAnimationFrame(tick); else res(); };
    requestAnimationFrame(tick);
  });
  const g = window.__game;
  return {
    fps: f / ((performance.now() - t0) / 1000),
    streaming: !!g.streaming,
    cost: Math.round(g._capCost || 0),
    interval: Math.round(g._captureInterval()),
  };
});
check('학생 쪽에서 송출이 켜져 있다', during.streaming === true);
const drop = (1 - during.fps / fpsBefore) * 100;
check('관찰해도 학생 화면이 크게 느려지지 않는다', drop < 25,
  `${fpsBefore.toFixed(1)} fps → ${during.fps.toFixed(1)} fps (${drop.toFixed(0)}% 감소)`);
check('캡처 비용을 재서 간격을 스스로 조절한다',
  during.cost >= 0 && during.interval >= during.cost * 9,
  `캡처 1장 ${during.cost}ms · 간격 ${during.interval}ms`);

// ── 4) 프레임이 끊이지 않고 계속 오는가
const frames = await t.evaluate(async () => {
  const img = document.getElementById('watchImg');
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    seen.add(img.src);
    await new Promise(r => setTimeout(r, 400));
  }
  return seen.size;
});
check('화면이 계속 갱신된다 (12초 동안)', frames >= 4, `${frames}장 갱신`);

// ── 5) 그만 보기 → 학생 송출도 멈춘다
await t.click('#watchStop');
await wait(1500);
const off = await s.evaluate(() => ({
  streaming: !!window.__game.streaming,
  badge: !document.getElementById('watchedBadge').hidden,
}));
check('그만 보면 송출이 멈춘다', off.streaming === false && off.badge === false);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await t.screenshot({ path: '/tmp/watchperf.png', fullPage: true });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
await b.close();
process.exit(process.exitCode || 0);

// ★ 베네딕트 = 가열 필요 : 불에 다가가야만 반응하는지 검증
import { chromium } from 'playwright';
import { LAYOUT } from '../public/js/layout.js';
import { RULES, DRINKS } from '../public/js/gamedata.js';
import { readFileSync } from 'fs';

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
await p.fill('#nickInput', '가열');
await p.selectOption('#teamSelect', '0');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await wait(2500);

// ── 0) 대기 공간에서는 자격시험을 볼 수 없다
const quizBlocked = await p.evaluate(async () => {
  const g = window.__game;
  g.hud.togglePanel('quiz');
  await new Promise(r => setTimeout(r, 900));
  return {
    open: !document.getElementById('panelQuiz').hidden,
    dimmed: document.getElementById('btnQuiz').classList.contains('dimmed'),
  };
});
check('대기 공간에서는 자격시험 패널이 안 열림', !quizBlocked.open && quizBlocked.dimmed,
  `열림=${quizBlocked.open} 버튼비활성=${quizBlocked.dimmed}`);

// 서버도 막는지 (클라이언트를 우회해서 직접 보내 본다)
const quizServerBlocked = await p.evaluate(async () => {
  const g = window.__game;
  g.hud.quizQ = null;
  g.net.send({ t: 'quizStart' });
  await new Promise(r => setTimeout(r, 1200));
  return { got: !!g.hud.quizQ, html: document.getElementById('quizBody').textContent.slice(0, 40) };
});
check('서버도 대기 중 자격시험 발급을 거부', !quizServerBlocked.got,
  `문제 수신=${quizServerBlocked.got} · "${quizServerBlocked.html.trim()}"`);

// ── 게임 시작
const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(500);
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);

// 걸어서 이동하는 헬퍼 (서버가 순간이동을 거부하므로 조금씩 옮긴다)
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
  };
  window.__aim = async (getT) => {
    const g = window.__game;
    for (let i = 0; i < 22; i++) {
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
      await new Promise(r => setTimeout(r, 200));
    }
    return true;
  };` });

// 지도에 불꽃이 실제로 있는가
check('필드에 가열대(불꽃)가 배치됨', (LAYOUT.fires || []).length >= 8,
  `${(LAYOUT.fires || []).length}곳`);

// 중앙 비커(0번)와 그 근처의 불을 쓴다
const beaker = LAYOUT.beakers[0];
let near = null, nd = Infinity;
for (const f of LAYOUT.fires) {
  const d = Math.hypot(f.x - beaker.x, f.z - beaker.z);
  if (d < nd) { nd = d; near = f; }
}
check('비커 근처에 불이 있음 (뛰어갔다 올 수 있는 거리)', nd < RULES.RUN_SPEED * RULES.HEAT_SECONDS * 0.5,
  `비커 A ↔ 가장 가까운 불 ${nd.toFixed(0)}m`);

// 시약 채우기 (교사 보급)
tws.send(JSON.stringify({ t: 'supply', kind: 'reagent', amount: 12 }));
await wait(1200);

// ── 1) 식은 상태에서 베네딕트를 쏘면 반응이 없어야 한다
const cold = await p.evaluate(async (bk) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await window.__glide(bk.x, bk.z + 11);
  // 오는 길에 불을 스쳤을 수 있으니, 서버가 '불이 꺼졌다'고 알려줄 때까지 기다린다
  for (let i = 0; i < 70; i++) {
    if (!(g.heatUntil > Date.now())) break;
    await sleep(600);
  }
  let noHeat = false;
  const prev = g.net.handlers.get('noHeat');
  g.net.on('noHeat', (m) => { noHeat = true; if (prev) prev(m); });
  const ammoIdx = g.hud.ammoSlots.findIndex(s => s.id === 'benedict');
  g.selectAmmo(ammoIdx);
  await sleep(400);
  await window.__aim(() => ({ x: bk.x, y: bk.y + 4, z: bk.z }));
  g.lastShot = 0; g.tryShoot();
  await sleep(1600);
  return { noHeat, note: g.hud.notes[bk.drink].benedict, hot: g.heatUntil > Date.now(),
           badge: document.getElementById('heatBadge').textContent.trim() };
}, { x: beaker.x, y: beaker.y, z: beaker.z, drink: beaker.drink });
check('식은 채로 쏜 베네딕트 → 반응 없음 + 안내',
  cold.hot === false && cold.noHeat === true && cold.note === undefined,
  `가열=${cold.hot} · noHeat 안내=${cold.noHeat} · 실험노트 기록=${JSON.stringify(cold.note)} · 배지 "${cold.badge}"`);

// ── 2) 불에 다가가면 몸에 불이 붙는다
const lit = await p.evaluate(async (f) => {
  const g = window.__game;
  await window.__glide(f.x, f.z);
  await new Promise(r => setTimeout(r, 1400));
  return {
    hot: g.heatUntil > Date.now(),
    left: Math.round((g.heatUntil - Date.now()) / 1000),
    badge: !document.getElementById('heatBadge').hidden,
  };
}, { x: near.x, z: near.z });
check('불꽃에 다가가면 몸에 불이 붙음', lit.hot && lit.badge,
  `남은 ${lit.left}초 · 화면 표시=${lit.badge}`);

// ── 3) 가열 상태에서 쏜 베네딕트는 반응한다
const hotShot = await p.evaluate(async (bk) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await window.__glide(bk.x, bk.z + 11);
  const hotOnArrival = g.heatUntil > Date.now();
  g.hud.notes[bk.drink].benedict = 'PENDING';
  const ammoIdx = g.hud.ammoSlots.findIndex(s => s.id === 'benedict');
  g.selectAmmo(ammoIdx);
  await sleep(300);
  await window.__aim(() => ({ x: bk.x, y: bk.y + 4, z: bk.z }));
  g.lastShot = 0; g.tryShoot();
  await sleep(1600);
  return { hotOnArrival, note: g.hud.notes[bk.drink].benedict };
}, { x: beaker.x, y: beaker.y, z: beaker.z, drink: beaker.drink });
check('불을 쬐고 달려와 쏜 베네딕트 → 반응함', hotShot.note === true || hotShot.note === false,
  `비커 도착 시 가열=${hotShot.hotOnArrival} · 실험노트 기록=${JSON.stringify(hotShot.note)}`);

// 기록된 결과가 실제 음료 성분과 맞는가
const logTxt = readFileSync('/tmp/srv.log', 'utf8');
const mm = [...logTxt.matchAll(/라운드 시작 — 정답: (.+)$/gm)].pop();
if (mm) {
  const names = mm[1].split(' / ').map(s => s.replace(/^\([ABC]\)\s*/, '').trim());
  const drink = DRINKS.find(d => d.name === names[beaker.drink]);
  check('가열 후 베네딕트 결과가 음료 성분과 일치',
    hotShot.note === drink.has.includes('sugar'),
    `정답 ${drink.name} (당류 ${drink.has.includes('sugar') ? '있음' : '없음'}) · 결과 ${hotShot.note}`);
}

// ── 4) 다른 시약은 가열 없이도 그대로 반응한다
const other = await p.evaluate(async (bk) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  g.heatUntil = 0;
  g.hud.notes[bk.drink].iodine = 'PENDING';
  const ammoIdx = g.hud.ammoSlots.findIndex(s => s.id === 'iodine');
  g.selectAmmo(ammoIdx);
  await sleep(300);
  await window.__aim(() => ({ x: bk.x, y: bk.y + 4, z: bk.z }));
  g.lastShot = 0; g.tryShoot();
  await sleep(1600);
  return { note: g.hud.notes[bk.drink].iodine };
}, { x: beaker.x, y: beaker.y, z: beaker.z, drink: beaker.drink });
check('아이오딘은 가열 없이도 반응', other.note === true || other.note === false,
  `실험노트 기록=${JSON.stringify(other.note)}`);

// ── 5) 게임이 시작되면 자격시험은 열린다
const quizNow = await p.evaluate(async () => {
  const g = window.__game;
  g.hud.quizQ = null;
  g.hud.togglePanel('quiz');
  await new Promise(r => setTimeout(r, 1300));
  return { open: !document.getElementById('panelQuiz').hidden, got: !!g.hud.quizQ };
});
check('게임 시작 후에는 자격시험 응시 가능', quizNow.open && quizNow.got,
  `패널=${quizNow.open} 문제수신=${quizNow.got}`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await p.screenshot({ path: '/tmp/heat.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

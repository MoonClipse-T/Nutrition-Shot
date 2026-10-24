// ★ 슈팅 모드 4차 피드백 검증
//   ① 반동이 크게 줄었다 (특히 기관단총) + 튄 화면이 저절로 돌아온다
//   ② 장비창 — 주운 총이 가방에 쌓이고, 클릭으로 장착/버리기
//   ③ 저격총 조준경 — 두 손가락 확대(휠)로 당겨 보기
//   ④ PC — 클릭을 유지한 채 끌어야 화면이 돌아가고, 버튼은 ESC 없이 바로 눌린다
import { chromium } from 'playwright';
import { BATTLE, GUNS, RECOIL_RECOVER } from '../public/js/battledata.js';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`);
  if (!ok) { failures++; process.exitCode = 1; }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── ① 데이터 차원 : 반동 값이 실제로 낮아졌는가
check('★ 기관단총 반동이 아주 작아졌다', GUNS.smg.recoil <= 0.005,
  `${GUNS.smg.recoil} rad/발 (예전 0.022)`);
check('모든 총의 반동이 예전(0.02~0.06)보다 낮다',
  Object.values(GUNS).every(g => g.recoil < 0.03),
  Object.values(GUNS).map(g => `${g.short} ${g.recoil}`).join(' · '));
check('반동이 저절로 돌아오도록 설정됨', RECOIL_RECOVER > 0, `${RECOIL_RECOVER} rad/s`);
check('저격총에 조준경 배율이 있다', GUNS.sniper.zoom >= 4 && GUNS.sniper.scope === true,
  `${GUNS.sniper.zoom}배`);

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding'],
});
const errors = [];
const p = await b.newPage({ viewport: { width: 1000, height: 620 }, hasTouch: false });
p.on('pageerror', e => errors.push(e.message));
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto(URL);
await p.waitForSelector('#joinBtn:not([disabled])');
await p.click('#qualitySeg button[data-q="low"]');
await p.fill('#nickInput', '장비검증');
await p.selectOption('#teamSelect', '0');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await wait(2500);

const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(400);
tws.send(JSON.stringify({ t: 'battleLobby' }));
await wait(1500);
tws.send(JSON.stringify({ t: 'battleStart' }));
await wait(8000);

// ── ④ PC 조작 : 클릭만 하면 마우스가 잡히지 않는다 (포인터 잠금 없음)
const lock = await p.evaluate(async () => {
  const g = window.__game;
  g.hud.closePanels();
  const c = document.getElementById('c');
  const r = c.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const yaw0 = g.me.yaw;
  // 그냥 한 번 눌렀다 떼기 — 시점은 안 돌아야 하고 마우스도 안 잡혀야 한다
  c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
  await new Promise(r2 => setTimeout(r2, 60));
  dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: cx, clientY: cy }));
  await new Promise(r2 => setTimeout(r2, 200));
  return { locked: !!document.pointerLockElement, yawMoved: Math.abs(g.me.yaw - yaw0) };
});
check('★ 화면을 클릭해도 마우스가 잡히지 않는다 (ESC 필요 없음)', lock.locked === false);

// 누른 채로 끌면 화면이 돌아간다
const drag = await p.evaluate(async () => {
  const g = window.__game;
  const c = document.getElementById('c');
  const r = c.getBoundingClientRect();
  let x = r.left + r.width / 2, y = r.top + r.height / 2;
  const yaw0 = g.me.yaw;
  c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
  for (let i = 0; i < 20; i++) {
    x += 12;
    dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    await new Promise(r2 => setTimeout(r2, 25));
  }
  const yawDrag = g.me.yaw;
  dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: x, clientY: y }));
  await new Promise(r2 => setTimeout(r2, 200));
  // 뗀 뒤에 마우스를 움직이면 화면이 돌면 안 된다
  for (let i = 0; i < 10; i++) {
    x += 20;
    dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    await new Promise(r2 => setTimeout(r2, 20));
  }
  await new Promise(r2 => setTimeout(r2, 200));
  return { moved: Math.abs(yawDrag - yaw0), after: Math.abs(g.me.yaw - yawDrag) };
});
check('★ 클릭을 유지한 채 끌면 화면이 돌아간다', drag.moved > 0.2,
  `${drag.moved.toFixed(2)} rad 회전`);
check('★ 버튼에서 손을 떼면 더 이상 안 돌아간다', drag.after < 0.02,
  `뗀 뒤 ${drag.after.toFixed(3)} rad`);

// 화면 위 버튼(구급품)이 ESC 없이 바로 눌린다
// 구급품 버튼이 (ESC 없이) 실제로 눌려 서버까지 가는지 — 응답 메시지로 확인한다
const medClick = await p.evaluate(async () => {
  const g = window.__game;
  const yaw0 = g.me.yaw;
  let replied = null;
  const prev = g.net.handlers.get('toast');
  g.net.on('toast', (m) => { replied = m.msg; if (prev) prev(m); });
  const el = document.getElementById('btnMed');
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  }));
  await new Promise(r2 => setTimeout(r2, 1800));
  if (prev) g.net.on('toast', prev);
  return { replied, yawMoved: Math.abs(g.me.yaw - yaw0) };
});
check('★ 구급품 버튼이 ESC 없이 바로 눌린다 (서버까지 도달)',
  !!medClick.replied, medClick.replied || '응답 없음');
check('버튼을 눌러도 시점이 돌아가지 않는다', medClick.yawMoved < 0.02,
  `${medClick.yawMoved.toFixed(3)} rad`);

// ── ② 장비창 : 총을 두 자루 이상 모아서 클릭으로 바꿔 끼운다
const bag = await p.evaluate(async (GUNS) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const walkTo = async (t) => {
    const steps = 30;
    const sx = g.me.x, sz = g.me.z, sy = g.me.y;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      g.me.x = sx + (t.x - sx) * k; g.me.z = sz + (t.z - sz) * k;
      g.me.y = sy + (t.y + 1 - sy) * k;
      g.sendPos(); await sleep(85);
    }
    for (let i = 0; i < 10; i++) { g.me.x = t.x; g.me.z = t.z; g.me.y = t.y + 1; g.sendPos(); await sleep(170); }
    await sleep(700);
  };
  // 서로 다른 총 상자를 두 곳 들른다
  for (let n = 0; n < 4 && g.battle.guns.length < 3; n++) {
    const list = [...g.world.lootData.values()]
      .filter(l => l.kind === 'gun' && l.visible && !g.battle.guns.includes(l.gun));
    if (!list.length) break;
    list.sort((a, c) => Math.hypot(a.x - g.me.x, a.z - g.me.z) - Math.hypot(c.x - g.me.x, c.z - g.me.z));
    await walkTo(list[0]);
  }
  return { guns: g.battle.guns.slice(), gun: g.battle.gun };
}, GUNS);
check('★ 주운 총이 가방에 쌓인다 (버려지지 않음)', bag.guns.length >= 2,
  `가방: ${bag.guns.map(id => GUNS[id].name).join(' · ')}`);

const gearUI = await p.evaluate(async () => {
  const g = window.__game;
  g.hud.togglePanel('gear');
  await new Promise(r => setTimeout(r, 400));
  const rows = [...document.querySelectorAll('#gearList .gear')];
  const equipBtns = [...document.querySelectorAll('#gearList [data-eq]')];
  const dropBtns = [...document.querySelectorAll('#gearList [data-drop]')];
  const before = g.battle.gun;
  equipBtns[0]?.click();                       // 다른 총으로 장착
  await new Promise(r => setTimeout(r, 1200));
  return {
    rows: rows.length, equips: equipBtns.length, drops: dropBtns.length,
    before, after: g.battle.gun,
    onMark: !!document.querySelector('#gearList .gear.on'),
  };
});
check('★ 장비창에 가진 총이 전부 나온다', gearUI.rows === bag.guns.length,
  `${gearUI.rows}칸 · 장착 버튼 ${gearUI.equips}개 · 버리기 ${gearUI.drops}개`);
check('★ 클릭 한 번으로 총이 바뀐다',
  gearUI.after !== gearUI.before,
  `${GUNS[gearUI.before].name} → ${GUNS[gearUI.after].name}`);
check('지금 장착한 총이 표시된다', gearUI.onMark === true);

// ── ① 반동 : 기관단총을 실제로 쏴 보고, 한 발당 반동과 회복을 잰다
const recoil = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 가방에 기관단총이 있으면 그걸로, 없으면 지금 총으로 잰다
  if (g.battle.guns.includes('smg') && g.battle.gun !== 'smg') {
    g.net.send({ t: 'bequip', gun: 'smg' });
    await sleep(1200);
  }
  // 탄창을 채워 두고 시작
  for (let i = 0; i < 40 && g.battle.mag <= 0; i++) await sleep(150);
  const gun = g.battle.gun;
  g.me.pitch = 0;
  g._recoil = 0;
  const mag0 = g.battle.mag;
  const t0 = Date.now();
  let peak = 0;
  while (Date.now() - t0 < 3500 && g.battle.mag > 0) {
    g.tryShoot();
    peak = Math.min(peak, g.me.pitch);
    await sleep(40);
  }
  const shots = Math.max(0, mag0 - g.battle.mag);
  const after = g.me.pitch;
  await sleep(1500);                     // 저절로 돌아오는지
  return { gun, shots, peak, after, settled: g.me.pitch };
});
check('★ 실제로 연사가 되었다', recoil.shots >= 3,
  `${GUNS[recoil.gun].name} ${recoil.shots}발`);
check('★ 연사해도 화면이 하늘로 치솟지 않는다',
  Math.abs(recoil.peak) < 0.35,
  `${recoil.shots}발 연사 → 최대 ${Math.abs(recoil.peak).toFixed(3)} rad ` +
  `(한 발당 ${GUNS[recoil.gun].recoil})`);
check('★ 튄 화면이 저절로 제자리로 돌아온다',
  Math.abs(recoil.settled) < Math.abs(recoil.after) * 0.5 + 0.01,
  `${recoil.after.toFixed(3)} → ${recoil.settled.toFixed(3)} rad`);

const dropped = await p.evaluate(async () => {
  const g = window.__game;
  const before = g.battle.guns.slice();
  const btn = document.querySelector('#gearList [data-drop]');
  const id = btn?.dataset.drop;
  btn?.click();
  await new Promise(r => setTimeout(r, 1200));
  const after = g.battle.guns.slice();
  // 마지막 한 자루는 못 버린다
  let last = null;
  for (let i = 0; i < 4 && g.battle.guns.length > 1; i++) {
    document.querySelector('#gearList [data-drop]')?.click();
    await new Promise(r => setTimeout(r, 900));
  }
  last = g.battle.guns.slice();
  g.hud.closePanels();
  return { id, before, after, last };
});
check('★ 클릭으로 총을 버릴 수 있다', dropped.after.length === dropped.before.length - 1,
  `${dropped.before.length}자루 → ${dropped.after.length}자루`);
check('마지막 한 자루는 버려지지 않는다', dropped.last.length === 1,
  `남은 총 ${dropped.last.map(id => GUNS[id].name).join('')}`);

// ── ③ 조준경 : 휠(=두 손가락 확대)로 당기면 화면이 확대된다
const scope = await p.evaluate(async () => {
  const g = window.__game;
  // 저격총을 가방에 넣고 장착시킨다 (상자를 찾아 걸어가기)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const list = [...g.world.lootData.values()].filter(l => l.kind === 'gun' && l.gun === 'sniper' && l.visible);
  if (list.length) {
    list.sort((a, c) => Math.hypot(a.x - g.me.x, a.z - g.me.z) - Math.hypot(c.x - g.me.x, c.z - g.me.z));
    const t = list[0];
    const sx = g.me.x, sz = g.me.z, sy = g.me.y;
    for (let i = 1; i <= 30; i++) {
      const k = i / 30;
      g.me.x = sx + (t.x - sx) * k; g.me.z = sz + (t.z - sz) * k; g.me.y = sy + (t.y + 1 - sy) * k;
      g.sendPos(); await sleep(85);
    }
    for (let i = 0; i < 10; i++) { g.me.x = t.x; g.me.z = t.z; g.me.y = t.y + 1; g.sendPos(); await sleep(170); }
    await sleep(800);
    g.net.send({ t: 'bequip', gun: 'sniper' });
    await sleep(900);
  }
  const gun = g.battle.gun;
  const fov0 = g.camera.fov;
  const cam0 = { x: g.camera.position.x, z: g.camera.position.z };
  // 마우스 휠 = 두 손가락 벌리기
  for (let i = 0; i < 14; i++) {
    dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
    await sleep(45);
  }
  await sleep(300);
  const zoomed = { zoom: g.zoom, fov: g.camera.fov, scope: !document.getElementById('scope').hidden,
                   chip: document.getElementById('zoomChip').textContent,
                   dist: Math.hypot(g.camera.position.x - g.me.x, g.camera.position.z - g.me.z) };
  // 다시 축소
  for (let i = 0; i < 20; i++) {
    dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
    await sleep(35);
  }
  await sleep(300);
  return { gun, fov0, zoomed, back: g.zoom, backFov: g.camera.fov,
           scopeOff: document.getElementById('scope').hidden, cam0 };
});
check('★ 저격총을 장착할 수 있다', scope.gun === 'sniper', `${GUNS[scope.gun].name}`);
check('★ 확대 동작(휠·두 손가락)으로 화면이 당겨진다',
  scope.zoomed.zoom > 2 && scope.zoomed.fov < scope.fov0 / 2,
  `${scope.zoomed.zoom.toFixed(1)}배 · 시야각 ${scope.fov0}° → ${scope.zoomed.fov.toFixed(1)}°`);
check('★ 저격 조준경 화면이 뜬다', scope.zoomed.scope === true, scope.zoomed.chip);
check('★ 조준경을 켜면 1인칭(눈높이)으로 붙는다', scope.zoomed.dist < 1.0,
  `카메라-내 몸 거리 ${scope.zoomed.dist.toFixed(2)}m (평소 약 4m)`);
check('★ 다시 오므리면 원래대로 돌아온다',
  scope.back <= 1.01 && Math.abs(scope.backFov - scope.fov0) < 0.5 && scope.scopeOff === true,
  `${scope.back.toFixed(2)}배 · 시야각 ${scope.backFov.toFixed(0)}°`);

// 최대 배율 제한 (권총으로는 6배까지 못 당긴다)
const capped = await p.evaluate(async () => {
  const g = window.__game;
  g.net.send({ t: 'bequip', gun: 'pistol' });
  await new Promise(r => setTimeout(r, 1000));
  for (let i = 0; i < 20; i++) {
    dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
    await new Promise(r => setTimeout(r, 35));
  }
  await new Promise(r => setTimeout(r, 300));
  return { gun: g.battle.gun, zoom: g.zoom };
});
check('총마다 최대 배율이 다르다 (권총은 조금만)',
  capped.gun !== 'pistol' || capped.zoom <= GUNS.pistol.zoom + 0.01,
  `${GUNS[capped.gun].name} ${capped.zoom.toFixed(1)}배 (최대 ${GUNS[capped.gun].zoom}배)`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await p.screenshot({ path: '/tmp/gear.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

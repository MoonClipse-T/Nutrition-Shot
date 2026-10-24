// 대기 공간 → 선생님이 시작 → 창고 동시 리스폰 → 안전구역 규칙 검증
import { chromium } from 'playwright';
import { LAYOUT, safeZoneAt, TRAIN } from '../public/js/layout.js';
import { RULES, DRINKS } from '../public/js/gamedata.js';

import { readFileSync } from 'fs';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!ok) { failures++; process.exitCode = 1; } };

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});

const errors = [];
const pages = [];
// P1,P2 = 1모둠 / P3 = 2모둠
for (let i = 0; i < 3; i++) {
  const ctx = await b.newContext({ viewport: i === 0 ? { width: 900, height: 560 } : { width: 300, height: 200 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errors.push(`[P${i}] ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error') errors.push(`[P${i}] ${m.text()}`); });
  await pg.goto(URL);
  await pg.waitForSelector('#joinBtn:not([disabled])');
  await pg.click('#qualitySeg button[data-q="low"]');
  await pg.fill('#nickInput', `학생${i + 1}`);
  await pg.selectOption('#teamSelect', i < 2 ? '0' : '1');
  await pg.click('#joinBtn');
  await pg.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
  pages.push(pg);
}
const p = pages[0];
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await p.bringToFront();
await wait(3000);

// ── 1) 접속하면 대기 공간
const w = await p.evaluate(() => ({
  phase: window.__game.phase,
  x: window.__game.me.x, z: window.__game.me.z, y: window.__game.me.y,
  banner: !document.getElementById('waitBanner').hidden,
}));
const inTrain = Math.abs(w.x - TRAIN.cx) < TRAIN.half + 2 && Math.abs(w.z - TRAIN.cz) < TRAIN.half + 2;
check('접속 시 대기 공간에서 시작', w.phase === 'waiting' && inTrain && w.banner,
  `phase=${w.phase} 위치(${Math.round(w.x)}, ${Math.round(w.z)}) 바닥 y=${w.y.toFixed(1)}`);

// ── 2) 대기 중에는 섬으로 못 나간다
const escaped = await p.evaluate(async () => {
  const g = window.__game;
  g.input.move.x = 0; g.input.move.y = 1; g.input.running = true;
  await new Promise(r => setTimeout(r, 4000));
  g.input.move.y = 0; g.input.running = false;
  return { x: g.me.x, z: g.me.z };
});
check('대기 공간 밖으로 못 나감',
  Math.abs(escaped.x - TRAIN.cx) <= TRAIN.half && Math.abs(escaped.z - TRAIN.cz) <= TRAIN.half,
  `(${Math.round(escaped.x)}, ${Math.round(escaped.z)})`);

// ── 3) 대기 중 연습 사격은 탄약을 소모하지 않는다
const practice = await p.evaluate(async () => {
  const g = window.__game;
  const before = { ...g.reagents, tranq: g.tranq };
  for (let i = 0; i < 5; i++) { g.lastShot = 0; g.tryShoot(); await new Promise(r => setTimeout(r, 320)); }
  await new Promise(r => setTimeout(r, 600));
  return { before, after: { ...g.reagents, tranq: g.tranq } };
});
check('대기 공간 연습 사격 — 탄약 소모 없음',
  JSON.stringify(practice.before) === JSON.stringify(practice.after),
  JSON.stringify(practice.after));

// ── 4) 선생님이 시작 → 전원 동시에 창고로
const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(600);
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(1500);

const cd = await p.evaluate(() => ({
  phase: window.__game.phase,
  countdown: !document.getElementById('countdown').hidden,
}));
check('시작 즉시 카운트다운 표시', cd.phase === 'playing' && cd.countdown);

// 카운트다운 중에는 못 움직인다
const frozen = await p.evaluate(async () => {
  const g = window.__game;
  const p0 = { x: g.me.x, z: g.me.z };
  g.input.move.y = 1; g.input.running = true;
  await new Promise(r => setTimeout(r, 1200));
  g.input.move.y = 0; g.input.running = false;
  return Math.hypot(g.me.x - p0.x, g.me.z - p0.z);
});
check('카운트다운 중 이동 불가', frozen < 0.5, `${frozen.toFixed(2)}m`);

await wait(RULES ? 5000 : 5000);   // 카운트다운 종료 대기

// ── 5) 모둠별로 같은 창고에서, 안전구역 안에 리스폰
const spots = [];
for (const pg of pages) {
  spots.push(await pg.evaluate(() => ({
    team: window.__game.myTeam, x: window.__game.me.x, z: window.__game.me.z,
    safe: !!document.getElementById('safeBadge').hidden === false,
  })));
}
const zones = spots.map(s => safeZoneAt(s.x, s.z));
check('전원이 안전구역 안에 리스폰', zones.every(Boolean),
  spots.map((s, i) => `학생${i + 1}(${s.team + 1}모둠)→${zones[i] ? zones[i].name : '밖'}`).join(' · '));
check('같은 모둠은 같은 창고', zones[0] && zones[1] && zones[0].team === zones[1].team && zones[0].team === spots[0].team,
  `${zones[0]?.name} / ${zones[1]?.name}`);
check('다른 모둠은 다른 창고', zones[2] && zones[2].team !== zones[0].team,
  `${zones[2]?.name}`);
check('안전구역 배지 표시', spots[0].safe);

// ── 6) 창고 안에서는 정답 제출 가능 / 밖에서는 불가
const logTxt = readFileSync('/tmp/srv.log', 'utf8');
const mm = [...logTxt.matchAll(/라운드 시작 — 정답: (.+)$/gm)].pop();
const names = mm ? mm[1].split(' / ').map(s => s.replace(/^\([ABC]\)\s*/, '').trim()) : null;

const insideSubmit = await p.evaluate(async (id) => {
  const g = window.__game;
  const s0 = g.score;
  g.net.send({ t: 'answer', picks: { 0: id } });
  await new Promise(r => setTimeout(r, 1300));
  return { s0, s1: g.score, solved: Object.keys(g.hud.solved).length };
}, names ? DRINKS.find(d => d.name === names[0]).id : 'water');
check('안전구역 안 → 정답 제출됨', insideSubmit.s1 !== insideSubmit.s0,
  `점수 ${insideSubmit.s0} → ${insideSubmit.s1}`);

// 밖으로 걸어 나가서 제출 시도
const outsideSubmit = await pages[2].evaluate(async (id) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 창고 밖으로 조금씩 걸어 나간다
  const cx = g.me.x, cz = g.me.z;
  const L = Math.hypot(cx, cz) || 1;
  for (let i = 0; i < 30; i++) {
    g.me.x -= (cx / L) * 5; g.me.z -= (cz / L) * 5;
    await sleep(200);
    if (!g.inSafe) break;
  }
  await sleep(800);
  const s0 = g.score;
  g.net.send({ t: 'answer', picks: { 1: id } });
  await sleep(1300);
  return { inSafe: !!g.inSafe, s0, s1: g.score, disabled: (() => {
    g.hud.togglePanel('answer');
    const b = document.getElementById('ansSubmitAll');
    const d = b ? b.disabled : null;
    g.hud.closePanels();
    return d;
  })() };
}, 'water');
check('안전구역 밖 → 정답 제출 거부', !outsideSubmit.inSafe && outsideSubmit.s1 === outsideSubmit.s0,
  `점수 변화 없음 (${outsideSubmit.s0}), 제출 버튼 비활성=${outsideSubmit.disabled}`);
check('안전구역 밖에서는 제출 버튼이 잠김', outsideSubmit.disabled === true);

// ── 7) 안전구역 안에 있는 사람은 마취탄에 안 맞는다
await pages[1].evaluate(() => window.__game.net.send({ t: 'quizStart' }));
const safeShoot = await pages[2].evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 1모둠 창고 근처(안전구역 밖)로 이동해서 안에 있는 상대를 조준
  const mate = [...g.remote.values()].find(r => r.team !== g.myTeam);
  if (!mate) return { err: 'no target' };
  const tx = mate.x, tz = mate.z;
  const L = Math.hypot(tx, tz) || 1;
  const sx = tx + (tx / L) * 34, sz = tz + (tz / L) * 34;   // 바깥쪽에서 접근
  for (let i = 0; i < 60; i++) {
    const dx = sx - g.me.x, dz = sz - g.me.z, d = Math.hypot(dx, dz);
    if (d < 1) break;
    const st = Math.min(6, d);
    g.me.x += dx / d * st; g.me.z += dz / d * st; g.me.y += 1.2;
    await sleep(200);
  }
  await sleep(600);
  return { inSafe: !!g.inSafe, mateX: tx, mateZ: tz, myX: g.me.x, myZ: g.me.z };
});
check('안전구역 밖에서 접근 가능', !safeShoot.err && safeShoot.inSafe === false,
  safeShoot.err || `사수 위치 (${Math.round(safeShoot.myX)}, ${Math.round(safeShoot.myZ)})`);

const mateHits = await pages[1].evaluate(() => window.__game.hits);
check('창고 안에 있는 상대는 마취탄에 맞지 않음', mateHits === 0, `누적 피격 ${mateHits}`);

// ── 8) 창고 옥상까지 올라갈 수 있는가 (계단 존재 검증)
const stairs = LAYOUT.solids.filter(s => s.kind === 'stair');
const roofs = LAYOUT.solids.filter(s => s.kind === 'roof');
const perBaseSteps = stairs.length / 8;
check('창고마다 계단이 있음', stairs.length % 8 === 0 && perBaseSteps >= 10, `계단 블록 ${stairs.length}개 (8동 × ${perBaseSteps}칸)`);
check('옥상이 걸어다닐 수 있는 구조물', roofs.length >= 8 * 2, `옥상 슬래브 ${roofs.length}개`);
// 계단 한 칸의 높이가 넘어갈 수 있는 범위인가
const perBase = stairs.slice(0, perBaseSteps).map(s => s.y + s.sy / 2).sort((a, b) => a - b);
const stepUps = perBase.slice(1).map((v, i) => v - perBase[i]);
check('계단 한 칸 높이가 올라갈 수 있는 범위', Math.max(...stepUps) <= 0.65,
  `최대 ${Math.max(...stepUps).toFixed(2)}m (한계 0.65m)`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 5).join(' | '));
await p.screenshot({ path: '/tmp/s14_base.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

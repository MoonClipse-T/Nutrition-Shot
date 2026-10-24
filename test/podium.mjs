// ★ 순위 = '음료 3개를 먼저 다 맞힌 순서' / 3등이 나오면 자동 종료
//   확정된 모둠도 계속 놀 수 있고 마취탄에 맞는다 / 마취 30초
import { chromium } from 'playwright';
import { RULES, DRINKS } from '../public/js/gamedata.js';
import { readFileSync } from 'fs';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!ok) { failures++; process.exitCode = 1; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

check('마취 시간이 30초', RULES.TRANQ_DOWN_SECONDS === 30, `${RULES.TRANQ_DOWN_SECONDS}초`);
check('3등까지 나오면 종료하도록 설정', RULES.PODIUM_SIZE === 3, `PODIUM_SIZE=${RULES.PODIUM_SIZE}`);

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});
const errors = [];
const pages = [];
// 4모둠 (0,1,2,3) — 3모둠이 완주하면 끝나야 한다
for (let i = 0; i < 4; i++) {
  const ctx = await b.newContext({ viewport: i === 0 ? { width: 880, height: 540 } : { width: 320, height: 220 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errors.push(`[P${i + 1}] ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error') errors.push(`[P${i + 1}] ${m.text()}`); });
  await pg.goto(URL);
  await pg.waitForSelector('#joinBtn:not([disabled])');
  await pg.click('#qualitySeg button[data-q="low"]');
  await pg.fill('#nickInput', `${i + 1}모둠원`);
  await pg.selectOption('#teamSelect', String(i));
  await pg.click('#joinBtn');
  await pg.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
  pages.push(pg);
}
await pages[0].bringToFront();
await wait(2500);

const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(500);
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);

// 이번 라운드 정답을 로그에서 읽는다
const logTxt = readFileSync('/tmp/srv.log', 'utf8');
const mm = [...logTxt.matchAll(/라운드 시작 — 정답: (.+)$/gm)].pop();
const names = mm ? mm[1].split(' / ').map(s => s.replace(/^\([ABC]\)\s*/, '').trim()) : null;
check('라운드 정답을 읽음', !!names, names ? names.join(' / ') : '실패');
const ids = names.map(n => DRINKS.find(d => d.name === n).id);

// 정답 제출은 안전구역(창고) 안에서만 — 리스폰 위치가 곧 창고 안이므로 그대로 낸다
const submitAll = async (pg) => pg.evaluate(async (picks) => {
  const g = window.__game;
  g.net.send({ t: 'answer', picks: { 0: picks[0], 1: picks[1], 2: picks[2] } });
  await new Promise(r => setTimeout(r, 1500));
  return { solved: Object.keys(g.hud.solved).length, safe: !!g.inSafe };
}, ids);

// ── 1모둠 완주
const r1 = await submitAll(pages[0]);
check('1모둠이 안전구역에서 3개 다 맞힘', r1.solved === 3 && r1.safe, JSON.stringify(r1));
await wait(1200);

const fin1 = await pages[1].evaluate(() => ({
  finished: window.__game.finished,
  banner: document.getElementById('finishBanner').textContent.replace(/\s+/g, ' ').trim(),
}));
check('★ 1등 확정이 전원에게 발표됨', !!(fin1.finished && fin1.finished[0]) && /1등 확정/.test(fin1.banner),
  `"${fin1.banner.slice(0, 80)}"`);
check('발표에 모자 색이 들어감', /모자/.test(fin1.banner), fin1.banner.slice(0, 60));

// 아직 라운드는 안 끝났어야 한다
const midPhase = await pages[1].evaluate(() => window.__game.phase);
check('1등만 나왔을 땐 라운드가 계속됨', midPhase === 'playing', `phase=${midPhase}`);

// ── ★ 이미 1등한 모둠도 마취탄에 맞는가
//    쏘는 쪽은 4모둠(끝까지 완주 안 함), 맞는 쪽은 이미 1등을 확정한 1모둠
tws.send(JSON.stringify({ t: 'passQuizAll' }));
await wait(700);
tws.send(JSON.stringify({ t: 'supply', kind: 'tranq', amount: 20 }));
await wait(1000);

// 1등 모둠원을 창고 밖으로 끌어낸다 (안전구역 안에서는 원래 안 맞는 게 맞다)
await pages[0].evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    if (!g.inSafe) break;
    const L = Math.hypot(g.me.x, g.me.z) || 1;
    g.me.x -= (g.me.x / L) * 5; g.me.z -= (g.me.z / L) * 5;
    await sleep(200);
  }
  await sleep(900);
});
const leadPos = await pages[0].evaluate(() => {
  // 마취는 30초라 확인이 늦으면 이미 풀린다 → 계속 지켜보면서 기록해 둔다
  window.__downLog = { was: false, sec: 0 };
  clearInterval(window.__downIv);
  window.__downIv = setInterval(() => {
    const g = window.__game;
    if (g.down) {
      window.__downLog.was = true;
      window.__downLog.sec = Math.max(window.__downLog.sec,
        Math.ceil((g.downUntil - Date.now()) / 1000));
    }
  }, 150);
  return { x: window.__game.me.x, z: window.__game.me.z, safe: !!window.__game.inSafe };
});
check('1등 모둠원이 창고 밖으로 나옴', leadPos.safe === false,
  `(${leadPos.x.toFixed(0)}, ${leadPos.z.toFixed(0)})`);

// 4모둠이 1등 모둠원 쪽으로 접근 — 창고가 사이에 끼지 않도록 '섬 안쪽'에서 다가간다
const shot = await pages[3].evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 120; i++) {
    const foe = [...g.remote.values()].find(r => r.team === 0);
    if (!foe) { await sleep(300); continue; }
    const L = Math.hypot(foe.x, foe.z) || 1;
    const tx = foe.x - (foe.x / L) * 16, tz = foe.z - (foe.z / L) * 16;  // 섬 중심 쪽 16m
    const dx = tx - g.me.x, dz = tz - g.me.z, d = Math.hypot(dx, dz);
    if (d < 2) break;
    const st = Math.min(7, d);
    g.me.x += dx / d * st; g.me.z += dz / d * st; g.me.y += 1.2;
    await sleep(190);
  }
  await sleep(900);
  return { inSafe: !!g.inSafe, x: g.me.x, z: g.me.z };
});
check('4모둠이 사격 위치까지 접근 (안전구역 밖)', shot.inSafe === false,
  `(${shot.x.toFixed(0)}, ${shot.z.toFixed(0)})`);

const hit = await pages[3].evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const before = g.score;
  g.selectAmmo(0);
  for (let k = 0; k < 10; k++) {
    const foe = [...g.remote.values()].find(r => r.team === 0);
    if (!foe) break;
    for (let i = 0; i < 12; i++) {
      const e = g.camera.matrixWorld.elements;
      const fx = -e[8], fy = -e[9], fz = -e[10];
      const cp = g.camera.position;
      let dx = foe.x - cp.x, dy = (foe.y + 1.1) - cp.y, dz = foe.z - cp.z;
      const d = Math.hypot(dx, dy, dz); dx /= d; dy /= d; dz /= d;
      let dyaw = Math.atan2(dx, dz) - Math.atan2(fx, fz);
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      g.me.yaw += dyaw;
      g.me.pitch += Math.asin(Math.max(-1, Math.min(1, dy))) - Math.asin(Math.max(-1, Math.min(1, fy)));
      await sleep(150);
    }
    g.lastShot = 0; g.tryShoot();
    await sleep(420);
  }
  await sleep(1400);
  return { before, after: g.score, delta: g.score - before, locked: g.lockUntil > Date.now() };
});
const downed = await pages[0].evaluate(() => {
  clearInterval(window.__downIv);
  return window.__downLog;
});
check('★ 이미 1등한 모둠도 마취탄에 맞는다', downed.was === true,
  `마취된 적 있음=${downed.was} · 사격자 총압수=${hit.locked}`);
check('★ 1등 모둠원은 현상금 대상', hit.delta >= RULES.SCORE_TRANQ_LEADER,
  `점수 +${hit.delta} (보통 마취 +${RULES.SCORE_TRANQ})`);
check('★ 마취 시간이 30초', downed.sec > 0 && downed.sec <= RULES.TRANQ_DOWN_SECONDS,
  `최대 ${downed.sec}초 (설정 ${RULES.TRANQ_DOWN_SECONDS}초)`);

// ── 2모둠, 3모둠 완주 → 3등이 나오는 순간 자동 종료
await submitAll(pages[1]);
await wait(1500);
const after2 = await pages[3].evaluate(() => window.__game.phase);
check('2등까지 나와도 라운드는 계속됨', after2 === 'playing', `phase=${after2}`);

await submitAll(pages[2]);
await wait(2500);

const ended = await pages[3].evaluate(() => ({
  phase: window.__game.phase,
  reveal: !document.getElementById('revealOverlay').hidden,
  rank: document.getElementById('revealRank').textContent.replace(/\s+/g, ' ').trim(),
}));
check('★ 3등이 나오면 라운드가 자동 종료된다', ended.phase === 'over' && ended.reveal,
  `phase=${ended.phase} 결과창=${ended.reveal}`);
check('★ 순위가 완주 순서(🥇🥈🥉)로 정산된다',
  /🥇/.test(ended.rank) && /🥈/.test(ended.rank) && /🥉/.test(ended.rank),
  ended.rank.slice(0, 130));

// 완주 순서대로인지 (1모둠 → 2모둠 → 3모둠)
const order = ['1모둠', '2모둠', '3모둠'].map(n => ended.rank.indexOf(n));
check('1모둠 → 2모둠 → 3모둠 순서로 표시', order[0] < order[1] && order[1] < order[2],
  `위치 ${order.join(' < ')}`);
check('완주 못 한 모둠은 그 뒤에', ended.rank.indexOf('4모둠') > order[2],
  `4모둠 위치 ${ended.rank.indexOf('4모둠')}`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await pages[0].screenshot({ path: '/tmp/podium.png' });
await pages[1].screenshot({ path: '/tmp/podium_small.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

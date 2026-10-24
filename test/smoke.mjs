// 헤드리스 브라우저로 실제 접속해서 멀티플레이·게임 규칙이 동작하는지 확인
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { readFileSync } from 'fs';
import { DRINKS, RULES } from '../public/js/gamedata.js';
import { LAYOUT } from '../public/js/layout.js';

const URL = process.env.URL || 'http://localhost:3000';
const N = 3;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--ignore-gpu-blocklist',
         '--disable-background-timer-throttling',
         '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});

const pages = [];
const errors = [];
let failures = 0;

function check(name, ok, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

for (let i = 0; i < N; i++) {
  // CPU 2코어 + 소프트웨어 렌더링이라 관전용 클라이언트는 창을 작게
  const ctx = await browser.newContext({
    viewport: i === 0 ? { width: 900, height: 560 } : { width: 300, height: 200 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => { errors.push(`[P${i}] ${e.message}`); if (process.env.DEBUG) console.log(`[P${i}] pageerror:`, e.message); });
  page.on('console', m => {
    if (m.type() === 'error') { errors.push(`[P${i}] ${m.text()}`); if (process.env.DEBUG) console.log(`[P${i}] console:`, m.text()); }
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#joinBtn:not([disabled])', { timeout: 10000 });
  await page.click('#qualitySeg button[data-q="low"]');
  await page.fill('#nickInput', `테스트${i + 1}`);
  await page.selectOption('#teamSelect', i < 2 ? '0' : '1');   // 0,1번 같은 모둠 / 2번 다른 모둠
  await page.click('#joinBtn');
  await page.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
  pages.push(page);
  console.log(`✓ P${i + 1} 접속 완료`);
}

const p = pages[0];
const wait = (ms) => new Promise(r => setTimeout(r, ms));
await p.bringToFront();
await wait(2500);

const fps = await p.evaluate(async () => {
  let f = 0; const t0 = performance.now();
  const tick = () => { f++; if (performance.now() - t0 < 1500) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await new Promise(r => setTimeout(r, 1700));
  return f / 1.5;
});
console.log(`   (테스트 환경 프레임: ${fps.toFixed(1)} fps — 소프트웨어 렌더링이라 낮습니다)`);

// 서버가 "걸어서 이동"만 인정하므로 순간이동 대신 조금씩 옮기는 헬퍼
const HELPERS = `
  window.__glide = async (tx, tz) => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 400; i++) {
      const dx = tx - g.me.x, dz = tz - g.me.z, d = Math.hypot(dx, dz);
      if (d < 0.8) break;
      const s = Math.min(8, d);
      g.me.x += dx / d * s; g.me.z += dz / d * s; g.me.y += 1.2;
      await sleep(200);
    }
    await sleep(400);
  };
  // 총알은 카메라에서 나가므로(3인칭) 카메라 앞방향이 목표를 향하도록 반복 보정
  window.__aim = async (getTarget) => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 4; i++) {
      const T = getTarget();
      if (!T) return false;
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
      await sleep(220);
    }
    return true;
  };`;
for (const pg of pages) await pg.addScriptTag({ content: HELPERS });

// ★ 정답은 안전구역(모둠 창고) 안에서만 제출할 수 있다 — 제출 직전에 들어가는 헬퍼
const gotoSafe = async (pg) => {
  const team = await pg.evaluate(() => window.__game.myTeam);
  const b = LAYOUT.bases[team];
  await pg.evaluate(async (b) => { await window.__glide(b.x, b.z); }, { x: b.x, z: b.z });
  await wait(900);
  return pg.evaluate(() => !!window.__game.inSafe);
};

// 자격시험 통과 헬퍼 — 학생이 정답을 알고 푸는 상황을 흉내낸다
const QUIZ_HELPER = `
  window.__RG = ${JSON.stringify(
    Object.fromEntries(Object.entries((await import('../public/js/gamedata.js')).REAGENTS)
      .map(([k, v]) => [v.shortName, { nut: v.reactTo, color: v.posText }])))};
  window.__NUT = { starch: '녹말', sugar: '당류', protein: '단백질', fat: '지방' };
  // 문제 목록을 받아 '정답'을 계산한다 (학습지를 외운 학생을 흉내낸다)
  window.__quizCorrect = (qs) => qs.map(q => {
    const name = Object.keys(window.__RG).find(n => q.q.includes(n));
    const r = window.__RG[name];
    return q.q.includes('무슨 색') ? r.color : window.__NUT[r.nut];
  });
  window.__passQuiz = async () => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 오답을 낸 직후에는 재응시 대기(QUIZ_RETRY_SECONDS)가 걸린다 — 충분히 기다린다
    for (let attempt = 0; attempt < 15; attempt++) {
      if (g.quizPassed) return true;
      g.hud.quizQ = null;
      g.net.send({ t: 'quizStart' });
      await sleep(900);
      const qs = g.hud.quizQ;
      if (!qs) { await sleep(3000); continue; }      // 대기 중이면 잠시 후 재시도
      g.net.send({ t: 'quizSubmit', answers: window.__quizCorrect(qs) });
      await sleep(1200);
      if (g.quizPassed) return true;
    }
    return g.quizPassed;
  };`;
for (const pg of pages) await pg.addScriptTag({ content: QUIZ_HELPER });

// ─────────────────────────────────────────────────────────
// (교사 소켓 — 게임 시작 및 아래 보급/압수해제에 쓴다)
const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(600);

// ★ 학생은 접속하면 '대기 공간'에 있다 — 선생님이 시작해야 섬으로 나간다
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);                       // 5초 카운트다운 + 여유
const phaseNow = await p.evaluate(() => window.__game.phase);
check('선생님이 시작하면 게임 단계로 전환', phaseNow === 'playing', `phase=${phaseNow}`);

// ─────────────────────────────────────────────────────────
// 0) ★ 마취총은 자격시험 전에는 잠겨 있어야 한다
const lockedAtStart = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  g.selectAmmo(0);
  g.me.pitch = -0.9;
  const before = g.tranq;
  for (let i = 0; i < 3; i++) { g.lastShot = 0; g.tryShoot(); await sleep(320); }
  await sleep(500);
  return { passed: g.quizPassed, tranq: g.tranq, before };
});
check('시작 시 마취총 잠김 (탄약 0, 발사 불가)',
  lockedAtStart.passed === false && lockedAtStart.tranq === 0,
  `quizPassed=${lockedAtStart.passed} 마취탄=${lockedAtStart.tranq}`);

// 0-b) 오답을 내면 통과하지 못한다
const wrongQuiz = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  g.net.send({ t: 'quizStart' });
  await sleep(900);
  const qs = g.hud.quizQ;
  if (!qs) return { err: 'no quiz' };
  // 일부러 '확실히 틀린' 답을 만든다 (정답을 알고 그것만 피한다 — 찍어서 우연히 맞는 일 방지)
  const correct = window.__quizCorrect(qs);
  const answers = qs.map((q, i) =>
    i === 0 ? (q.choices.find(c => c !== correct[0]) ?? q.choices[0]) : correct[i]);
  g.net.send({ t: 'quizSubmit', answers });
  await sleep(1000);
  return { passed: g.quizPassed, tranq: g.tranq };
});
check('자격시험 오답 → 해금 안 됨', wrongQuiz.passed === false && wrongQuiz.tranq === 0,
  `quizPassed=${wrongQuiz.passed}`);

// 0-c) 정답을 내면 통과하고 마취탄이 지급된다
for (const pg of pages) await pg.evaluate(() => window.__passQuiz());
await wait(1500);
const passed = await p.evaluate(() => ({ passed: window.__game.quizPassed, tranq: window.__game.tranq, cap: window.__game.tranqCap }));
check('자격시험 합격 → 마취총 해금 + 탄약 지급',
  passed.passed === true && passed.tranq === RULES.TRANQ_START_AMMO,
  `마취탄 ${passed.tranq}발 · 현재 상한 ${passed.cap}발`);


// ─────────────────────────────────────────────────────────
// 1) 서로가 보이는가
const seen = await p.evaluate(() => ({
  remotes: window.__game.remote.size,
  nicks: [...window.__game.remote.values()].map(r => r.nick),
}));
check('다른 플레이어 인식', seen.remotes === N - 1, `remote=${seen.remotes} ${JSON.stringify(seen.nicks)}`);

// 2) 렌더링
const shotBuf = await p.screenshot({ path: '/tmp/shot1.png' });
const png = PNG.sync.read(shotBuf);
let sum = 0, sum2 = 0, n = 0;
for (let i = 0; i < png.data.length; i += 4) {
  const v = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  sum += v; sum2 += v * v; n++;
}
const mean = sum / n, sd = Math.sqrt(sum2 / n - mean * mean);
const info = await p.evaluate(() => ({
  calls: window.__game.renderer.info.render.calls,
  tris: window.__game.renderer.info.render.triangles,
}));
check('3D 렌더링 동작', mean > 25 && sd > 18 && info.calls > 3,
  `밝기평균=${mean.toFixed(1)} 표준편차=${sd.toFixed(1)} drawCalls=${info.calls} 삼각형=${info.tris}`);

// ─────────────────────────────────────────────────────────
// 3) ★ 이동 방향 — 좌우/앞뒤가 화면과 일치하는가 (반전 버그 재발 방지)
//    카메라의 실제 오른쪽 축(matrixWorld 의 X축)과 실제 이동 방향을 내적으로 비교한다.
async function moveProbe(mx, my, ms = 1600) {
  return p.evaluate(async ({ mx, my, ms }) => {
    const g = window.__game;
    g.input.move.x = 0; g.input.move.y = 0; g.input.running = false;
    await new Promise(r => setTimeout(r, 400));
    const e = g.camera.matrixWorld.elements;
    const camRight = { x: e[0], z: e[2] };            // 카메라 로컬 X = 화면 오른쪽
    const camFwd = { x: -e[8], z: -e[10] };           // 카메라 로컬 -Z = 화면 앞
    const p0 = { x: g.me.x, z: g.me.z };
    g.input.move.x = mx; g.input.move.y = my; g.input.running = true;
    await new Promise(r => setTimeout(r, ms));
    g.input.move.x = 0; g.input.move.y = 0; g.input.running = false;
    const speed = g.me.speed;
    const d = { x: g.me.x - p0.x, z: g.me.z - p0.z };
    const len = Math.hypot(d.x, d.z) || 1e-9;
    const rl = Math.hypot(camRight.x, camRight.z) || 1;
    const fl = Math.hypot(camFwd.x, camFwd.z) || 1;
    return {
      speed,
      dist: Math.hypot(d.x, d.z),
      alongRight: (d.x * camRight.x + d.z * camRight.z) / len / rl,
      alongFwd: (d.x * camFwd.x + d.z * camFwd.z) / len / fl,
    };
  }, { mx, my, ms });
}

// 사방이 트인 광장으로 옮겨서 벽에 막히지 않게 한다
await p.evaluate(() => window.__glide(0, 30));
const right = await moveProbe(1, 0);
const left = await moveProbe(-1, 0);
const fwd = await moveProbe(0, 1);
const back = await moveProbe(0, -1);
check('오른쪽 입력 → 화면 오른쪽으로 이동', right.alongRight > 0.85,
  `카메라 오른쪽과의 일치도 ${right.alongRight.toFixed(2)} (${right.dist.toFixed(1)}m)`);
check('왼쪽 입력 → 화면 왼쪽으로 이동', left.alongRight < -0.85,
  `일치도 ${left.alongRight.toFixed(2)} (${left.dist.toFixed(1)}m)`);
check('앞 입력 → 정면으로 이동', fwd.alongFwd > 0.85, `일치도 ${fwd.alongFwd.toFixed(2)}`);
check('뒤 입력 → 뒤로 이동', back.alongFwd < -0.85, `일치도 ${back.alongFwd.toFixed(2)}`);

// 4) 이동 속도 — 프레임이 낮은 테스트 환경이라 '이동 거리' 대신 순간 속도를 본다
check('달리기 속도 = 설정값', Math.abs(fwd.speed - RULES.RUN_SPEED) < 0.2,
  `${fwd.speed.toFixed(1)} m/s (설정 ${RULES.RUN_SPEED}) · 실제 이동 ${fwd.dist.toFixed(1)}m@${fps.toFixed(0)}fps`);

// 5) 원격 동기화
await wait(600);
const remoteMoved = await pages[1].evaluate(() => {
  const r = [...window.__game.remote.values()].find(r => r.nick === '테스트1');
  return r ? { x: r.x, z: r.z, buf: r.buf.length } : null;
});
check('상대 위치 동기화', !!remoteMoved && remoteMoved.buf > 1,
  remoteMoved ? `x=${remoteMoved.x.toFixed(1)} z=${remoteMoved.z.toFixed(1)} snapshots=${remoteMoved.buf}` : 'not found');

// ─────────────────────────────────────────────────────────
// 6) 시약 4종 수집
const gotAll = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (const w of ['iodine', 'benedict', 'biuret', 'sudan']) {
    if (g.collected[w]) continue;
    let best = null, bd = 1e9;
    for (const m of g.world.pickupMeshes.values()) {
      if (m.data.reagent !== w || !m.visible) continue;
      const d = Math.hypot(m.data.x - g.me.x, m.data.z - g.me.z);
      if (d < bd) { bd = d; best = m; }
    }
    if (!best) continue;
    await window.__glide(best.data.x, best.data.z);
    await sleep(600);
  }
  return { reagents: { ...g.reagents }, collected: { ...g.collected } };
});
check('시약 4종 수집 (걸어가서 자동 획득)', Object.keys(gotAll.collected).length === 4,
  JSON.stringify(gotAll.reagents));

// 7) 비커 검사 — 제1실험장 비커 3개(A/B/C)에 시약 4종씩
const testRes = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const zone1 = g.world.beakers.filter(b => b.zone === 1).sort((a, b) => a.drink - b.drink);
  const tranqLog = [];
  for (const b of zone1) {
    const L = Math.hypot(b.x, b.z) || 1;
    const mid = (b.x === 0 && b.z === 0);
    // ★ 베네딕트는 가열이 필요하므로, 비커로 가기 전에 가장 가까운 불부터 들른다
    const near = g.world.nearestFire(b.x, b.z);
    if (near) { await window.__glide(near.fire.x, near.fire.z); await sleep(500); }
    await window.__glide(mid ? 0 : b.x - (b.x / L) * 15, mid ? 15 : b.z - (b.z / L) * 15);
    await window.__aim(() => ({ x: b.x, y: b.y + 4.2, z: b.z }));
    await sleep(300);
    for (let a = 1; a <= 4; a++) {
      const before = g.tranq;
      g.selectAmmo(a);
      g.lastShot = 0;
      g.tryShoot();
      await sleep(520);
      tranqLog.push({ before, after: g.tranq });
    }
  }
  await sleep(900);
  return { notes: g.hud.notes.map(o => ({ ...o })), tranq: g.tranq, tranqLog };
});
const filled = testRes.notes.map(o => Object.keys(o).length);
check('비커 A·B·C × 시약 4종 검사 기록', filled.every(f => f === 4), `기록된 칸 = ${filled.join(',')}/4`);

// 7-b) 검출 결과가 음료 성분과 맞는가
const logTxt = readFileSync('/tmp/srv.log', 'utf8');
const mm = [...logTxt.matchAll(/라운드 시작 — 정답: (.+)$/gm)].pop();
const answerNames = mm ? mm[1].split(' / ').map(s => s.replace(/^\([ABC]\)\s*/, '').trim()) : null;
if (answerNames) {
  const NUT = { iodine: 'starch', benedict: 'sugar', biuret: 'protein', sudan: 'fat' };
  let ok = true; const bad = [];
  answerNames.forEach((nm, di) => {
    const d = DRINKS.find(x => x.name === nm);
    for (const r of Object.keys(NUT)) {
      const expect = d.has.includes(NUT[r]);
      if (testRes.notes[di][r] !== expect) { ok = false; bad.push(`${'ABC'[di]}/${r}`); }
    }
  });
  check('검출 결과가 음료 성분과 일치', ok,
    `정답 ${answerNames.join(' / ')}${bad.length ? ' | 불일치 ' + bad.join(',') : ''}`);
}
const milk = DRINKS.find(d => d.id === 'milk');
check('우유에 당류 없음 (요청 반영)', !milk.has.includes('sugar'), JSON.stringify(milk.has));

// 7-c) 실험 보상으로 마취탄이 늘어났는가
// 보상은 최대 보유량(TRANQ_MAX_AMMO)에서 멈추므로, 상한에 닿기 전까지 늘었는지를 본다
// 보상은 '진도 상한'에서 멈춘다. 아직 정답을 안 냈으므로 상한은 TRANQ_CAP_BY_SOLVED[0]
const rewarded = testRes.tranqLog.filter(x => x.after > x.before).length;
const cap0 = RULES.TRANQ_CAP_BY_SOLVED[0];
check('비커 검사 → 마취탄 보상 (진도 상한에서 멈춤)',
  testRes.tranq === cap0,
  `12번 중 ${rewarded}번 증가, 현재 ${testRes.tranq}발 = 0개 해결 상한 ${cap0}발`);
check('같은 조합 재검사는 보상 없음', RULES.TRANQ_REWARD_RETEST === 0);

// 7-d) 제2실험장의 같은 글자 비커가 같은 결과를 주는가
const dup = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const b = g.world.beakers.find(x => x.zone === 2);
  const L = Math.hypot(b.x, b.z) || 1;
  const near = g.world.nearestFire(b.x, b.z);        // ★ 베네딕트용 가열
  if (near) { await window.__glide(near.fire.x, near.fire.z); await sleep(500); }
  await window.__glide(b.x - (b.x / L) * 15, b.z - (b.z / L) * 15);
  await window.__aim(() => ({ x: b.x, y: b.y + 4.2, z: b.z }));
  await sleep(300);
  const results = [];
  for (let a = 1; a <= 4; a++) {
    g.selectAmmo(a);
    g.lastShot = 0;
    const ammo = g.currentAmmo();
    g.hud.notes[b.drink][ammo] = 'PENDING';
    g.tryShoot();
    await sleep(520);
    results.push([ammo, g.hud.notes[b.drink][ammo]]);
  }
  return { drink: b.drink, label: b.label, results };
});
const dupOk = dup.results.every(([r, v]) => v === testRes.notes[dup.drink][r]);
check('제2실험장의 같은 글자 비커 = 같은 음료', dupOk,
  `비커 ${dup.label} : ${dup.results.map(([r, v]) => r + '=' + v).join(' ')}`);

// ─────────────────────────────────────────────────────────
// 8) 마취탄이 실제로 줄어드는가 (예전 버그: 4초마다 자동 보급되어 안 줄어듦)
const ammoDrop = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  g.selectAmmo(0);
  g.me.pitch = -0.9;                    // 하늘로 쏴서 아무도 안 맞게
  await sleep(400);
  const before = g.tranq;
  for (let i = 0; i < 4; i++) { g.lastShot = 0; g.tryShoot(); await sleep(450); }
  await sleep(700);
  return { before, after: g.tranq, ui: document.querySelector('#ammoBar .ammo .ct').textContent };
});
check('마취탄 4발 쏘면 4발 줄어든다', ammoDrop.after === ammoDrop.before - 4,
  `${ammoDrop.before} → ${ammoDrop.after} (화면 표시 ${ammoDrop.ui})`);


// 9) 마취탄 3발 → 마취
// 위에서 하늘로 4발 쏜 것이 '실험 없이 남발' 카운터에 잡혀 압수될 수 있으므로,
// 교사 권한으로 압수를 풀고 탄약을 채운 뒤 검증한다 (규칙 자체는 12번에서 따로 검증)
tws.send(JSON.stringify({ t: 'unlockAll' }));
await wait(600);
tws.send(JSON.stringify({ t: 'supply', kind: 'tranq', amount: 12 }));
await wait(1200);

// ★ 안전구역(모둠 창고) 안에서는 마취탄이 통하지 않는다 — 검증 전 전원을 벌판으로 옮긴다
await pages[1].evaluate(() => window.__glide(-16, 42));
await pages[2].evaluate(() => window.__glide(16, 42));
await wait(1500);
const outOfSafe = [];
for (const pg of pages) outOfSafe.push(await pg.evaluate(() => !!window.__game.inSafe));
check('마취 검증 전 전원이 안전구역 밖', outOfSafe.every(v => v === false),
  outOfSafe.map((v, i) => `P${i + 1}=${v ? '안' : '밖'}`).join(' '));

const foePos = await p.evaluate(() => {
  const g = window.__game;
  const foe = [...g.remote.values()].find(r => r.team !== g.myTeam);
  return foe ? { x: foe.x, z: foe.z } : null;
});
const tranq = await p.evaluate(async (fp) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await window.__glide(fp.x, fp.z + 9);
  g.selectAmmo(0);
  await sleep(500);
  for (let k = 0; k < 6; k++) {
    const ok = await window.__aim(() => {
      const r = [...g.remote.values()].find(r => r.team !== g.myTeam);
      return r ? { x: r.x, y: r.y + 1.1, z: r.z } : null;
    });
    if (!ok) break;
    g.lastShot = 0;
    g.tryShoot();
    await sleep(400);
  }
  await sleep(700);
  return { tranqLeft: g.tranq, score: g.score };
}, foePos);
const p3down = await pages[2].evaluate(() => window.__game.down);
check('마취탄 3발 → 60초 마취', p3down === true,
  `사격자 점수=${tranq.score}, 남은 마취탄=${tranq.tranqLeft}`);

// 10) 마취 중 이동 불가
const frozen = await pages[2].evaluate(async () => {
  const g = window.__game;
  const p0 = { x: g.me.x, z: g.me.z };
  g.input.move.x = 0; g.input.move.y = 1; g.input.running = true;
  await new Promise(r => setTimeout(r, 1500));
  g.input.move.y = 0; g.input.running = false;
  return Math.hypot(g.me.x - p0.x, g.me.z - p0.z);
});
check('마취 중 이동 불가', frozen < 0.5, `${frozen.toFixed(2)}m`);

// 11) 아군 오사 방지
const matePos = await p.evaluate(() => {
  const g = window.__game;
  const mate = [...g.remote.values()].find(r => r.team === g.myTeam);
  return mate ? { x: mate.x, z: mate.z } : null;
});
const mateHitsBefore = await pages[1].evaluate(() => window.__game.hits);
await p.evaluate(async (mp) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await window.__glide(mp.x, mp.z + 8);
  g.selectAmmo(0);
  await sleep(500);
  for (let k = 0; k < 4; k++) {
    const ok = await window.__aim(() => {
      const r = [...g.remote.values()].find(r => r.team === g.myTeam);
      return r ? { x: r.x, y: r.y + 1.1, z: r.z } : null;
    });
    if (!ok) break;
    g.lastShot = 0; g.tryShoot();
    await sleep(400);
  }
  await sleep(700);
}, matePos);
const mateState = await pages[1].evaluate(() => ({ down: window.__game.down, hits: window.__game.hits }));
check('같은 모둠에게는 마취탄이 안 통함',
  mateState.down === false && mateState.hits === mateHitsBefore,
  `hits ${mateHitsBefore} → ${mateState.hits}`);

// ─────────────────────────────────────────────────────────
// 12) ★ 실험 안 하고 마취총만 쏘면 총 압수 — P3(비커 검사 0회)로 검증
const abuse = await pages[2].evaluate(async (limit) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 150 && g.down; i++) await sleep(500);   // 마취 풀릴 때까지
  g.selectAmmo(0);
  g.me.pitch = -0.9;
  await sleep(400);
  let shots = 0;
  for (let i = 0; i < limit + 2; i++) {
    g.lastShot = 0;
    g.tryShoot();
    shots++;
    await sleep(330);
    if (g.lockUntil > Date.now()) break;
  }
  await sleep(500);
  return {
    locked: g.lockUntil > Date.now(),
    shown: !document.getElementById('lockOverlay').hidden,
    shots, tranq: g.tranq,
  };
}, RULES.TRANQ_ABUSE_LIMIT);
check('실험 없이 마취탄 남발 → 총 압수', abuse.locked && abuse.shown,
  `${abuse.shots}발째에 압수 (설정 ${RULES.TRANQ_ABUSE_LIMIT}발), 화면 표시=${abuse.shown}`);

// 12-b) 압수 중에는 사격이 막히는가
const blocked = await pages[2].evaluate(async () => {
  const g = window.__game;
  const before = g.tranq;
  for (let i = 0; i < 3; i++) { g.lastShot = 0; g.tryShoot(); await new Promise(r => setTimeout(r, 320)); }
  return { before, after: g.tranq };
});
check('압수 중 사격 차단', blocked.after === blocked.before, `${blocked.before} → ${blocked.after}`);

// ─────────────────────────────────────────────────────────
// 13) 교사 보급 버튼
const before2 = await pages[1].evaluate(() => ({ ...window.__game.reagents, tranq: window.__game.tranq }));
tws.send(JSON.stringify({ t: 'supply', kind: 'reagent', amount: 5 }));
await wait(900);
tws.send(JSON.stringify({ t: 'supply', kind: 'tranq', amount: 10 }));
await wait(1200);
const after2 = await pages[1].evaluate(() => ({ ...window.__game.reagents, tranq: window.__game.tranq }));
check('교사 시약 보급', after2.iodine === before2.iodine + 5 && after2.sudan === before2.sudan + 5,
  `아이오딘 ${before2.iodine}→${after2.iodine}, 수단 ${before2.sudan}→${after2.sudan}`);
check('교사 마취탄 보급', after2.tranq > before2.tranq, `${before2.tranq} → ${after2.tranq}`);

// 13-b) 압수 해제 버튼
tws.send(JSON.stringify({ t: 'unlockAll' }));
await wait(1200);
const unlocked = await pages[2].evaluate(() => ({
  locked: window.__game.lockUntil > Date.now(),
  shown: !document.getElementById('lockOverlay').hidden,
}));
check('교사 압수 해제 버튼', !unlocked.locked && !unlocked.shown);

// 14) 오답 -20 + 쿨다운 (한 번에 제출한 것 중 하나만 틀린 경우)
let ansOk = true, ansDetail = '(정답 로그를 못 읽어 건너뜀)';
if (answerNames) {
  const wrongId = DRINKS.find(d => d.name !== answerNames[0]).id;
  const inSafe14 = await gotoSafe(p);
  check('정답 제출 전 안전구역 진입', inSafe14 === true);
  const r = await p.evaluate(async ({ wrongId }) => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const s0 = g.score;
    g.net.send({ t: 'answer', picks: { 0: wrongId } });
    await sleep(1200);
    const s1 = g.score;
    g.net.send({ t: 'answer', picks: { 0: wrongId } });   // 쿨다운이라 막혀야 함
    await sleep(1000);
    return {
      s0, s1, s2: g.score,
      xmark: [...document.querySelectorAll('#beakerStatus .bs')][0]?.className || '',
    };
  }, { wrongId });
  ansOk = (r.s1 === r.s0 - 20) && (r.s2 === r.s1) && r.xmark.includes('no');
  ansDetail = `오답 ${r.s0}→${r.s1} (-20 기대) · 쿨다운 중 재제출 ${r.s1}→${r.s2} · A 표시 "${r.xmark.split(' ')[1]}"`;
}
check('오답 -20점 + 짧은 쿨다운 + ❌ 표시', ansOk, ansDetail);

// 14-b) 가만히 있는 학생이 시약을 자동으로 계속 줍지 않는가 (스폰 옆 파밍 방지)
const idleFarm = await pages[1].evaluate(async () => {
  const g = window.__game;
  const sum = () => Object.values(g.reagents).reduce((a, b) => a + b, 0);
  const before = sum();
  await new Promise(r => setTimeout(r, 16000));   // 시약 리스폰 주기보다 길게
  return { before, after: sum() };
});
check('가만히 있어도 시약이 저절로 쌓이지 않음', idleFarm.after === idleFarm.before,
  `${idleFarm.before} → ${idleFarm.after}`);

// 16) ★ 점프가 충분히 높은가 + 앉으면 느려지는가
const jump = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  g.input.crouching = false;
  await window.__glide(0, 34);                 // 평평한 광장
  await sleep(600);
  const y0 = g.me.y;
  let peak = y0;
  g.input.jumpQueued = true;
  for (let i = 0; i < 60; i++) {
    await sleep(25);
    peak = Math.max(peak, g.me.y);
    if (i > 8 && g.me.onGround) break;
  }
  return { rise: peak - y0 };
});
check('점프 높이', jump.rise > 1.6,
  `${jump.rise.toFixed(2)}m 상승 (설정 최고 ${(RULES.JUMP_V ** 2 / (2 * RULES.GRAVITY)).toFixed(2)}m, ${fps.toFixed(0)}fps라 샘플링 손실 있음)`);

const crouchProbe = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  g.input.crouching = true;
  g.input.move.x = 0; g.input.move.y = 1; g.input.running = true;
  await sleep(1200);
  const s = g.me.speed;
  const scale = g.avatar.scale.y;
  const bodyY = g.avatar.userData.body.position.y;
  g.input.move.y = 0; g.input.running = false; g.input.crouching = false;
  await sleep(600);
  return { crouchSpeed: s, bodyY, scale, standBodyY: g.avatar.userData.body.position.y };
});
check('앉으면 아주 느려짐',
  Math.abs(crouchProbe.crouchSpeed - RULES.WALK_SPEED * RULES.CROUCH_SPEED_MULT) < 0.2,
  `${crouchProbe.crouchSpeed.toFixed(2)} m/s (달리기 ${RULES.RUN_SPEED} 대비 ${(crouchProbe.crouchSpeed / RULES.RUN_SPEED * 100).toFixed(0)}%)`);
check('앉으면 캐릭터가 눈에 띄게 낮아짐', crouchProbe.bodyY < -0.3,
  `몸통 높이 ${crouchProbe.bodyY.toFixed(2)} → 서면 ${crouchProbe.standBodyY.toFixed(2)}`);

// 17) ★ 시약 상한 — 가득 차면 상자를 소모하지 않고, 통과하는 것처럼 보이지 않아야 한다
const carry = await p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 한 종류를 상한까지 채운다
  const want = 'iodine';
  for (let k = 0; k < 8 && (g.reagents[want] | 0) < 999; k++) {
    let best = null, bd = 1e9;
    for (const m of g.world.pickupMeshes.values()) {
      if (m.data.reagent !== want || !m.visible) continue;
      const d = Math.hypot(m.data.x - g.me.x, m.data.z - g.me.z);
      if (d < bd) { bd = d; best = m; }
    }
    if (!best) break;
    await window.__glide(best.data.x, best.data.z);
    await sleep(500);
  }
  return { have: g.reagents[want] | 0, prompt: document.getElementById('prompt').textContent };
});
check('시약 보유 상한이 지켜짐', carry.have <= RULES.REAGENT_MAX_CARRY,
  `아이오딘 ${carry.have}/${RULES.REAGENT_MAX_CARRY}발`);

// 18) ★ A·B·C 를 한 번에 제출 → 채점 결과가 화면에 뜬다
let batchOk = true, batchDetail = '(정답 로그를 못 읽어 건너뜀)';
if (answerNames) {
  const ids = answerNames.map(nm => DRINKS.find(d => d.name === nm).id);
  const inSafe18 = await gotoSafe(p);
  check('일괄 제출 전 안전구역 진입', inSafe18 === true);
  const r = await p.evaluate(async (ids) => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 오답 대기 중이면 풀릴 때까지 기다린다
    await sleep(1000);
    for (let i = 0; i < 80; i++) {
      g.hud.togglePanel('answer');
      const sub = document.getElementById('ansSubmitAll');
      if (sub && !sub.disabled) break;
      // 아직 못 고른 상태 → 고른다
      for (let bi = 0; bi < 3; bi++) {
        const b = document.querySelector(`.drink[data-bi="${bi}"][data-id="${ids[bi]}"]`);
        if (b) b.click();
      }
      const s2 = document.getElementById('ansSubmitAll');
      if (s2 && !s2.disabled) break;
      g.hud.closePanels();
      await sleep(1000);
    }
    const before = g.score;
    document.getElementById('ansSubmitAll').click();
    await sleep(1500);
    return {
      before, after: g.score,
      overlay: !document.getElementById('resultOverlay').hidden,
      panelClosed: document.getElementById('panelAnswer').hidden,
      rows: document.querySelectorAll('#resultRows .rrow.ok').length,
      status: [...document.querySelectorAll('#beakerStatus .bs')].map(e => e.className),
      solved: { ...g.hud.solved },
    };
  }, ids);
  batchOk = r.overlay && r.panelClosed && r.rows === 3 &&
            Object.keys(r.solved).length === 3 &&
            r.status.every(c => c.includes('ok'));
  batchDetail = `정답 표시 ${r.rows}/3 · 제출지 닫힘=${r.panelClosed} · 결과창=${r.overlay} · 점수 ${r.before}→${r.after} · A/B/C 표시 ${r.status.map(c => c.split(' ')[1]).join(',')}`;
}
check('A·B·C 한 번에 제출 → 제출지 닫히고 O/X 표시', batchOk, batchDetail);

// 19) ★ 후보 좁히기 힌트가 제거되고, 음료 후보 8종이 실험노트에 뜨는가
const noteUI = await p.evaluate(async () => {
  const g = window.__game;
  g.hud.togglePanel('note');
  await new Promise(r => setTimeout(r, 400));
  const html = document.getElementById('panelNote').innerHTML;
  const out = {
    hintBtn: !!document.getElementById('hintToggle'),
    cands: [...document.querySelectorAll('#noteDeduce .cand')].map(e => e.textContent),
    struck: document.querySelectorAll('#noteDeduce .cand.out').length,
  };
  g.hud.closePanels();
  return out;
});
check('후보 좁히기 힌트 삭제됨', !noteUI.hintBtn && noteUI.struck === 0);
check('실험노트에 이번 라운드 후보 표시', noteUI.cands.length === RULES.ROUND_CANDIDATES,
  noteUI.cands.join(' · '));

// 20) ★ 비커 색 반응이 '다른 모둠'에게는 안 보여야 한다
//     P1(1모둠)이 비커를 쏘고, P3(2모둠)이 그 반응을 받지 않는지 본다
const isolation = await (async () => {
  // P3 의 수신 이벤트를 감시
  await pages[2].evaluate(() => {
    const g = window.__game;
    window.__gotReact = 0;
    const prev = g.net.handlers.get('beakerReact');
    g.net.handlers.set('beakerReact', (m) => { window.__gotReact++; if (prev) prev(m); });
  });
  await pages[1].evaluate(() => {
    const g = window.__game;
    window.__gotReact = 0;
    const prev = g.net.handlers.get('beakerReact');
    g.net.handlers.set('beakerReact', (m) => { window.__gotReact++; if (prev) prev(m); });
  });
  // P1 이 비커 A 를 다시 한 번 쏜다
  await p.evaluate(async () => {
    const g = window.__game;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const b = g.world.beakers.find(x => x.zone === 1 && x.drink === 0);
    const L = Math.hypot(b.x, b.z) || 1;
    const mid = (b.x === 0 && b.z === 0);
    await window.__glide(mid ? 0 : b.x - (b.x / L) * 15, mid ? 15 : b.z - (b.z / L) * 15);
    await window.__aim(() => ({ x: b.x, y: b.y + 4.2, z: b.z }));
    await sleep(300);
    g.selectAmmo(1); g.lastShot = 0; g.tryShoot();
    await sleep(1500);
  });
  const mate = await pages[1].evaluate(() => window.__gotReact);   // 같은 모둠
  const foe = await pages[2].evaluate(() => window.__gotReact);    // 다른 모둠
  const label = await p.evaluate(() => {
    const b = window.__game.world.beakers.find(x => x.zone === 1 && x.drink === 0);
    return { shown: b.resultPanel.visible, until: b.resultUntil > performance.now() };
  });
  return { mate, foe, label };
})();
check('색 반응이 같은 모둠에게는 전달됨', isolation.mate >= 1, `수신 ${isolation.mate}회`);
check('★ 다른 모둠에게는 색 반응이 안 감 (혼동 방지)', isolation.foe === 0,
  `다른 모둠 수신 ${isolation.foe}회 (0이어야 함)`);
check('비커 위에 결과 표시판이 뜸', isolation.label.shown && isolation.label.until);

// 21) ★ 교사가 학생 화면을 볼 수 있는가
//     이제 그림은 '바이너리 프레임', 상태값은 frameStat(JSON) 으로 따로 온다
const watch = await (async () => {
  const selfId = await p.evaluate(() => window.__game.selfId);
  let stat = null, bytes = 0, jpeg = null;
  tws.binaryType = 'arraybuffer';
  const onMsg = (e) => {
    if (typeof e.data !== 'string') {
      if (!jpeg) { jpeg = Buffer.from(new Uint8Array(e.data)); bytes = jpeg.length; }
      return;
    }
    const m = JSON.parse(e.data);
    if (m.t === 'frameStat' && !stat) stat = m;
  };
  tws.addEventListener('message', onMsg);
  tws.send(JSON.stringify({ t: 'watch', id: selfId }));
  await wait(4000);
  const badge = await p.evaluate(() => !document.getElementById('watchedBadge').hidden);
  tws.send(JSON.stringify({ t: 'watch', id: null }));
  await wait(1500);
  const stopped = await p.evaluate(() => window.__game.streaming === false);
  tws.removeEventListener('message', onMsg);
  return { stat, jpeg, bytes, badge, stopped };
})();
check('교사 화면에 학생 상태값 전송됨', !!watch.stat,
  watch.stat ? `점수 ${watch.stat.st?.score} · 자격시험 ${watch.stat.st?.quiz} · ${watch.stat.fps}fps` : '없음');
// JPEG 인지, 검은 화면이 아닌지 실제로 확인
const isJpeg = !!watch.jpeg && watch.jpeg[0] === 0xFF && watch.jpeg[1] === 0xD8;
check('학생 화면이 JPEG 바이너리로 전송됨', isJpeg && watch.bytes > 3000,
  `${(watch.bytes / 1024).toFixed(1)}KB/프레임 (base64 아님)`);
check('학생에게 "보는 중" 표시', watch.badge);
check('그만 보면 송출 중단', watch.stopped);

// 15) 콘솔 에러
check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 6).join(' | '));

await p.screenshot({ path: '/tmp/shot_final.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'} · 스크린샷 /tmp/shot1.png`);
tws.close();
await browser.close();

// ★ 선두 모둠 공개 + 마취 현상금 검증
//   "몇 모둠"은 몰라도 모자 색은 보인다 → 색 이름으로 알려 주는가?
import { chromium } from 'playwright';
import { LAYOUT } from '../public/js/layout.js';
import { RULES, TEAM_COLORS, TEAM_COLOR_NAMES } from '../public/js/gamedata.js';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!ok) { failures++; process.exitCode = 1; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

check('모자 색 이름이 모둠 수만큼 준비됨',
  TEAM_COLOR_NAMES.length === TEAM_COLORS.length && TEAM_COLOR_NAMES.every(n => n && n.length <= 3),
  TEAM_COLOR_NAMES.join(' · '));

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});
const errors = [];
const pages = [];
// P1 = 1모둠(빨강, 앞서갈 모둠) / P2 = 2모둠(파랑, 추격자)
for (let i = 0; i < 2; i++) {
  const ctx = await b.newContext({ viewport: i === 0 ? { width: 900, height: 560 } : { width: 420, height: 280 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errors.push(`[P${i + 1}] ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error') errors.push(`[P${i + 1}] ${m.text()}`); });
  await pg.goto(URL);
  await pg.waitForSelector('#joinBtn:not([disabled])');
  await pg.click('#qualitySeg button[data-q="low"]');
  await pg.fill('#nickInput', i === 0 ? '앞선이' : '추격이');
  await pg.selectOption('#teamSelect', String(i));
  await pg.click('#joinBtn');
  await pg.waitForFunction(() => !!window.__game, null, { timeout: 20000 });
  pages.push(pg);
}
const [lead, chase] = pages;
const AIM = `
  window.__aimFoe = async (foe) => {
    const g = window.__game;
    for (let i = 0; i < 16; i++) {
      const r = [...g.remote.values()].find(x => x.team !== g.myTeam);
      if (!r) return false;
      const T = { x: r.x, y: r.y + 1.1, z: r.z };
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
      await new Promise(r2 => setTimeout(r2, 170));
    }
    return true;
  };`;
for (const pg of pages) await pg.addScriptTag({ content: AIM });
await lead.bringToFront();
await wait(2500);

// 발표 주기를 짧게 하려면 서버 RULES 를 바꿔야 하므로, 여기서는 실제 설정대로 기다린다
const FIRST = RULES.LEADER_FIRST_DELAY;

const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(500);
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);

// 라운드 시작 직후에는 선두가 없어야 한다 (다 0점이니까)
const early = await chase.evaluate(() => ({
  leader: window.__game.leader,
  chip: !document.getElementById('leaderChip').hidden,
}));
check('라운드 시작 직후에는 선두 발표 없음', early.leader === null && early.chip === false,
  `leader=${JSON.stringify(early.leader)} chip=${early.chip}`);

// P1(1모둠)이 비커를 검사해서 진행률을 올린다 (불 → 비커)
await lead.addScriptTag({ content: `
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
    for (let i = 0; i < 20; i++) {
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
      await new Promise(r => setTimeout(r, 190));
    }
    return true;
  };` });

tws.send(JSON.stringify({ t: 'supply', kind: 'reagent', amount: 12 }));
await wait(1200);

const beaker = LAYOUT.beakers[0];
await lead.evaluate(async (bk) => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const near = g.world.nearestFire(bk.x, bk.z);
  if (near) { await window.__glide(near.fire.x, near.fire.z); await sleep(500); }
  await window.__glide(bk.x, bk.z + 13);
  await window.__aim(() => ({ x: bk.x, y: bk.y + 4.2, z: bk.z }));
  for (let a = 1; a <= 4; a++) {
    g.selectAmmo(a); g.lastShot = 0; g.tryShoot();
    await sleep(600);
  }
}, { x: beaker.x, y: beaker.y, z: beaker.z });

// 첫 발표 시각까지 기다린다
console.log(`   (첫 발표까지 최대 ${FIRST}초 대기…)`);
const got = await chase.evaluate(async (maxSec) => {
  const g = window.__game;
  for (let i = 0; i < maxSec * 2 + 30; i++) {
    if (g.leader) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const ban = document.getElementById('leaderBanner');
  const chip = document.getElementById('leaderChip');
  return {
    leader: g.leader,
    bannerShown: !ban.hidden,
    bannerText: ban.textContent.replace(/\s+/g, ' ').trim(),
    chipShown: !chip.hidden,
    chipText: chip.textContent.replace(/\s+/g, ' ').trim(),
  };
}, FIRST);

check('선두 모둠이 발표됨', !!got.leader && got.leader.team === 0,
  got.leader ? `${got.leader.name} · 비커 ${got.leader.solved}/3 · 검사 ${got.leader.tested}/12` : '발표 없음');
check('★ 모자 색을 말해 준다', /모자/.test(got.bannerText) && got.leader &&
  got.bannerText.includes(got.leader.colorName),
  `"${got.bannerText.slice(0, 90)}"`);
check('★ 해당 모둠 닉네임도 같이 알려 준다',
  !!got.leader && got.leader.nicks.includes('앞선이') && got.bannerText.includes('앞선이'),
  got.leader ? got.leader.nicks.join(' · ') : '-');
check('마취 현상금 점수를 알려 준다',
  !!got.leader && got.leader.bounty === RULES.SCORE_TRANQ_LEADER &&
  got.bannerText.includes(`+${RULES.SCORE_TRANQ_LEADER}점`),
  `+${got.leader?.bounty}점`);
check('상시 표시 칩에도 모자 색이 보인다', got.chipShown && /모자/.test(got.chipText),
  `"${got.chipText}"`);

// 선두 본인에게는 '표적이 되었다'고 알려 준다
const mine = await lead.evaluate(() => {
  const ban = document.getElementById('leaderBanner');
  const chip = document.getElementById('leaderChip');
  return {
    isLeader: window.__game.leader && window.__game.leader.team === window.__game.myTeam,
    text: ban.textContent.replace(/\s+/g, ' ').trim(),
    mineClass: ban.className === 'mine' && chip.className === 'mine',
  };
});
check('선두 본인에게는 "우리가 1위 — 노려진다"고 안내', mine.isLeader && /우리 모둠이 1위/.test(mine.text) && mine.mineClass,
  `"${mine.text.slice(0, 70)}"`);

// 선두 모둠원 이름표에 왕관이 붙는가 (추격자 화면 기준)
const crown = await chase.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const foe = [...g.remote.values()].find(r => r.team !== g.myTeam);
  if (!foe) return { err: '상대 없음' };
  // 상대 근처로 걸어가서 이름표가 화면에 보이게 한다
  for (let i = 0; i < 80; i++) {
    const dx = foe.x - g.me.x, dz = foe.z - g.me.z, d = Math.hypot(dx, dz);
    if (d < 16) break;
    const s = Math.min(7, d - 14);
    g.me.x += dx / d * s; g.me.z += dz / d * s; g.me.y += 1.2;
    await sleep(200);
  }
  g.me.yaw = Math.atan2(foe.x - g.me.x, foe.z - g.me.z);
  g.me.pitch = 0;
  await sleep(1600);
  const tags = [...document.querySelectorAll('#tags .tag')].filter(t => t.style.display !== 'none');
  return {
    texts: tags.map(t => t.textContent.trim()),
    leaderTag: tags.some(t => t.classList.contains('leader')),
  };
});
check('선두 모둠원 이름표에 👑 이 붙는다', !crown.err && crown.leaderTag && crown.texts.some(t => t.includes('👑')),
  crown.err || crown.texts.join(' / '));

// 마취 현상금 — 선두를 마취시키면 더 큰 점수
// 자격시험은 교사 권한으로 면제하고 탄약을 채운다 (여기서 검증할 것은 '현상금 점수')
tws.send(JSON.stringify({ t: 'passQuizAll' }));
await wait(800);
tws.send(JSON.stringify({ t: 'supply', kind: 'tranq', amount: 20 }));
await wait(1200);

const hit = await chase.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const before = g.score;
  g.selectAmmo(0);
  for (let k = 0; k < 8; k++) {
    const foe = [...g.remote.values()].find(r => r.team !== g.myTeam);
    if (!foe) break;
    await window.__aimFoe(foe);
    g.lastShot = 0; g.tryShoot();
    await sleep(420);
  }
  await sleep(1200);
  return { before, after: g.score, delta: g.score - before };
});
check('선두 모둠원을 마취시키면 현상금 점수', hit.delta >= RULES.SCORE_TRANQ_LEADER,
  `점수 ${hit.before} → ${hit.after} (+${hit.delta}, 보통 마취는 +${RULES.SCORE_TRANQ})`);

// 마취는 30초라 확인이 늦으면 이미 풀려 있다 → '마취된 적이 있는가'로 본다
const downed = await lead.evaluate(() => window.__game.everDowned === true || window.__game.down === true);
check('실제로 마취되었다', downed === true);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await chase.screenshot({ path: '/tmp/leader_chase.png' });
await lead.screenshot({ path: '/tmp/leader_self.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

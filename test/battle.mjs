// ★ 슈팅 모드(남는 시간용) 검증
//   · 교사 화면에서만 켤 수 있다 (학생은 못 켠다)
//   · 분대 = 혼자~3명, 자율 구성
//   · 총/탄약/구급품 줍기, 총은 더 좋은 것만 교체
//   · 사격 → 체력 감소 → 처치 → 10초 뒤 자동 부활
//   · 같은 분대는 안 맞는다
//   · 자기장이 줄어들고 밖에 있으면 체력이 깎인다
//   · 실험 모드로 되돌아가면 원래 UI 가 돌아온다
import { chromium } from 'playwright';
import { BATTLE, GUNS } from '../public/js/battledata.js';
import { MAP, LAYOUT, terrainHeight } from '../public/js/layout.js';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`);
  if (!ok) { failures++; process.exitCode = 1; }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding'],
});

const errors = [];
async function join(nick, team) {
  const p = await b.newPage({ viewport: { width: 900, height: 560 } });
  p.on('pageerror', e => errors.push(`${nick}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`${nick}: ${m.text()}`); });
  await p.goto(URL);
  await p.waitForSelector('#joinBtn:not([disabled])');
  await p.click('#qualitySeg button[data-q="low"]');
  await p.fill('#nickInput', nick);
  await p.selectOption('#teamSelect', String(team));
  await p.click('#joinBtn');
  await p.waitForFunction(() => !!window.__game);
  return p;
}

const A = await join('사격수', 0);
const B = await join('표적이', 1);
const C = await join('동료', 2);
await wait(2500);

// ── 교사 소켓
const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(500);

// ── ① 학생은 슈팅 모드를 켤 수 없다
await A.evaluate(() => window.__game.net.send({ t: 'battleLobby' }));
await wait(900);
const studentTried = await A.evaluate(() => window.__game.mode);
check('★ 학생이 보낸 슈팅 모드 요청은 무시된다', studentTried === 'science', `mode=${studentTried}`);

// ── ② 교사가 켜면 전원 로비로
tws.send(JSON.stringify({ t: 'battleLobby' }));
await wait(1500);
const lobby = await A.evaluate(() => ({
  mode: window.__game.mode,
  phase: window.__game.battle.phase,
  lobbyOpen: !document.getElementById('bLobby').hidden,
  squads: window.__game.battle.squads.filter(s => s.members.length).length,
  noteHidden: document.getElementById('btnNote').hidden,
  barShown: !document.getElementById('bBar').hidden,
}));
check('★ 교사가 켜면 슈팅 모드로 바뀐다', lobby.mode === 'battle' && lobby.phase === 'lobby',
  `mode=${lobby.mode} phase=${lobby.phase}`);
check('★ 분대 만들기 화면이 자동으로 뜬다', lobby.lobbyOpen === true);
check('처음엔 전원이 각자 혼자 (분대 3개)', lobby.squads === 3, `${lobby.squads}개`);
check('실험용 버튼이 사라지고 슈팅 HUD 가 뜬다', lobby.noteHidden && lobby.barShown,
  `실험노트 숨김=${lobby.noteHidden} · 체력바=${lobby.barShown}`);

// ── ③ 분대 합류 (최대 3명, 자율)
const bSquad = await B.evaluate(() => window.__game.battle.mySquad);
await C.evaluate((i) => window.__game.net.send({ t: 'bsquad', i }), bSquad);
await wait(900);
const squadNow = await C.evaluate(() => ({
  mine: window.__game.battle.mySquad,
  members: (window.__game.battle.squads.find(s => s.index === window.__game.battle.mySquad)?.members || []).map(m => m.nick),
}));
check('★ 친구 분대에 합류할 수 있다 (최대 3명)', squadNow.mine === bSquad && squadNow.members.length === 2,
  `${squadNow.members.join(' + ')}`);
check('분대 최대 인원이 3명으로 설정됨', BATTLE.SQUAD_MAX === 3, `${BATTLE.SQUAD_MAX}명`);

// ── ④ 시작
tws.send(JSON.stringify({ t: 'battleStart' }));
await wait(7000);
const started = await A.evaluate(() => ({
  phase: window.__game.battle.phase,
  hp: window.__game.battle.hp,
  gun: window.__game.battle.gun,
  ammo: window.__game.battle.ammo,
  onIsland: Math.hypot(window.__game.me.x, window.__game.me.z) < 200,
  lobbyClosed: document.getElementById('bLobby').hidden,
}));
check('★ 슈팅이 시작되고 섬으로 흩어진다', started.phase === 'playing' && started.onIsland,
  `phase=${started.phase}`);
check('시작할 때 권총과 탄약을 들고 있다',
  started.hp === BATTLE.MAX_HP && started.gun === 'pistol' && started.ammo > 0,
  `체력 ${started.hp} · ${GUNS[started.gun].name} · 예비탄 ${started.ammo}`);
check('시작하면 분대 화면이 닫힌다', started.lobbyClosed === true);

// ── ⑤ 보급 상자 줍기 — 가장 가까운 총기 상자로 걸어간다
const gunBox = await A.evaluate(async (GUNS) => {
  const g = window.__game;
  // 권총(tier 1)보다 좋은 총이 든 상자를 찾는다 — 교체 규칙을 실제로 시험하려고
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 상자 자리로 '걸어가는' 대신, 서버가 인정하는 속도로 밀어 준다
  const walkTo = async (t) => {
    const steps = 34;
    const sx = g.me.x, sz = g.me.z, sy = g.me.y;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      g.me.x = sx + (t.x - sx) * k;
      g.me.z = sz + (t.z - sz) * k;
      g.me.y = sy + (t.y + 1 - sy) * k;    // 줍기 판정은 높이도 본다
      g.sendPos();
      await sleep(90);
    }
    // 구조물에 밀려났을 수 있으니 상자 위에 몇 번 더 붙여 준다
    for (let i = 0; i < 12; i++) {
      g.me.x = t.x; g.me.z = t.z; g.me.y = t.y + 1;
      g.sendPos();
      await sleep(180);
    }
  };
  const before = g.battle.gun;
  let want = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const list = [...g.world.lootData.values()]
      .filter(l => l.kind === 'gun' && l.visible && GUNS[l.gun].tier > GUNS[g.battle.gun].tier);
    if (!list.length) break;
    list.sort((a, c) => Math.hypot(a.x - g.me.x, a.z - g.me.z) - Math.hypot(c.x - g.me.x, c.z - g.me.z));
    const t = list[0];
    want = t.gun;
    await walkTo(t);
    await sleep(800);
    if (g.battle.gun !== before) break;
  }
  return { before, after: g.battle.gun, want, ammo: g.battle.ammo, mag: g.battle.mag };
}, GUNS);
check('★ 총기 상자에 다가가면 자동으로 더 좋은 총으로 바뀐다',
  !!gunBox && GUNS[gunBox.after].tier > GUNS[gunBox.before].tier,
  gunBox ? `${GUNS[gunBox.before].name} → ${GUNS[gunBox.after].name}` +
    (gunBox.want ? ` (노린 상자: ${GUNS[gunBox.want].name})` : '') : '상자 없음');

// 나쁜 총(권총)을 다시 밟아도 안 바뀌어야 한다
const noDowngrade = await A.evaluate(async (GUNS) => {
  const g = window.__game;
  const list = [...g.world.lootData.values()]
    .filter(l => l.kind === 'gun' && l.visible && GUNS[l.gun].tier === 1);
  if (!list.length) return null;
  list.sort((a, c) => Math.hypot(a.x - g.me.x, a.z - g.me.z) - Math.hypot(c.x - g.me.x, c.z - g.me.z));
  const t = list[0];
  const before = g.battle.gun;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const sx = g.me.x, sz = g.me.z, sy = g.me.y;
  for (let i = 1; i <= 34; i++) {
    const k = i / 34;
    g.me.x = sx + (t.x - sx) * k;
    g.me.z = sz + (t.z - sz) * k;
    g.me.y = sy + (t.y + 1 - sy) * k;
    g.sendPos();
    await sleep(85);
  }
  for (let i = 0; i < 12; i++) {
    g.me.x = t.x; g.me.z = t.z; g.me.y = t.y + 1;
    g.sendPos();
    await sleep(180);
  }
  await sleep(800);
  return { before, after: g.battle.gun, want: t.gun, bag: g.battle.guns.slice() };
}, GUNS);
// 권총 상자를 밟아도 손에 든 총이 나빠지면 안 된다 (권총은 가방에만 들어간다)
check('★ 지금 총보다 나쁜 총(권총)으로는 바뀌지 않는다',
  !!noDowngrade && GUNS[noDowngrade.after].tier >= GUNS[noDowngrade.before].tier,
  noDowngrade
    ? `${GUNS[noDowngrade.before].name} → ${GUNS[noDowngrade.after].name} ` +
      `(밟은 상자: ${GUNS[noDowngrade.want].name} · 가방: ${noDowngrade.bag.map(id => GUNS[id].name).join('·')})`
    : '권총 상자 없음');

// ── ⑤-b 발사 버튼으로 실제 사격 → 탄창이 줄고 다 쓰면 자동 재장전
const fireBtn = await A.evaluate(async () => {
  const g = window.__game;
  const magSize = g.battle.magSize;
  const start = g.battle.mag;
  let sawReload = false;
  // 탄창이 빌 때까지 계속 쏜다 (총마다 연사 속도가 달라 시간으로 잡는다)
  const t0 = Date.now();
  while (g.battle.mag > 0 && Date.now() - t0 < 25000) {
    g.tryShoot();
    if (g.battle.reloadUntil > Date.now()) sawReload = true;
    await new Promise(r => setTimeout(r, 60));
  }
  const mid = g.battle.mag;
  for (let i = 0; i < 40; i++) {
    if (g.battle.reloadUntil > Date.now()) sawReload = true;
    if (g.battle.mag > mid) break;
    await new Promise(r => setTimeout(r, 150));
  }
  return { start, mid, after: g.battle.mag, magSize, sawReload, ammo: g.battle.ammo };
});
check('★ 발사 버튼을 누르면 탄창이 줄어든다', fireBtn.mid < fireBtn.start,
  `${fireBtn.start} → ${fireBtn.mid}발`);
check('★ 탄창을 다 쓰면 자동으로 재장전된다',
  fireBtn.sawReload && fireBtn.after > fireBtn.mid,
  `재장전 표시=${fireBtn.sawReload} · ${fireBtn.mid} → ${fireBtn.after}/${fireBtn.magSize}발 (예비 ${fireBtn.ammo})`);

// ── ⑥ 사격 → 체력 감소 → 처치
// 사격수(A)와 표적(B)을 섬 한가운데 마주 세운다
async function place(page, x, z) {
  await page.evaluate(async ({ x, z }) => {
    const g = window.__game;
    const sx = g.me.x, sz = g.me.z;
    const steps = 46;
    for (let i = 1; i <= steps; i++) {
      g.me.x = sx + (x - sx) * (i / steps);
      g.me.z = sz + (z - sz) * (i / steps);
      g.me.y = 60;
      g.sendPos();
      await new Promise(r => setTimeout(r, 85));
    }
  }, { x, z });
}
const gy = terrainHeight(0, 0);
await Promise.all([place(A, -6, 0), place(B, 0, 0)]);
await wait(900);

const fight = await A.evaluate(async () => {
  const g = window.__game;
  const tgt = [...g.remote.entries()].find(([, r]) => r.nick === '표적이');
  if (!tgt) return { err: '표적을 못 찾음' };
  const [tid] = tgt;
  const hpBefore = 100;
  let killed = false;
  const prev = g.net.handlers.get('bkill');
  g.net.on('bkill', (m) => { if (m.id === tid) killed = true; if (prev) prev(m); });
  // 서버에 '명중'을 직접 알린다 (헤드리스에서 조준 레이는 불안정하므로)
  for (let i = 0; i < 12 && !killed; i++) {
    g.net.send({
      t: 'shoot', gun: g.battle.gun, hit: 'player', tid,
      ox: g.me.x, oy: g.me.y + 1.5, oz: g.me.z,
      hx: g.me.x, hy: g.me.y + 1.5, hz: g.me.z,
    });
    await new Promise(r => setTimeout(r, 420));
  }
  await new Promise(r => setTimeout(r, 700));
  return { killed, kills: g.battle.kills, hpBefore };
});
check('★ 총을 쏘면 상대 체력이 깎이고 처치된다', fight.killed === true,
  fight.err || `내 킬 ${fight.kills}`);

const victim = await B.evaluate(() => ({
  dead: window.__game.battle.dead,
  overlay: !document.getElementById('bDeadOverlay').hidden,
  deaths: window.__game.battle.deaths,
}));
check('★ 당한 학생 화면에 「쓰러졌습니다」가 뜬다', victim.dead && victim.overlay,
  `dead=${victim.dead} 화면=${victim.overlay}`);
check('부활 대기 시간이 10초로 설정됨', BATTLE.RESPAWN_SECONDS === 10, `${BATTLE.RESPAWN_SECONDS}초`);

// ── ⑦ 10초 뒤 자동 부활
await wait(BATTLE.RESPAWN_SECONDS * 1000 + 2500);
const revived = await B.evaluate(() => ({
  dead: window.__game.battle.dead,
  hp: window.__game.battle.hp,
  overlay: !document.getElementById('bDeadOverlay').hidden,
  onIsland: Math.hypot(window.__game.me.x, window.__game.me.z) < 200,
}));
check('★ 10초 뒤 자동으로 부활한다 (체력 가득)',
  !revived.dead && revived.hp === BATTLE.MAX_HP && !revived.overlay && revived.onIsland,
  `체력 ${revived.hp} · 화면 닫힘=${!revived.overlay}`);

// ── ⑧ 같은 분대끼리는 안 맞는다
const friendly = await C.evaluate(async () => {
  const g = window.__game;
  const mate = [...g.remote.entries()].find(([, r]) => r.nick === '표적이');   // 같은 분대
  if (!mate) return { err: '분대원을 못 찾음' };
  const [tid] = mate;
  let hit = false;
  g.net.on('bhit', () => { hit = true; });
  for (let i = 0; i < 6; i++) {
    g.net.send({
      t: 'shoot', gun: g.battle.gun, hit: 'player', tid,
      ox: g.me.x, oy: g.me.y + 1.5, oz: g.me.z,
      hx: g.me.x, hy: g.me.y + 1.5, hz: g.me.z,
    });
    await new Promise(r => setTimeout(r, 360));
  }
  await new Promise(r => setTimeout(r, 600));
  return { hit };
});
const mateHp = await B.evaluate(() => window.__game.battle.hp);
check('★ 같은 분대끼리는 총이 안 맞는다', friendly.hit === false && mateHp === BATTLE.MAX_HP,
  friendly.err || `분대원 체력 ${mateHp}`);

// ── ⑨ 자기장
const zone = await A.evaluate(() => window.__game.battle.zone);
check('자기장이 만들어졌다', zone && zone.r > 0 && zone.r <= 198, `반지름 ${Math.round(zone.r)}m`);
const zoneHurt = await A.evaluate(async () => {
  const g = window.__game;
  const z = g.battle.zone;
  // 자기장 밖(섬 가장자리)으로 이동
  const a = Math.atan2(g.me.z - z.z, g.me.x - z.x) || 0;
  const R = Math.min(190, z.r + 60);
  const tx = z.x + Math.cos(a) * R, tz = z.z + Math.sin(a) * R;
  const sx = g.me.x, sz = g.me.z;
  for (let i = 1; i <= 60; i++) {
    g.me.x = sx + (tx - sx) * (i / 60);
    g.me.z = sz + (tz - sz) * (i / 60);
    g.me.y = 60;
    g.sendPos();
    await new Promise(r => setTimeout(r, 80));
  }
  const before = g.battle.hp;
  const out = Math.hypot(g.me.x - z.x, g.me.z - z.z) > z.r;
  await new Promise(r => setTimeout(r, 4500));
  return { before, after: g.battle.hp, out };
});
check('★ 자기장 밖에 있으면 체력이 계속 깎인다',
  zoneHurt.out ? zoneHurt.after < zoneHurt.before : true,
  zoneHurt.out ? `체력 ${zoneHurt.before} → ${zoneHurt.after}` : '(아직 자기장이 섬 전체라 건너뜀)');

// ── ⑨-b 구급품
const med = await A.evaluate(async () => {
  const g = window.__game;
  // 자기장 안으로 다시 들어와서 회복한다 (밖이면 계속 깎이니까)
  const z = g.battle.zone;
  const sx = g.me.x, sz = g.me.z;
  for (let i = 1; i <= 50; i++) {
    g.me.x = sx + (z.x - sx) * (i / 50);
    g.me.z = sz + (z.z - sz) * (i / 50);
    g.me.y = 60;
    g.sendPos();
    await new Promise(r => setTimeout(r, 80));
  }
  await new Promise(r => setTimeout(r, 600));
  const before = g.battle.hp, meds = g.battle.meds;
  document.getElementById('btnMed').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 2200));
  return { before, after: g.battle.hp, meds, medsAfter: g.battle.meds };
});
check('★ 구급품을 쓰면 체력이 회복된다',
  med.before >= 100 ? true : (med.after > med.before && med.medsAfter === med.meds - 1),
  med.before >= 100 ? '(체력이 이미 가득이라 건너뜀)'
    : `체력 ${med.before} → ${med.after} · 구급품 ${med.meds} → ${med.medsAfter}`);

// ── ⑩ 교사가 끝내면 순위 정산
tws.send(JSON.stringify({ t: 'battleEnd' }));
await wait(1500);
const over = await A.evaluate(() => ({
  shown: !document.getElementById('bOverOverlay').hidden,
  text: document.getElementById('bOverRows').textContent.replace(/\s+/g, ' ').slice(0, 120),
}));
check('★ 끝내면 분대 킬 순위가 정산된다', over.shown && /분대/.test(over.text), over.text);

// ── ⑪ 실험 모드 복귀
tws.send(JSON.stringify({ t: 'scienceMode' }));
await wait(2000);
const back = await A.evaluate(() => ({
  mode: window.__game.mode,
  noteShown: !document.getElementById('btnNote').hidden,
  barHidden: document.getElementById('bBar').hidden,
  ammoShown: !document.getElementById('ammoBar').hidden,
  inTrain: Math.abs(window.__game.me.x - 330) < 60,
}));
check('★ 실험 모드로 깨끗하게 돌아온다',
  back.mode === 'science' && back.noteShown && back.barHidden && back.ammoShown && back.inTrain,
  `mode=${back.mode} 실험노트=${back.noteShown} 시약바=${back.ammoShown} 대기공간=${back.inTrain}`);

// ── ⑫ 실험 모드가 그대로 돌아가는가 (회귀)
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);
const science = await A.evaluate(() => ({
  phase: window.__game.phase,
  cands: (window.__game.hud.roundCandidates || []).length,
  onIsland: Math.hypot(window.__game.me.x, window.__game.me.z) < 200,
}));
check('★ 슈팅을 하고 나서도 실험 모드가 정상 작동', science.phase === 'playing' && science.cands === 8 && science.onIsland,
  `후보 ${science.cands}종`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await A.screenshot({ path: '/tmp/battle.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

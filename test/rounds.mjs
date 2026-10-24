// ★ 수업 피드백 3건 검증
//   ① 채점이 오래 걸리던 진짜 원인(오답 대기) 개선
//   ② 가열 표시가 시약 반응 알림을 가리지 않음
//   ③ 음료 가짓수 확대 + 라운드마다 후보가 새로 뽑혀 답이 겹치지 않음
import { chromium } from 'playwright';
import { RULES, DRINKS, signature, pickRoundDrinks, drinksBySignature } from '../public/js/gamedata.js';
import { LAYOUT } from '../public/js/layout.js';
import { readFileSync } from 'fs';

const URL = 'http://localhost:3000';
let failures = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!ok) { failures++; process.exitCode = 1; } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── ③-a 데이터 차원 검증 (브라우저 없이)
check('음료 종류가 크게 늘었다', DRINKS.length >= 20, `${DRINKS.length}종`);
check('검출 패턴이 충분히 다양하다', drinksBySignature().size >= 8,
  `${drinksBySignature().size}가지 패턴`);

// 같은 패턴을 가진 음료가 여러 개 있어야 "지난 판 답 외우기"가 안 통한다
const multi = [...drinksBySignature().values()].filter(g => g.length > 1);
check('같은 패턴을 가진 음료가 여러 개 있다 (외우기 방지)', multi.length >= 3,
  multi.map(g => g.map(d => d.name).join('=')).join(' / '));

// 후보 안에 같은 패턴이 둘 이상 들어가면 문제가 풀리지 않는다 — 절대 금지
let solvableFail = 0, dupAcross = 0;
const used = new Set();
const seenAnswers = [];
for (let r = 0; r < 3; r++) {
  const { drinks, candidates } = pickRoundDrinks(Math.random, [...used], RULES.ROUND_CANDIDATES);
  const sigs = new Set(candidates.map(signature));
  if (sigs.size !== candidates.length) solvableFail++;
  for (const d of drinks) { if (used.has(d.id)) dupAcross++; used.add(d.id); }
  seenAnswers.push(drinks.map(d => d.name).join('/'));
}
check('★ 후보 안에 구분 불가능한 조합이 없다 (반드시 풀림)', solvableFail === 0,
  `3라운드 검사, 위반 ${solvableFail}건`);
check('★ 3라운드 동안 정답 음료가 겹치지 않는다', dupAcross === 0,
  seenAnswers.join('  |  '));

// ── 브라우저 검증
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--disable-renderer-backgrounding'],
});
const p = await b.newPage({ viewport: { width: 980, height: 600 } });
const errors = [];
p.on('pageerror', e => errors.push(e.message));
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto(URL);
await p.waitForSelector('#joinBtn:not([disabled])');
await p.click('#qualitySeg button[data-q="low"]');
await p.fill('#nickInput', '검증');
await p.selectOption('#teamSelect', '0');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await wait(2500);

const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(500);
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);

const answersOf = () => {
  const logTxt = readFileSync('/tmp/srv.log', 'utf8');
  const mm = [...logTxt.matchAll(/라운드 시작 — 정답: (.+)$/gm)].pop();
  return mm[1].split(' / ').map(s => s.replace(/^\([ABC]\)\s*/, '').trim());
};
const names1 = answersOf();
const ids1 = names1.map(n => DRINKS.find(d => d.name === n).id);

// ── ③-b 학생 화면 후보가 '이번 라운드 후보'인가
const cand = await p.evaluate(() => {
  const g = window.__game;
  g.hud.togglePanel('note');
  const list = [...document.querySelectorAll('#noteDeduce .cand')].map(e => e.textContent);
  g.hud.closePanels();
  return { list, stored: (g.hud.roundCandidates || []).map(c => c.name) };
});
check('학생 화면에 이번 라운드 후보가 뜬다', cand.list.length === RULES.ROUND_CANDIDATES,
  `${cand.list.length}종 · ${cand.list.slice(0, 4).join(' · ')}…`);
check('정답 3종이 후보 안에 들어 있다', names1.every(n => cand.list.includes(n)),
  names1.join(' / '));
check('후보가 전체 목록(24종)이 아니다', cand.list.length < DRINKS.length,
  `후보 ${cand.list.length} < 전체 ${DRINKS.length}`);

// ── ① 오답 대기가 짧아지고, 버튼에 남은 초가 표시되는가
const wrongId = DRINKS.find(d => !ids1.includes(d.id) &&
  cand.list.includes(d.name)).id;                     // 후보 안의 틀린 답
const t0 = Date.now();
const first = await p.evaluate(async (wid) => {
  const g = window.__game;
  let at = 0;
  const prev = g.net.handlers.get('answerResult');
  g.net.on('answerResult', (m) => { at = performance.now(); if (prev) prev(m); });
  const s0 = performance.now();
  g.net.send({ t: 'answer', picks: { 0: wid } });
  for (let i = 0; i < 120 && !at; i++) await new Promise(r => setTimeout(r, 20));
  return { ms: Math.round(at - s0), cd: g.hud.cooldownUntil - Date.now() };
}, wrongId);
check('★ 채점 자체는 즉시 (0.5초 이내)', first.ms > 0 && first.ms < 500, `${first.ms} ms`);
check('★ 첫 오답 대기가 짧다', first.cd / 1000 <= RULES.WRONG_COOLDOWN_STEPS[0] + 1,
  `${Math.ceil(first.cd / 1000)}초 (설정 ${RULES.WRONG_COOLDOWN_STEPS[0]}초, 예전 30초)`);

const btn = await p.evaluate(async () => {
  const g = window.__game;
  g.hud.togglePanel('answer');
  await new Promise(r => setTimeout(r, 300));
  const b1 = document.getElementById('ansSubmitAll');
  const txt = b1.textContent.trim();
  await new Promise(r => setTimeout(r, 1100));
  const txt2 = document.getElementById('ansSubmitAll').textContent.trim();
  g.hud.closePanels();
  return { txt, txt2 };
});
check('★ 제출 버튼에 남은 시간이 흘러간다 (멈춘 게 아님을 보여줌)',
  /초 후 다시 제출/.test(btn.txt) && btn.txt !== btn.txt2,
  `"${btn.txt}" → "${btn.txt2}"`);

// 연속으로 틀리면 대기가 길어진다
await wait(RULES.WRONG_COOLDOWN_STEPS[0] * 1000 + 700);
const second = await p.evaluate(async (wid) => {
  const g = window.__game;
  let at = 0;
  const prev = g.net.handlers.get('answerResult');
  g.net.on('answerResult', (m) => { at = performance.now(); if (prev) prev(m); });
  g.net.send({ t: 'answer', picks: { 0: wid } });
  for (let i = 0; i < 120 && !at; i++) await new Promise(r => setTimeout(r, 20));
  return { cd: g.hud.cooldownUntil - Date.now() };
}, wrongId);
check('★ 계속 찍으면 대기가 길어진다 (찍기 방지)',
  second.cd > first.cd,
  `1회 ${Math.ceil(first.cd / 1000)}초 → 2회 ${Math.ceil(second.cd / 1000)}초`);

// ── ② 가열 표시가 시약 반응 알림을 가리지 않는가
const overlap = await p.evaluate(() => {
  const heat = document.getElementById('heatBadge');
  heat.hidden = false;                       // 강제로 띄워 놓고 위치 비교
  const t = document.getElementById('toasts');
  const d = document.createElement('div');
  d.className = 'toast good';
  d.textContent = '비커 A + 베네딕트 → 황적색 (양성! 당류 있음)';
  t.appendChild(d);
  const a = heat.getBoundingClientRect(), c = d.getBoundingClientRect();
  const hit = !(a.right < c.left || a.left > c.right || a.bottom < c.top || a.top > c.bottom);
  const text = heat.textContent;
  d.remove();
  return { hit, text, heat: [Math.round(a.left), Math.round(a.top), Math.round(a.right), Math.round(a.bottom)],
           toast: [Math.round(c.left), Math.round(c.top), Math.round(c.right), Math.round(c.bottom)] };
});
check('★ 가열 표시가 시약 반응 알림을 가리지 않는다', overlap.hit === false,
  `가열 [${overlap.heat}] · 알림 [${overlap.toast}]`);
check('★ 가열 표시에 남은 초가 없다', !/\d+\s*초/.test(overlap.text), `"${overlap.text}"`);

// ── ③-c 새 라운드를 돌리면 후보와 정답이 바뀌는가
tws.send(JSON.stringify({ t: 'resetRound' }));
await wait(9000);
const names2 = answersOf();
const cand2 = await p.evaluate(() => (window.__game.hud.roundCandidates || []).map(c => c.name));
const same = names2.filter(n => names1.includes(n));
check('★ 새 라운드에서 정답이 겹치지 않는다', same.length === 0,
  `1판 ${names1.join('/')} → 2판 ${names2.join('/')}`);
check('새 라운드에서 후보도 바뀐다', cand2.join() !== cand.list.join(),
  `${cand2.slice(0, 4).join(' · ')}…`);

check('자바스크립트 에러 없음', errors.length === 0, errors.slice(0, 4).join(' | '));
await p.screenshot({ path: '/tmp/rounds.png' });
console.log(`\n${failures === 0 ? '전부 통과' : failures + '개 실패'}`);
tws.close();
await b.close();
process.exit(process.exitCode || 0);

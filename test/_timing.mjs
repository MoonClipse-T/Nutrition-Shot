// 정답 제출 → 채점 결과가 화면에 뜨기까지 실제로 몇 ms 걸리는지 잰다
import { chromium } from 'playwright';
import { DRINKS, RULES } from '../public/js/gamedata.js';
import { readFileSync } from 'fs';

const URL = 'http://localhost:3000';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
await p.goto(URL);
await p.waitForSelector('#joinBtn:not([disabled])');
await p.click('#qualitySeg button[data-q="low"]');
await p.fill('#nickInput', '측정');
await p.selectOption('#teamSelect', '0');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await wait(2500);
const tws = new WebSocket(URL.replace('http', 'ws'));
await new Promise(r => { tws.onopen = r; });
tws.send(JSON.stringify({ t: 'teacher' }));
await wait(400);
tws.send(JSON.stringify({ t: 'startGame' }));
await wait(8000);

const logTxt = readFileSync('/tmp/srv.log', 'utf8');
const mm = [...logTxt.matchAll(/라운드 시작 — 정답: (.+)$/gm)].pop();
const names = mm[1].split(' / ').map(s => s.replace(/^\([ABC]\)\s*/, '').trim());
const ids = names.map(n => DRINKS.find(d => d.name === n).id);
const wrongId = DRINKS.find(d => d.id !== ids[0]).id;

// ① 오답 제출 왕복 시간
const t1 = await p.evaluate(async (wid) => {
  const g = window.__game;
  const t0 = performance.now();
  let done = 0;
  const prev = g.net.handlers.get('answerResult');
  g.net.on('answerResult', (m) => { done = performance.now(); if (prev) prev(m); });
  g.net.send({ t: 'answer', picks: { 0: wid } });
  for (let i = 0; i < 100 && !done; i++) await new Promise(r => setTimeout(r, 20));
  return { ms: Math.round(done - t0), overlay: !document.getElementById('resultOverlay').hidden };
}, wrongId);
console.log(`오답 제출 → 결과창까지 : ${t1.ms} ms (결과창 표시=${t1.overlay})`);

// ② 오답 직후 다시 제출하면?
const t2 = await p.evaluate(async (allIds) => {
  const g = window.__game;
  const t0 = performance.now();
  let done = 0, note = '';
  const prev = g.net.handlers.get('answerResult');
  g.net.on('answerResult', (m) => { done = performance.now(); if (prev) prev(m); });
  const prevToast = g.net.handlers.get('toast');
  g.net.on('toast', (m) => { note = m.msg; if (prevToast) prevToast(m); });
  g.net.send({ t: 'answer', picks: { 0: allIds[0], 1: allIds[1], 2: allIds[2] } });
  for (let i = 0; i < 150 && !done; i++) await new Promise(r => setTimeout(r, 20));
  return { ms: done ? Math.round(done - t0) : -1, note };
}, ids);
console.log(`오답 직후 재제출        : ${t2.ms < 0 ? '거부됨' : t2.ms + ' ms'} — "${t2.note}"`);
console.log(`설정된 오답 대기 시간   : ${RULES.WRONG_ANSWER_COOLDOWN}초`);

tws.close(); await b.close(); process.exit(0);

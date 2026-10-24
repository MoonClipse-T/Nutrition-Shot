// 정답 제출 → 채점 결과 화면을 캡처한다
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { DRINKS, REAGENTS } from '../public/js/gamedata.js';

const URL = 'http://localhost:3000';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 1024, height: 640 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto(URL);
await p.waitForSelector('#joinBtn:not([disabled])');
await p.click('#qualitySeg button[data-q="mid"]');
await p.fill('#nickInput', '홍길동');
await p.click('#joinBtn');
await p.waitForFunction(() => !!window.__game);
await new Promise(r => setTimeout(r, 2500));

// 서버 로그에서 이번 라운드 정답을 읽는다 (연출용)
const log = readFileSync('/tmp/srv.log', 'utf8');
const mm = [...log.matchAll(/새 라운드 시작 — 정답: (.+)$/gm)].pop();
const names = mm[1].split(' / ').map(s => s.replace(/^\([ABC]\)\s*/, '').trim());
const ids = names.map(n => DRINKS.find(d => d.name === n).id);

// A는 정답, B는 오답, C는 정답으로 제출해서 O/X가 섞인 화면을 만든다
const wrongForB = DRINKS.find(d => d.id !== ids[1]).id;
await p.evaluate(async ({ ids, wrongForB }) => {
  const g = window.__game;
  g.hud.togglePanel('answer');
  await new Promise(r => setTimeout(r, 400));
  const pick = (bi, id) => document.querySelector(`.drink[data-bi="${bi}"][data-id="${id}"]`)?.click();
  pick(0, ids[0]); pick(1, wrongForB); pick(2, ids[2]);
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('ansSubmitAll').click();
}, { ids, wrongForB });
await new Promise(r => setTimeout(r, 2000));
await p.screenshot({ path: '/tmp/s9_result.png' });

// 결과창 닫고 A·B·C 상태 띠가 남아 있는지
await p.click('#resultClose');
await new Promise(r => setTimeout(r, 600));
await p.screenshot({ path: '/tmp/s10_status.png' });

console.log('done');
await b.close();
process.exit(0);

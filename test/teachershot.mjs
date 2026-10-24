// 교사 화면에 학생 활동 표가 제대로 뜨는지 확인 (봇 몇 명 붙여 놓고 캡처)
import { chromium } from 'playwright';

const URL = 'http://localhost:3000';
const NAMES = ['홍길동', '김서연', '박지훈', '이수민', '최유진', '정하늘', '오민재', '한소율'];
const bots = [];

for (let i = 0; i < NAMES.length; i++) {
  const ws = new WebSocket(URL.replace('http', 'ws'));
  await new Promise(r => { ws.onopen = r; });
  ws.send(JSON.stringify({ t: 'join', nick: NAMES[i], team: i % 3 }));
  bots.push(ws);
  await new Promise(r => setTimeout(r, 120));
}
await new Promise(r => setTimeout(r, 800));

// 몇 명은 마취탄만 난사(압수 유도), 몇 명은 조용히
for (let k = 0; k < 12; k++) {
  for (const [i, ws] of bots.entries()) {
    if (i % 3 !== 0) continue;                 // 0,3,6번만 난사
    ws.send(JSON.stringify({ t: 'shoot', ammo: 'tranq', ox: 0, oy: 2, oz: 0, hx: 5, hy: 9, hz: 5 }));
  }
  await new Promise(r => setTimeout(r, 320));
}
await new Promise(r => setTimeout(r, 2500));

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const t = await b.newPage({ viewport: { width: 1320, height: 1000 } });
await t.goto(`${URL}/teacher`);
await new Promise(r => setTimeout(r, 3500));
await t.click('#peek');
await t.screenshot({ path: '/tmp/s5_teacher.png', fullPage: true });
console.log('done');
await b.close();
for (const ws of bots) ws.close();
process.exit(0);

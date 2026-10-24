// ============================================================
//  Project_Godeok : 영양소 검출 배틀로얄 — 게임 서버
//  실행:  node server.js            (기본 3000번 포트)
//        node server.js 8080       (포트 바꾸기)
//  같은 와이파이에 있는 태블릿에서 http://<이 컴퓨터 IP>:3000 으로 접속
// ============================================================
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { attachWS } from './ws-lite.js';
import {
  RULES, REAGENTS, REAGENT_LIST, DRINKS, NUTRIENTS, pickRoundDrinks, makeQuiz,
  TEAM_COLORS, TEAM_NAMES, TEAM_COLOR_NAMES,
} from './public/js/gamedata.js';
import {
  LAYOUT, spawnPointFor, trainingSpawn, safeZoneAt, terrainHeight, MAP, TRAIN,
} from './public/js/layout.js';
import { makeBattle } from './battle.js';
import { BATTLE, GUNS } from './public/js/battledata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = parseInt(process.argv[2] || process.env.PORT || '3000', 10);
const TICK_HZ = 15;

// ------------------------------------------------------------
//  정적 파일 서빙
// ------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/teacher') urlPath = '/teacher.html';
  if (urlPath === '/worksheet') urlPath = '/worksheet.html';

  const filePath = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ------------------------------------------------------------
//  게임 상태
// ------------------------------------------------------------
let nextId = 1;
const players = new Map();      // id -> player
const teachers = new Set();     // 교사 대시보드 연결
const teams = [];               // {index, members:Set(id), score, answers:{bi:drinkId}, solved:{}, wrongUntil}

const pickups = LAYOUT.pickups.map(p => ({ ...p, takenAt: 0 }));
let round = null;

// ------------------------------------------------------------
//  게임 단계
//   waiting : 학생들이 대기 공간(훈련장)에서 조작 연습
//   playing : 선생님이 '게임 시작'을 누른 뒤. 전원이 모둠 창고에서 동시 출발
//   over    : 라운드 종료(정답 공개)
// ------------------------------------------------------------
let phase = 'waiting';
let startAt = 0;                  // 카운트다운이 끝나고 실제로 움직일 수 있는 시각

// ★ 모드 — 'science' = 수업용 영양소 검출 / 'battle' = 남는 시간용 슈팅 모드
//   슈팅 모드는 선생님 화면에서만 켤 수 있고, 학생은 스스로 켤 수 없다.
let mode = 'science';

// ★ 선두 모둠 (마취 현상금 대상) — 아직 없으면 null
let leaderTeam = null;
let nextLeaderAt = 0;

function phaseMsg() {
  return { t: 'phase', phase, startAt, mode, countdown: RULES.START_COUNTDOWN };
}

function startGame() {
  round = null;                   // 새 라운드로
  startRound();                   // 여기서 phase 를 playing 으로 만든다
}

function now() { return Date.now(); }

function ensureTeam(i) {
  while (teams.length <= i) {
    teams.push({
      index: teams.length, members: new Set(), score: 0,
      answers: {}, solved: {}, wrongUntil: 0, wrongStreak: 0,
    });
  }
  return teams[i];
}

function assignTeam() {
  for (let i = 0; i < teams.length; i++) {
    if (teams[i].members.size < RULES.TEAM_SIZE) return i;
  }
  ensureTeam(teams.length);
  return teams.length - 1;
}

// ★ 이번 수업에서 이미 쓴 음료 — 라운드마다 겹치지 않게 하려고 기억해 둔다
const usedDrinkIds = new Set();

// 라운드 데이터(후보 8종 + 정답 3종)를 새로 뽑는다. 단계는 건드리지 않는다.
function prepareRound() {
  let picked = pickRoundDrinks(Math.random, [...usedDrinkIds], RULES.ROUND_CANDIDATES);
  // 쓸 만한 새 음료가 동났으면 기억을 비우고 다시 (한 시간에 3라운드면 올 일이 거의 없다)
  if (picked.drinks.every(d => usedDrinkIds.has(d.id))) {
    usedDrinkIds.clear();
    picked = pickRoundDrinks(Math.random, [], RULES.ROUND_CANDIDATES);
    log('🔄 음료를 한 바퀴 다 썼습니다 — 후보를 처음부터 다시 씁니다');
  }
  const { drinks, candidates } = picked;
  for (const d of drinks) usedDrinkIds.add(d.id);

  round = {
    drinks,                                  // index 0,1,2 -> 비커 A,B,C
    candidates,                              // 이번 라운드에 학생에게 보여줄 후보 8종
    startedAt: now(),
    endsAt: now() + RULES.ROUND_SECONDS * 1000,
    over: false,
  };
  for (const t of teams) {
    t.answers = {}; t.solved = {}; t.wrongUntil = 0; t.wrongStreak = 0;
    t.finishOrder = 0; t.finishedAt = 0;      // ★ 등수 확정 초기화
  }
  finishedCount = 0;
  for (const p of pickups) p.takenAt = 0;
  return drinks;
}

// ★ 선생님이 '게임 시작'을 눌렀을 때 — 전원이 모둠 창고에서 동시에 출발
function startRound() {
  const drinks = prepareRound();
  phase = 'playing';
  startAt = now() + RULES.START_COUNTDOWN * 1000;

  for (const p of players.values()) {
    p.tested = [new Set(), new Set(), new Set()];
    p.reagents = { iodine: 0, benedict: 0, biuret: 0, sudan: 0 };
    p.collected = {};
    p.tranqHits = 0; p.downUntil = 0;
    // 자격시험 합격은 라운드가 바뀌어도 유지한다 (한 번 외웠으면 됐다)
    p.tranqAmmo = p.quizPassed ? RULES.TRANQ_START_AMMO : 0;
    p.tranqSinceTest = 0;
    p.lockUntil = 0;
    p.heatUntil = 0;
    p.tranqFired = 0; p.testsDone = 0; p.downedOthers = 0;
    sendTo(p, { t: 'heat', until: 0 });
    sendTo(p, { t: 'lock', until: 0 });
    sendTo(p, ammoMsg(p));
    respawn(p);
    sendTo(p, { t: 'spawn', spawn: { x: p.x, y: p.y, z: p.z, yaw: p.yaw }, base: p.team });
  }
  // ★ 선두 모둠 초기화 — 초반엔 다 0이라 알릴 게 없다
  leaderTeam = null;
  firstLeaderAt = startAt + RULES.LEADER_FIRST_DELAY * 1000;
  nextLeaderAt = firstLeaderAt;
  broadcast({ t: 'leader', team: null });

  broadcast({ t: 'round', round: roundPublic(), layoutBeakers: LAYOUT.beakers });
  broadcast(phaseMsg());
  log(`▶ 라운드 시작 — 정답: ${drinks.map((d, i) => `(${'ABC'[i]}) ${d.name}`).join(' / ')}`);
  log(`   후보 ${round.candidates.length}종: ${round.candidates.map(d => d.name).join(' · ')}`);
}

function roundPublic() {
  return {
    startedAt: round.startedAt,
    endsAt: round.endsAt,
    over: round.over,
    // ★ 이번 라운드 후보 (매 라운드 새로 뽑힘 — 지난 판 답을 외워도 소용없다)
    //   같은 검출 패턴이 둘 이상 들어가지 않으므로 시약만으로 반드시 구분된다.
    candidates: round.candidates.map(d => ({ id: d.id, name: d.name })),
    // 음료 이름은 절대 안 보냄! 비커 색(액체색)만 힌트로 보낸다.
    // 섬에는 비커가 6개(두 세트)이고, 같은 글자면 같은 음료다.
    beakers: LAYOUT.beakers.map(b => ({
      index: b.index, drink: b.drink, label: b.label, zone: b.zone,
      liquid: round.drinks[b.drink].liquid,
    })),
  };
}

function respawn(p) {
  const teamIdx = p.team;
  const slot = [...ensureTeam(teamIdx).members].indexOf(p.id);
  const sp = spawnPointFor(teamIdx, Math.max(0, slot));
  p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw; p.pitch = 0;
}

// ------------------------------------------------------------
//  전송 도우미
// ------------------------------------------------------------
function sendTo(p, obj) { try { p.ws.send(JSON.stringify(obj)); } catch { /* */ } }
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) { try { p.ws.send(s); } catch { /* */ } }
  for (const t of teachers) { try { t.send(s); } catch { /* */ } }
}
function toTeam(teamIdx, obj) {
  const s = JSON.stringify(obj);
  for (const id of ensureTeam(teamIdx).members) {
    const p = players.get(id);
    if (p) { try { p.ws.send(s); } catch { /* */ } }
  }
}
function toTeachers(obj) {
  const s = JSON.stringify(obj);
  for (const t of teachers) { try { t.send(s); } catch { /* */ } }
}

const logs = [];
// ★ 슈팅 모드 — 별도 파일(battle.js)에 규칙이 전부 들어 있다
const battle = makeBattle({
  players, broadcast: (o) => broadcast(o), sendTo: (p, o) => sendTo(p, o),
  toTeachers: (o) => toTeachers(o), log: (s) => log(s),
});

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('ko-KR')}] ${msg}`;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  console.log(line);
  toTeachers({ t: 'log', line });
}

function roster() {
  return {
    t: 'roster',
    players: [...players.values()].map(p => ({
      id: p.id, nick: p.nick, team: p.team, score: p.score,
      // 교사 화면용 통계 — "실험은 안 하고 총만 쏘는 학생" 찾기
      tests: p.testsDone | 0,
      shots: p.tranqFired | 0,
      downs: p.downedOthers | 0,
      locked: p.lockUntil > now(),
      quiz: !!p.quizPassed,
      tranq: p.tranqAmmo | 0,
      // ★ 슈팅 모드
      squad: p.squad ?? -1, hp: p.hp | 0, gun: p.gun || 'pistol',
      kills: p.kills | 0, deaths: p.deaths | 0, dead: (p.deadUntil || 0) > now(),
      reagentTotal: REAGENT_LIST.reduce((s, r) => s + (p.reagents[r] | 0), 0),
    })),
    teams: teams.map(t => ({
      index: t.index, name: TEAM_NAMES[t.index] || `${t.index + 1}모둠`,
      color: TEAM_COLORS[t.index % TEAM_COLORS.length],
      colorName: TEAM_COLOR_NAMES[t.index % TEAM_COLOR_NAMES.length],
      finishOrder: t.finishOrder || 0,
      finishSeconds: t.finishedAt && round
        ? Math.max(0, Math.round((t.finishedAt - round.startedAt) / 1000)) : null,
      score: t.score, solved: t.solved, answers: t.answers,
      members: [...t.members].map(id => players.get(id)?.nick).filter(Boolean),
    })),
  };
}

// ============================================================
//  ★ 완주 = 등수 확정 (순위는 점수가 아니라 '먼저 다 맞힌 순서')
// ============================================================
let finishedCount = 0;

function finishTeam(team) {
  finishedCount++;
  team.finishOrder = finishedCount;
  team.finishedAt = now();

  const bonus = RULES.SCORE_FINISH[finishedCount - 1] | 0;
  if (bonus) team.score += bonus;

  const i = team.index;
  const medal = ['🥇', '🥈', '🥉'][finishedCount - 1] || '🏅';
  const nicks = [...team.members].map(id => players.get(id)?.nick).filter(Boolean);
  const elapsed = round ? Math.max(0, Math.round((team.finishedAt - round.startedAt) / 1000)) : 0;

  broadcast({
    t: 'finish',
    team: i,
    order: finishedCount,
    medal,
    name: TEAM_NAMES[i] || `${i + 1}모둠`,
    color: TEAM_COLORS[i % TEAM_COLORS.length],
    colorName: TEAM_COLOR_NAMES[i % TEAM_COLOR_NAMES.length],
    nicks,
    bonus,
    seconds: elapsed,
    podium: RULES.PODIUM_SIZE,
    remaining: Math.max(0, RULES.PODIUM_SIZE - finishedCount),
  });

  log(`${medal} ${finishedCount}등 확정 — ${TEAM_NAMES[i]} (${TEAM_COLOR_NAMES[i]} 모자) · ` +
      `${Math.floor(elapsed / 60)}분 ${elapsed % 60}초 · 보너스 +${bonus}`);
}

// 등수가 확정된 모둠도 계속 논다. 다만 '남은 자리 경쟁'에서는 빠진다.
function teamFinished(i) {
  const t = teams[i];
  return !!(t && t.finishOrder);
}

// ============================================================
//  ★ 선두 모둠 공개 — 마취총에 '이유'를 만들어 준다
//
//  "몇 모둠"은 서로 모르지만 **모자 색**은 눈에 보인다.
//  그래서 1위를 "초록색 모자" 로 불러 주고 닉네임도 같이 알려 준다.
//  다들 1위를 쫓고, 1위는 쫓기면서 실험해야 한다 → 독주 방지.
// ============================================================
let firstLeaderAt = 0;

function teamProgress(t) {
  const combo = new Set();
  for (const id of t.members) {
    const p = players.get(id);
    if (!p) continue;
    for (let bi = 0; bi < 3; bi++) for (const r of p.tested[bi]) combo.add(bi + ':' + r);
  }
  return {
    solved: Object.keys(t.solved || {}).length,   // 맞힌 비커 (0~3)
    tested: combo.size,                           // 검사한 (비커×시약) 조합 (0~12)
    score: t.score | 0,
  };
}

function computeLeader() {
  let best = null;
  for (const t of teams) {
    if (!t.members.size) continue;
    if (t.finishOrder) continue;          // 이미 등수를 확정한 모둠은 '남은 자리 경쟁'에서 제외
    const pr = teamProgress(t);
    if (pr.solved === 0 && pr.tested === 0 && pr.score <= 0) continue;   // 아직 아무것도 안 한 모둠
    const better = !best ||
      pr.solved > best.pr.solved ||
      (pr.solved === best.pr.solved && pr.tested > best.pr.tested) ||
      (pr.solved === best.pr.solved && pr.tested === best.pr.tested && pr.score > best.pr.score);
    if (better) best = { team: t, pr };
  }
  return best;
}

function leaderMsg(best, changed) {
  const i = best.team.index;
  return {
    t: 'leader',
    team: i,
    name: TEAM_NAMES[i] || `${i + 1}모둠`,
    color: TEAM_COLORS[i % TEAM_COLORS.length],
    colorName: TEAM_COLOR_NAMES[i % TEAM_COLOR_NAMES.length],
    nicks: [...best.team.members].map(id => players.get(id)?.nick).filter(Boolean),
    solved: best.pr.solved,
    tested: best.pr.tested,
    score: best.pr.score,
    bounty: RULES.SCORE_TRANQ_LEADER,
    changed: !!changed,
  };
}

// broadcast 는 학생 + 교사 화면에 모두 간다
function sendLeader(msg) { broadcast(msg); }

function clearLeader() {
  if (leaderTeam === null) return;
  leaderTeam = null;
  sendLeader({ t: 'leader', team: null });
}

function tickLeader(T) {
  if (!RULES.LEADER_ANNOUNCE) return;
  if (phase !== 'playing' || !round || round.over || T < firstLeaderAt) return;
  const best = computeLeader();
  const id = best ? best.team.index : null;
  if (id === null) { clearLeader(); return; }
  if (id !== leaderTeam) {
    leaderTeam = id;
    sendLeader(leaderMsg(best, true));
    nextLeaderAt = T + RULES.LEADER_ANNOUNCE_SECONDS * 1000;
    log(`👑 선두 ${TEAM_NAMES[id]}(${TEAM_COLOR_NAMES[id]} 모자) — 비커 ${best.pr.solved}/3 · 검사 ${best.pr.tested}/12`);
  } else if (T >= nextLeaderAt) {
    sendLeader(leaderMsg(best, false));
    nextLeaderAt = T + RULES.LEADER_ANNOUNCE_SECONDS * 1000;
  }
}

// ------------------------------------------------------------
//  교사 보급 — 32명이 시약이 모자라 멈추는 것을 막는 안전장치
// ------------------------------------------------------------
function teacherSupply(m) {
  const team = Number.isInteger(m.team) && m.team >= 0 ? m.team : null;   // null = 전체
  const kind = m.kind === 'tranq' ? 'tranq' : 'reagent';
  const amount = Math.max(1, Math.min(20, m.amount | 0 || 5));
  let n = 0;

  for (const p of players.values()) {
    if (team !== null && p.team !== team) continue;
    if (kind === 'tranq') {
      if (!p.quizPassed) continue;             // 자격시험 전에는 마취탄을 줘도 못 쓴다
      p.tranqAmmo = Math.min(RULES.TRANQ_MAX_AMMO, p.tranqAmmo + amount);
    } else {
      for (const r of REAGENT_LIST) {
        p.reagents[r] = Math.min(RULES.REAGENT_MAX_CARRY, (p.reagents[r] | 0) + amount);
        p.collected[r] = true;                 // 아직 못 주운 시약도 바로 쓸 수 있게
      }
    }
    sendTo(p, ammoMsg(p));
    sendTo(p, {
      t: 'toast', good: true,
      msg: kind === 'tranq'
        ? `🎁 선생님이 마취탄 ${amount}발을 보급했습니다`
        : `🎁 선생님이 시약을 종류별로 ${amount}발씩 보급했습니다`,
    });
    n++;
  }
  const who = team === null ? '전체' : (TEAM_NAMES[team] || `${team + 1}모둠`);
  log(`🎁 보급 — ${who} ${n}명에게 ${kind === 'tranq' ? '마취탄' : '시약'} ${amount}발씩`);
}

// ------------------------------------------------------------
//  WebSocket 처리
// ------------------------------------------------------------
attachWS(server, (ws) => {
  let me = null;
  let isTeacher = false;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    // ---------- 교사 대시보드 ----------
    if (m.t === 'teacher') {
      isTeacher = true;
      teachers.add(ws);
      ws.send(JSON.stringify({
        t: 'teacherInit',
        round: round ? roundPublic() : null,
        answerKey: round ? round.drinks.map((d, i) => ({ label: 'ABC'[i], name: d.name, has: d.has })) : [],
        drinks: DRINKS, reagents: REAGENTS, nutrients: NUTRIENTS,
        rules: RULES, logs,
        urls: localIPs().map(ip => `http://${ip}:${PORT}`),
        phase, mode, battle: BATTLE, guns: GUNS,
      }));
      ws.send(JSON.stringify(roster()));
      ws.send(JSON.stringify(battle.stateMsg()));
      ws.send(JSON.stringify(battle.squadsPublic()));
      if (leaderTeam !== null) {
        const best = computeLeader();
        if (best) ws.send(JSON.stringify(leaderMsg(best, false)));
      }
      return;
    }
    if (isTeacher) {
      // ---------- ★ 슈팅 모드 (남는 시간용) ----------
      //  학생은 이 명령을 보낼 수 없다. 교사 화면 버튼에서만 켜진다.
      if (m.t === 'battleLobby') {
        mode = 'battle';
        phase = 'waiting'; startAt = 0;
        clearLeader();
        battle.enterLobby();
        broadcast(phaseMsg());
        toTeachers(teacherKey());
        return;
      }
      if (m.t === 'battleStart') {
        if (mode !== 'battle') { mode = 'battle'; battle.enterLobby(); }
        battle.start();
        phase = 'playing'; startAt = battle.S.startAt;
        broadcast(phaseMsg());
        toTeachers(teacherKey());
        return;
      }
      if (m.t === 'battleEnd') {
        battle.end('선생님이 종료');
        return;
      }
      if (m.t === 'scienceMode') {
        battle.leave();
        mode = 'science';
        phase = 'waiting'; startAt = 0;
        for (const p of players.values()) {
          const sp = trainingSpawn(p.id);
          p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw;
          p.downUntil = 0; p.tranqHits = 0; p.lockUntil = 0; p.hp = 0;
          sendTo(p, { t: 'spawn', spawn: sp, training: true });
          sendTo(p, ammoMsg(p));
        }
        broadcast(phaseMsg());
        broadcast(battle.stateMsg());
        toTeachers(teacherKey());
        log('🧪 실험 모드로 돌아왔습니다 — 전원 대기 공간');
        return;
      }

      if (m.t === 'startGame' || m.t === 'resetRound') {
        if (mode === 'battle') { battle.leave(); mode = 'science'; broadcast(battle.stateMsg()); }
        startGame();
        toTeachers(teacherKey());
        log(m.t === 'startGame' ? '🚩 게임 시작 — 전원 모둠 창고에서 동시 출발' : '🔄 새 라운드');
      }
      if (m.t === 'toLobby') {
        if (mode === 'battle') {                 // 슈팅 중이면 슈팅 로비로
          phase = 'waiting'; startAt = 0;
          battle.enterLobby();
          broadcast(phaseMsg());
          return;
        }
        phase = 'waiting'; startAt = 0;
        for (const p of players.values()) {
          const sp = trainingSpawn(p.id);
          p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw;
          p.downUntil = 0; p.tranqHits = 0; p.lockUntil = 0;
          sendTo(p, { t: 'spawn', spawn: sp, training: true });
        }
        clearLeader();
        broadcast(phaseMsg());
        log('⏸ 전원 대기 공간으로 이동');
      }
      if (m.t === 'endRound' && round) { round.over = true; clearLeader(); broadcast({ t: 'round', round: roundPublic() }); revealAnswers(); }
      if (m.t === 'supply') teacherSupply(m);
      if (m.t === 'watch') {
        const id = Number.isInteger(m.id) ? m.id : null;
        setWatch(ws, id !== null && players.has(id) ? id : null);
      }
      if (m.t === 'refillPickups') {
        for (const pu of pickups) pu.takenAt = 0;
        broadcast({ t: 'pickBack', ids: pickups.map(p => p.id) });
        broadcast({ t: 'toast', msg: '📦 선생님이 섬의 시약 상자를 전부 다시 채웠습니다!', good: true });
        log('📦 시약 상자 전체 리필');
      }
      if (m.t === 'passQuizAll') {
        let n = 0;
        for (const p of players.values()) {
          if (p.quizPassed) continue;
          p.quizPassed = true; p.quiz = null; p.quizUntil = 0;
          p.tranqAmmo = Math.max(p.tranqAmmo, RULES.TRANQ_START_AMMO);
          sendTo(p, { t: 'quizState', passed: true, byTeacher: true });
          sendTo(p, ammoMsg(p));
          n++;
        }
        log(`🎓 선생님이 자격시험을 면제했습니다 — ${n}명 마취총 해금`);
      }
      if (m.t === 'unlockAll') {
        let n = 0;
        for (const p of players.values()) {
          if (p.lockUntil > now()) { n++; sendTo(p, { t: 'lock', until: 0 }); }
          // 압수를 풀어 줄 때는 경고 카운터도 같이 초기화한다
          // (아니면 두어 발 쏘자마자 바로 다시 압수당한다)
          p.lockUntil = 0;
          p.tranqSinceTest = 0;
        }
        log(`🔓 압수 해제 ${n}명 (전원 경고 카운터 초기화)`);
      }
      return;
    }

    // ---------- 입장 ----------
    if (m.t === 'join') {
      if (me) return;
      const nick = String(m.nick || '').trim().slice(0, 10) || `학생${nextId}`;
      const teamIdx = (Number.isInteger(m.team) && m.team >= 0 && m.team < 8)
        ? m.team : assignTeam();
      const team = ensureTeam(teamIdx);

      me = {
        id: nextId++, nick, team: teamIdx, ws,
        x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0,
        reagents: { iodine: 0, benedict: 0, biuret: 0, sudan: 0 },
        collected: {},
        // 마취총은 자격시험을 통과해야 열린다 → 처음엔 탄약 0
        tranqAmmo: RULES.TRANQ_REQUIRE_QUIZ ? 0 : RULES.TRANQ_START_AMMO,
        quizPassed: !RULES.TRANQ_REQUIRE_QUIZ,
        quizUntil: 0, quiz: null, quizTries: 0,
        tranqHits: 0, lastTranqAt: 0, downUntil: 0,
        tranqSinceTest: 0,          // 비커 검사 없이 쏜 마취탄 수
        heatUntil: 0,               // ★ 가열 상태(불에 닿아 몸이 데워진) 만료 시각
        heatWarnAt: 0,
        lockUntil: 0,               // 총 압수 해제 시각
        tranqFired: 0, testsDone: 0, downedOthers: 0,   // 교사 화면 통계
        score: 0, tested: [new Set(), new Set(), new Set()],
        lastShotAt: 0, joinedAt: now(),
        // ★ 슈팅 모드용 (실험 모드에서는 쓰지 않는다)
        squad: -1, hp: 0, gun: 'pistol', guns: ['pistol'], mags: {}, mag: 0, ammo: 0, meds: 0,
        kills: 0, deaths: 0, deadUntil: 0, reloadUntil: 0, medUntil: 0,
      };
      team.members.add(me.id);
      players.set(me.id, me);
      // 대기 중에는 훈련장에서, 이미 시작했으면 우리 모둠 창고에서
      if (phase === 'playing' && round) respawn(me);
      else {
        const sp = trainingSpawn(players.size);
        me.x = sp.x; me.y = sp.y; me.z = sp.z; me.yaw = sp.yaw;
      }

      sendTo(me, {
        t: 'init',
        selfId: me.id,
        nick: me.nick,
        team: teamIdx,
        teamName: TEAM_NAMES[teamIdx] || `${teamIdx + 1}모둠`,
        teamColor: TEAM_COLORS[teamIdx % TEAM_COLORS.length],
        teamColorName: TEAM_COLOR_NAMES[teamIdx % TEAM_COLOR_NAMES.length],
        spawn: { x: me.x, y: me.y, z: me.z, yaw: me.yaw },
        // 클라이언트가 탄약을 자기 마음대로 가정하지 않도록 서버가 알려준다
        ammo: {
          reagents: me.reagents, tranq: me.tranqAmmo, collected: me.collected,
          tranqCap: tranqCap(me), quizPassed: !!me.quizPassed,
        },
        round: round ? roundPublic() : null,
        pickups: pickups.map(p => ({ id: p.id, reagent: p.reagent, x: p.x, y: p.y, z: p.z })),
        beakers: LAYOUT.beakers,
        bases: LAYOUT.bases,
        training: LAYOUT.training,
        phase, startAt, mode, rules: RULES, battleRules: BATTLE, guns: GUNS,
      });
      // ★ 슈팅 모드가 켜져 있으면 그쪽 정보도 같이 보낸다 (도중 입장 대응)
      if (mode === 'battle') battle.onJoin(me);
      // 늦게 들어온 학생도 지금 선두가 누구인지 바로 알 수 있게
      if (leaderTeam !== null) {
        const best = computeLeader();
        if (best) sendTo(me, leaderMsg(best, false));
      }
      broadcast(roster());
      log(`＋ ${nick} 입장 (${TEAM_NAMES[teamIdx]})`);
      return;
    }

    if (!me) return;
    const P = me;

    // ---------- 위치 갱신 ----------
    if (m.t === 'in') {
      if (P.downUntil > now()) return;                    // 마취 중엔 이동 무시
      if (mode === 'battle' && P.deadUntil > now()) return; // 쓰러져 있는 동안도 무시
      const nx = +m.x, ny = +m.y, nz = +m.z;
      if (![nx, ny, nz].every(Number.isFinite)) return;

      const T = now();
      const gapMs = Math.min(5000, T - (P.lastInAt || T));
      P.lastInAt = T;

      const d = Math.hypot(nx - P.x, nz - P.z);
      const inBounds = phase === 'playing'
        ? Math.hypot(nx, nz) < MAP.PLAY_R + 10
        : (Math.abs(nx - TRAIN.cx) < TRAIN.half + 6 && Math.abs(nz - TRAIN.cz) < TRAIN.half + 6);

      // ★★ 위치 검증은 '시간 기준' 으로 한다 ★★
      //  예전에는 한 번에 18m 라는 고정값이었다. 그런데 태블릿 화면이 잠깐 꺼지거나
      //  와이파이가 2초만 끊겨도 그 사이 학생은 20m 넘게 움직여 있고, 그러면 그 뒤로는
      //  '서버가 아는 위치'와 '실제 위치'의 차이가 계속 벌어져서 영영 갱신되지 않았다.
      //  → 그 학생은 시약 상자도, 불꽃도 평생 근접 판정에 걸리지 않는다.
      //    (30명 수업에서 "어떤 애만 시약이 안 주워져요" 의 진짜 원인)
      const allow = Math.max(6, RULES.RUN_SPEED * (gapMs / 1000) * 1.8 + 4);
      const okStep = d < allow;

      if (okStep && inBounds) {
        P.desync = 0;
        const fromX = P.x, fromZ = P.z;
        P.x = nx; P.y = ny; P.z = nz;
        // 프레임이 뚝뚝 끊기는 태블릿은 불꽃을 '건너뛸' 수 있으므로,
        // 점이 아니라 '지나온 선분'으로 판정한다.
        if (phase === 'playing' && mode === 'science') touchFire(P, fromX, fromZ);
      } else if (inBounds) {
        // 튕겨낸 뒤에도 계속 어긋나면(=끊겼던 것) 강제로 다시 맞춰 준다. 절대 방치하지 않는다.
        if (++P.desync >= 5) {
          P.desync = 0;
          P.x = nx; P.y = ny; P.z = nz;
          P.resyncs = (P.resyncs | 0) + 1;
          if (P.resyncs <= 3 || P.resyncs % 20 === 0) {
            log(`↻ ${P.nick} 위치 재동기화 (통신이 잠깐 끊겼던 것 같습니다 · 누적 ${P.resyncs}회)`);
          }
          if (phase === 'playing' && mode === 'science') touchFire(P);
        }
      }

      P.yaw = +m.yaw || 0; P.pitch = +m.pitch || 0; P.flags = m.f | 0;
      return;
    }

    // ---------- ★ 슈팅 모드 전용 요청 ----------
    if (mode === 'battle') {
      if (m.t === 'bsquad') { if (battle.joinSquad(P, m.i | 0)) battle.pushSquads(); return; }
      if (m.t === 'bsolo') { battle.soloSquad(P); battle.pushSquads(); return; }
      if (m.t === 'bloot') { battle.tryLoot(P, m.id | 0, +m.x, +m.z); return; }
      if (m.t === 'bmed') { battle.useMed(P); return; }
      if (m.t === 'bequip') { battle.equip(P, String(m.gun || '')); return; }
      if (m.t === 'bdrop') { battle.drop(P, String(m.gun || '')); return; }
      if (m.t === 'shoot') {
        if (battle.playing()) { battle.shoot(P, m); return; }
        if (phase === 'playing') return;      // 결과 화면 — 사격 없음
        // 로비(대기 공간)에서는 아래 '연습 사격' 경로로 넘어간다
      }
      // 실험 모드 전용 요청은 슈팅 중에는 전부 무시한다
      if (['pick', 'answer', 'quizStart', 'quizSubmit'].includes(m.t)) return;
    }

    // ---------- 시약 줍기 ----------
    if (m.t === 'pick') {
      const pu = pickups[m.id | 0];
      if (!pu) return;
      if (pu.takenAt && now() - pu.takenAt < RULES.PICKUP_RESPAWN_SECONDS * 1000) return;

      // ★ 서버가 아는 위치가 잠깐 뒤처져 있어도 시약을 못 줍는 일이 없도록,
      //   학생이 같이 보내온 위치도 같이 본다 (섬 안이면 인정).
      const R = RULES.PICKUP_RADIUS + 3;
      let near = Math.hypot(pu.x - P.x, pu.z - P.z) <= R;
      const cx = +m.x, cz = +m.z;
      if (!near && Number.isFinite(cx) && Number.isFinite(cz) &&
          Math.hypot(cx, cz) < MAP.PLAY_R + 10 &&
          Math.hypot(pu.x - cx, pu.z - cz) <= R) {
        near = true;
        // 여기까지 왔다는 건 서버 위치가 뒤처졌다는 뜻 → 이참에 맞춰 준다
        P.x = cx; P.z = cz; P.desync = 0;
      }
      if (!near) return;

      // 이미 가득 찼으면 상자를 쓰지 않고 남겨 둔다 (다른 친구가 주울 수 있게).
      // 예전처럼 조용히 무시하지 않고 이유를 알려 준다 — "통과하는 것처럼 보이는" 버그의 원인이었다.
      const have = P.reagents[pu.reagent] | 0;
      if (have >= RULES.REAGENT_MAX_CARRY) {
        if (now() - (P.fullWarnAt || 0) > 4000) {
          P.fullWarnAt = now();
          sendTo(P, {
            t: 'toast',
            msg: `${REAGENTS[pu.reagent].shortName} 탄알이 이미 가득 찼습니다 (${RULES.REAGENT_MAX_CARRY}발). 비커에 좀 쓰고 오세요!`,
          });
        }
        return;
      }

      pu.takenAt = now();
      P.reagents[pu.reagent] = Math.min(RULES.REAGENT_MAX_CARRY, have + RULES.REAGENT_AMMO_PER_PICKUP);
      const isNew = !P.collected[pu.reagent];
      P.collected[pu.reagent] = true;
      broadcast({ t: 'pickTaken', id: pu.id, by: P.id });
      sendTo(P, ammoMsg(P));
      if (isNew && Object.keys(P.collected).length === REAGENT_LIST.length) {
        addScore(P, RULES.SCORE_ALL_REAGENTS, '시약 4종 수집 완료');
      }
      return;
    }

    // ---------- 마취총 자격시험 ----------
    if (m.t === 'quizStart') {
      // ★ 대기 공간에서는 미리 볼 수 없다 — 게임이 시작된 뒤에만 응시
      if (phase !== 'playing') {
        sendTo(P, { t: 'quizState', passed: false, notYet: true });
        return;
      }
      if (P.quizPassed) { sendTo(P, { t: 'quizState', passed: true }); return; }
      if (now() < (P.quizUntil || 0)) {
        sendTo(P, { t: 'quizState', passed: false, waitSec: Math.ceil((P.quizUntil - now()) / 1000) });
        return;
      }
      P.quiz = makeQuiz();
      sendTo(P, {
        t: 'quiz',
        questions: P.quiz.map(q => ({ q: q.q, choices: q.choices })),
      });
      return;
    }

    if (m.t === 'quizSubmit') {
      if (phase !== 'playing') return;
      if (P.quizPassed || !P.quiz) return;
      if (now() < (P.quizUntil || 0)) return;
      const picks = Array.isArray(m.answers) ? m.answers : [];
      let wrong = 0;
      P.quiz.forEach((q, i) => { if (picks[i] !== q.answer) wrong++; });

      if (wrong === 0) {
        P.quizPassed = true;
        P.quiz = null;
        P.tranqAmmo = Math.max(P.tranqAmmo, RULES.TRANQ_START_AMMO);
        sendTo(P, { t: 'quizState', passed: true, justPassed: true });
        sendTo(P, ammoMsg(P));
        addScore(P, 15, '마취총 자격시험 합격');
        log(`🎓 ${P.nick}(${TEAM_NAMES[P.team]}) 자격시험 합격 — 마취총 해금`);
      } else {
        // 어디가 틀렸는지는 안 알려 준다. 학습지를 다시 보게 하는 게 목적.
        P.quizUntil = now() + RULES.QUIZ_RETRY_SECONDS * 1000;
        P.quiz = null;
        sendTo(P, {
          t: 'quizState', passed: false, wrong,
          waitSec: RULES.QUIZ_RETRY_SECONDS,
        });
      }
      return;
    }

    // ---------- 사격 ----------
    if (m.t === 'shoot') {
      if (P.downUntil > now()) return;

      // 대기 공간 — 연습 사격. 탄약도 안 줄고 아무도 안 맞는다.
      if (phase !== 'playing') {
        if (now() - P.lastShotAt < RULES.FIRE_COOLDOWN_MS - 40) return;
        P.lastShotAt = now();
        broadcast({
          t: 'fx', kind: 'shot', by: P.id, ammo: String(m.ammo || 'tranq'),
          o: [r2(m.ox), r2(m.oy), r2(m.oz)], h: [r2(m.hx), r2(m.hy), r2(m.hz)],
        });
        return;
      }
      if (now() < startAt) return;                    // 카운트다운 중
      if (P.lockUntil > now()) {                        // 총 압수 중
        sendTo(P, { t: 'lock', until: P.lockUntil, reason: 'abuse' });
        return;
      }
      if (now() - P.lastShotAt < RULES.FIRE_COOLDOWN_MS - 40) return;
      P.lastShotAt = now();

      const ammo = String(m.ammo || '');
      const isTranq = ammo === 'tranq';
      if (isTranq) {
        // ① 자격시험을 통과하지 않으면 마취총 자체를 쓸 수 없다
        if (!P.quizPassed) {
          if (now() - (P.quizNagAt || 0) > 3000) {
            P.quizNagAt = now();
            sendTo(P, { t: 'needQuiz' });
          }
          return;
        }
        if (P.tranqAmmo <= 0) return;
        P.tranqAmmo--;
        P.tranqFired++;
        P.tranqSinceTest++;

        // ★ 실험은 안 하고 마취총만 쏘는 학생 제재
        if (P.tranqSinceTest === RULES.TRANQ_ABUSE_WARN_AT) {
          sendTo(P, {
            t: 'toast', bad: true,
            msg: `⚠️ 비커 검사를 한 번도 안 했어요! ${RULES.TRANQ_ABUSE_LIMIT - P.tranqSinceTest}발 더 쏘면 총을 압수당합니다`,
          });
        }
        if (P.tranqSinceTest >= RULES.TRANQ_ABUSE_LIMIT) {
          P.lockUntil = now() + RULES.TRANQ_ABUSE_LOCK_SECONDS * 1000;
          P.tranqSinceTest = 0;
          sendTo(P, { t: 'lock', until: P.lockUntil, reason: 'abuse' });
          log(`🚫 ${P.nick}(${TEAM_NAMES[P.team]}) — 실험 없이 마취탄 남발 → ${RULES.TRANQ_ABUSE_LOCK_SECONDS}초 총 압수`);
          toTeachers({ t: 'abuse', nick: P.nick, team: P.team });
        }
      } else {
        if (!REAGENTS[ammo] || (P.reagents[ammo] | 0) <= 0) return;
        P.reagents[ammo]--;
      }
      sendTo(P, ammoMsg(P));

      // 총구 화염 + 탄도 이펙트는 모두에게
      broadcast({
        t: 'fx', kind: 'shot', by: P.id, ammo,
        o: [r2(m.ox), r2(m.oy), r2(m.oz)],
        h: [r2(m.hx), r2(m.hy), r2(m.hz)],
      });

      // --- 비커 명중 ---
      if (m.hit === 'beaker') {
        const bIndex = m.bi | 0;                       // 섬 위 비커 번호 (0~5)
        const beaker = LAYOUT.beakers[bIndex];
        if (!round || round.over || !beaker) return;
        if (Math.hypot(beaker.x - P.x, beaker.z - P.z) > RULES.MAX_RANGE) return;
        if (isTranq) {
          sendTo(P, { t: 'toast', msg: '마취탄은 비커에 아무 반응이 없어요. 시약 탄알로 바꿔 쏘세요!', bad: true });
          return;
        }
        const di = beaker.drink;                       // 0=A, 1=B, 2=C
        const drink = round.drinks[di];
        const reagent = REAGENTS[ammo];

        // ★ 베네딕트는 '가열'이 있어야 반응한다.
        //   식은 채로 쏘면 아무 일도 일어나지 않고, 검사 기록도 남기지 않는다.
        //   (거짓 음성을 기록으로 남기면 아이들이 틀리게 배우기 때문)
        if (reagent.needsHeat && !isHot(P)) {
          const near = nearestFire(P.x, P.z);
          sendTo(P, {
            t: 'noHeat',
            reagent: ammo,
            msg: `🔥 ${reagent.shortName} 반응은 가열해야 일어납니다 — 불에 다가가 몸을 데운 뒤 쏘세요`,
            fire: near ? { x: r2(near.f.x), z: r2(near.f.z), dist: Math.round(near.d) } : null,
          });
          return;
        }

        const positive = drink.has.includes(reagent.reactTo);

        // ★ 색 반응은 '쏜 사람의 모둠에게만' 보낸다.
        //   32명이 같은 비커에 번갈아 쏘면 남의 반응 때문에 헷갈리기 때문.
        //   (총성·탄도는 그대로 모두에게 보이므로 긴장감은 유지된다)
        toTeam(P.team, {
          t: 'beakerReact', bi: bIndex, drink: di, reagent: ammo, positive,
          color: positive ? reagent.posColor : null,
          by: P.id, nick: P.nick,
        });

        // 실험을 했으니 마취총 남용 카운터를 리셋하고 마취탄을 보상으로 준다
        const first = !P.tested[di].has(ammo);
        P.tested[di].add(ammo);
        P.tranqSinceTest = 0;
        P.testsDone++;
        const reward = first ? RULES.TRANQ_REWARD_NEW_TEST : RULES.TRANQ_REWARD_RETEST;
        const cap = tranqCap(P);
        const before = P.tranqAmmo;
        if (P.quizPassed) P.tranqAmmo = Math.min(cap, P.tranqAmmo + reward);
        const gained = P.tranqAmmo - before;
        sendTo(P, ammoMsg(P));

        if (first) addScore(P, RULES.SCORE_TEST, `비커 ${beaker.label} ${reagent.shortName} 검사`);
        if (gained > 0) {
          sendTo(P, { t: 'toast', good: true, msg: `🧪 실험 보상 — 마취탄 +${gained}발` });
        } else if (first && P.quizPassed && before >= cap) {
          sendTo(P, {
            t: 'toast',
            msg: `마취탄이 지금 상한(${cap}발)까지 찼습니다. 비커를 맞히면 상한이 올라갑니다`,
          });
        }

        toTeam(P.team, {
          t: 'testResult', bi: di, reagent: ammo, positive,
          nutrient: reagent.reactTo,
          text: positive
            ? `비커 ${beaker.label} + ${reagent.shortName} → ${reagent.posText} (양성! ${NUTRIENTS[reagent.reactTo].name} 있음)`
            : `비커 ${beaker.label} + ${reagent.shortName} → ${reagent.negText} (음성 · ${NUTRIENTS[reagent.reactTo].name} 없음)`,
          by: P.nick,
        });
        return;
      }

      // --- 사람 명중 ---
      if (m.hit === 'player') {
        const target = players.get(m.tid | 0);
        if (!target || target.id === P.id) return;
        if (target.team === P.team) return;                    // 같은 모둠은 안 맞음
        if (!isTranq) {
          sendTo(P, { t: 'toast', msg: '시약 탄알은 사람에게 효과가 없어요. 마취탄으로 바꾸세요!', bad: true });
          return;
        }
        if (target.downUntil > now()) return;
        if (Math.hypot(target.x - P.x, target.z - P.z) > RULES.TRANQ_DAMAGE_RANGE) return;

        // ★ 안전구역 — 안에 있는 사람은 안 맞고, 안에서는 쏠 수도 없다
        if (safeZoneAt(target.x, target.z)) {
          sendTo(P, { t: 'toast', msg: '상대가 안전구역(창고) 안에 있어 맞지 않습니다', bad: true });
          return;
        }
        if (safeZoneAt(P.x, P.z)) {
          sendTo(P, { t: 'toast', msg: '안전구역 안에서는 마취총을 쏠 수 없습니다', bad: true });
          return;
        }

        target.tranqHits++;
        target.lastTranqAt = now();
        sendTo(target, { t: 'hurt', by: P.nick, hits: target.tranqHits });
        sendTo(P, { t: 'hitmark', hits: target.tranqHits, nick: target.nick });

        if (target.tranqHits >= RULES.TRANQ_HITS_TO_DOWN) {
          target.tranqHits = 0;
          target.downUntil = now() + RULES.TRANQ_DOWN_SECONDS * 1000;
          // ★ 현상금 — 마취총을 쏠 '이유'가 생긴다.
          //   ① 지금 '남은 자리 경쟁' 1위  ② 이미 등수를 확정한 모둠(= 1·2등 한 애들)
          const bounty = (leaderTeam === target.team) || teamFinished(target.team);
          addScore(P, bounty ? RULES.SCORE_TRANQ_LEADER : RULES.SCORE_TRANQ,
            bounty ? `👑 선두 ${target.nick} 마취!` : `${target.nick} 마취`);
          P.downedOthers++;
          broadcast({
            t: 'down', id: target.id, until: target.downUntil,
            byNick: P.nick, nick: target.nick, bounty,
          });
          log(`💤 ${P.nick}(${TEAM_NAMES[P.team]}) → ${target.nick}(${TEAM_NAMES[target.team]}) 마취${bounty ? ' [선두 현상금]' : ''}`);
        }
        return;
      }
      return;
    }

    // ---------- 정답 제출 (모둠 공동) ----------
    // A·B·C 를 한 번에 낼 수 있다. { t:'answer', picks:{0:'milk',1:'oil',...} }
    // 옛 형식 { t:'answer', bi, drink } 도 계속 받는다.
    if (m.t === 'answer') {
      if (!round || round.over) return;
      const team = ensureTeam(P.team);

      const picks = {};
      if (m.picks && typeof m.picks === 'object') {
        for (const k of ['0', '1', '2']) if (m.picks[k]) picks[+k] = String(m.picks[k]);
      } else if (Number.isInteger(m.bi)) {
        picks[m.bi] = String(m.drink);
      }
      const targets = Object.keys(picks).map(Number).filter(bi => bi >= 0 && bi <= 2);
      if (!targets.length) return;

      // ★ 정답은 '안전구역(아무 모둠 창고든)' 안에서만 제출할 수 있다
      const zone = safeZoneAt(P.x, P.z);
      if (!zone) {
        sendTo(P, {
          t: 'toast', bad: true,
          msg: '정답은 안전구역(창고) 안에서만 제출할 수 있어요. 가장 가까운 창고로 들어가세요!',
        });
        return;
      }
      if (now() < team.wrongUntil) {
        sendTo(P, {
          t: 'toast', bad: true,
          msg: `오답 대기 중… ${Math.ceil((team.wrongUntil - now()) / 1000)}초 후 다시 제출할 수 있어요`,
        });
        return;
      }

      const results = [];
      let anyWrong = false;
      for (const bi of targets) {
        if (team.solved[bi]) {                       // 이미 맞힌 비커는 건너뛴다
          results.push({ bi, skipped: true, correct: true, guess: team.answers[bi] });
          continue;
        }
        const guess = DRINKS.find(d => d.id === picks[bi]);
        if (!guess) continue;
        const answer = round.drinks[bi];
        const correct = guess.id === answer.id;
        team.answers[bi] = guess.id;

        if (correct) {
          team.solved[bi] = true;
          team.score += RULES.SCORE_CORRECT;
          addScore(P, RULES.SCORE_CORRECT, `비커 ${'ABC'[bi]} 정답`);
          log(`✅ ${TEAM_NAMES[P.team]} — 비커 ${'ABC'[bi]} 정답 (${answer.name}) / 제출: ${P.nick}`);
          broadcast({ t: 'solved', team: P.team, bi, nick: P.nick });
        } else {
          anyWrong = true;
          team.score += RULES.SCORE_WRONG;
          addScore(P, RULES.SCORE_WRONG, `비커 ${'ABC'[bi]} 오답`);
        }
        results.push({ bi, correct, guess: guess.id, guessName: guess.name });
      }

      // ★ 오답 대기 — 처음 틀린 건 거의 벌이 없고, 계속 찍으면 길어진다
      let cooldownSec = 0;
      if (anyWrong) {
        team.wrongStreak = (team.wrongStreak | 0) + 1;
        const steps = RULES.WRONG_COOLDOWN_STEPS || [RULES.WRONG_ANSWER_COOLDOWN];
        cooldownSec = steps[Math.min(team.wrongStreak - 1, steps.length - 1)];
        team.wrongUntil = now() + cooldownSec * 1000;
      } else {
        team.wrongStreak = 0;              // 하나라도 맞히면 초기화
      }

      // 모둠 전체에게 채점 결과를 보낸다 (정답 이름은 맞힌 것만 공개)
      toTeam(P.team, {
        t: 'answerResult',
        by: P.nick,
        results: results.map(r => ({
          bi: r.bi,
          correct: r.correct,
          skipped: !!r.skipped,
          guessName: r.guessName,
          // 맞힌 비커만 진짜 이름을 알려 준다 — 틀린 건 스스로 다시 추리해야 함
          answerName: r.correct && !r.skipped ? round.drinks[r.bi].name : null,
        })),
        cooldown: cooldownSec,
        cooldownUntil: anyWrong ? team.wrongUntil : 0,
        solved: team.solved,
      });

      // 마취탄 상한이 올라갔을 수 있으니 모둠원 탄약 정보를 갱신
      for (const id of team.members) {
        const q = players.get(id);
        if (q) sendTo(q, ammoMsg(q));
      }

      // ★ 3개를 다 맞혔다면 그 '순간'에 등수가 확정된다 (순위 = 완주 순서)
      if (!team.finishOrder && Object.keys(team.solved).length === 3) {
        finishTeam(team);
      }

      broadcast(roster());
      toTeachers(teacherKey());
      checkRoundEnd();
      return;
    }

    // ---------- 교사 화면 송출 : 상태값(작다) ----------
    //  그림 자체는 바로 뒤에 '바이너리 프레임'으로 따라온다.
    //  (예전에는 base64 로 JSON 안에 실어 보냈는데, 태블릿에서 인코딩이 무거웠다)
    if (m.t === 'frameStat') {
      const watchers = watchedBy(P.id);
      if (!watchers.length) return;
      P.framePending = true;
      const payload = JSON.stringify({
        t: 'frameStat', id: P.id, nick: P.nick, team: P.team,
        st: m.st || {}, fps: +m.fps || 0, cost: +m.cost || 0,
      });
      for (const t of watchers) { try { t.send(payload); } catch { /* */ } }
      return;
    }

    // ---------- 모둠 빠른 대화 ----------
    if (m.t === 'quick') {
      const presets = [
        '여기 시약 있어!', '비커 A 간다', '비커 B 간다', '비커 C 간다',
        '도와줘!', '적 발견!', '나 마취됐어', '정답 알 것 같아',
      ];
      const battlePresets = [
        '여기 총 있어!', '탄약 좀!', '구급품 있어?', '같이 가자',
        '도와줘!', '적 발견!', '나 쓰러졌어', '자기장 안으로!',
      ];
      const msg = (mode === 'battle' ? battlePresets : presets)[m.i | 0];
      if (!msg) return;
      if (mode === 'battle') {
        // 슈팅 모드에서는 '같은 분대'끼리만
        const s = battle.S.squads[P.squad];
        for (const id of (s ? s.members : [])) {
          const q = players.get(id);
          if (q) sendTo(q, { t: 'quick', nick: P.nick, msg });
        }
        return;
      }
      toTeam(P.team, { t: 'quick', nick: P.nick, msg });
      return;
    }
  });

  // ---------- 교사 화면 송출 : JPEG 그림 (바이너리) ----------
  ws.on('binary', (buf) => {
    if (!me || isTeacher) return;
    if (!buf || buf.length < 8 || buf.length > 300000) return;
    if (!me.framePending) return;                     // frameStat 뒤에 오는 것만 인정
    me.framePending = false;
    for (const t of watchedBy(me.id)) { try { t.sendBinary(buf); } catch { /* */ } }
  });

  ws.on('close', () => {
    if (isTeacher) { teachers.delete(ws); setWatch(ws, null); return; }
    if (me) {
      battle.onLeave(me);
      ensureTeam(me.team).members.delete(me.id);
      players.delete(me.id);
      for (const [tws, id] of watching) if (id === me.id) watching.delete(tws);
      log(`－ ${me.nick} 퇴장`);
      broadcast(roster());
    }
  });
});

function r2(v) { return Math.round((+v || 0) * 100) / 100; }

// ------------------------------------------------------------
//  교사가 학생 화면을 들여다보는 기능
//  선택된 학생에게만 '송출 켜기'를 보내므로 평소 통신량은 그대로다.
// ------------------------------------------------------------
const watching = new Map();       // 교사 ws -> 보고 있는 학생 id

function watchedBy(playerId) {
  const out = [];
  for (const [ws, id] of watching) if (id === playerId) out.push(ws);
  return out;
}

function refreshStreams() {
  const wanted = new Set(watching.values());
  for (const p of players.values()) {
    const on = wanted.has(p.id);
    if (!!p.streaming === on) continue;
    p.streaming = on;
    if (!on) p.framePending = false;
    sendTo(p, { t: 'stream', on, fps: RULES.WATCH_FPS });
  }
}

function setWatch(ws, id) {
  if (id === null) watching.delete(ws);
  else watching.set(ws, id);
  refreshStreams();
}

// 모둠이 맞힌 비커 수에 따라 마취탄 보유 상한이 올라간다 (진도 = 화력)
function tranqCap(p) {
  const solved = Object.keys(ensureTeam(p.team).solved).length;
  const caps = RULES.TRANQ_CAP_BY_SOLVED;
  return Math.min(RULES.TRANQ_MAX_AMMO, caps[Math.min(solved, caps.length - 1)]);
}

function ammoMsg(p) {
  return {
    t: 'ammo',
    reagents: p.reagents,
    tranq: p.tranqAmmo,
    collected: p.collected,
    tranqCap: tranqCap(p),
    quizPassed: !!p.quizPassed,
  };
}

// ============================================================
//  ★ 가열 — 베네딕트 반응 조건
//  불꽃 반경 안에 들어오면 heatUntil 을 갱신한다. 판정은 전부 서버에서 한다.
// ============================================================
function isHot(p) { return p.heatUntil > now(); }

function nearestFire(x, z) {
  let f = null, d = Infinity;
  for (const c of (LAYOUT.fires || [])) {
    const dd = Math.hypot(c.x - x, c.z - z);
    if (dd < d) { d = dd; f = c; }
  }
  return f ? { f, d } : null;
}

// 점 (px,pz) 와 선분 (ax,az)-(bx,bz) 사이의 최단 거리
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  if (L2 < 1e-6) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

// fromX/fromZ 가 있으면 '지나온 길'까지 검사한다 (프레임이 끊겨도 불을 놓치지 않게)
function touchFire(p, fromX, fromZ) {
  const R = RULES.HEAT_RADIUS;
  const useSeg = Number.isFinite(fromX) && Number.isFinite(fromZ);
  for (const f of (LAYOUT.fires || [])) {
    const dist = useSeg
      ? segDist(f.x, f.z, fromX, fromZ, p.x, p.z)
      : Math.hypot(f.x - p.x, f.z - p.z);
    if (dist > R) continue;
    const was = isHot(p);
    p.heatUntil = now() + RULES.HEAT_SECONDS * 1000;
    if (!was) {
      sendTo(p, {
        t: 'heat', until: p.heatUntil, seconds: RULES.HEAT_SECONDS, lit: true,
        msg: `🔥 몸에 불이 붙었습니다 — ${RULES.HEAT_SECONDS}초 안에 베네딕트를 쏘세요`,
      });
    } else {
      sendTo(p, { t: 'heat', until: p.heatUntil, seconds: RULES.HEAT_SECONDS });
    }
    return true;
  }
  return false;
}

function addScore(p, pts, why) {
  p.score += pts;
  sendTo(p, { t: 'score', score: p.score, delta: pts, why });
}

function teacherKey() {
  return {
    t: 'teacherInit',
    round: round ? roundPublic() : null,
    answerKey: round ? round.drinks.map((d, i) => ({ label: 'ABC'[i], name: d.name, has: d.has })) : [],
    drinks: DRINKS, reagents: REAGENTS, nutrients: NUTRIENTS, rules: RULES, logs,
    urls: localIPs().map(ip => `http://${ip}:${PORT}`),
    phase, mode, battle: BATTLE, guns: GUNS,
  };
}

// 완주 순서 우선, 그 다음 진행률 — '먼저 다 맞힌 팀이 1등'
function rankedTeams() {
  return teams.filter(t => t.members.size > 0).sort((a, b) => {
    const fa = a.finishOrder || 99, fb = b.finishOrder || 99;
    if (fa !== fb) return fa - fb;
    const pa = teamProgress(a), pb = teamProgress(b);
    if (pa.solved !== pb.solved) return pb.solved - pa.solved;
    if (pa.tested !== pb.tested) return pb.tested - pa.tested;
    return pb.score - pa.score;
  });
}

function revealAnswers() {
  phase = 'over';
  broadcast(phaseMsg());
  broadcast({
    t: 'reveal',
    answers: round.drinks.map((d, i) => ({
      label: 'ABC'[i], id: d.id, name: d.name, has: d.has,
    })),
    // ★ 순위는 '음료 3개를 먼저 다 맞춘 순서'.
    //   완주하지 못한 모둠은 그 뒤로, 진행률(맞힌 비커 → 검사 조합 → 점수) 순.
    ranking: rankedTeams().map((t, i) => {
      const pr = teamProgress(t);
      return {
        rank: i + 1,
        team: t.index,
        name: TEAM_NAMES[t.index] || `${t.index + 1}모둠`,
        color: TEAM_COLORS[t.index % TEAM_COLORS.length],
        colorName: TEAM_COLOR_NAMES[t.index % TEAM_COLOR_NAMES.length],
        members: [...t.members].map(id => players.get(id)?.nick).filter(Boolean),
        score: t.score,
        solved: pr.solved,
        tested: pr.tested,
        finishOrder: t.finishOrder || null,
        seconds: t.finishedAt && round
          ? Math.max(0, Math.round((t.finishedAt - round.startedAt) / 1000)) : null,
      };
    }),
  });
  const top = rankedTeams().slice(0, 3)
    .map((t, i) => `${['🥇', '🥈', '🥉'][i]} ${TEAM_NAMES[t.index]}`).join('  ');
  log(`🏁 라운드 종료 — 정답 공개 · ${top}`);
}

function checkRoundEnd() {
  if (!round || round.over) return;
  const active = teams.filter(t => t.members.size > 0);
  if (!active.length) return;

  // ★ 3등까지 나오면 자동 종료 (또는 남은 모둠이 모두 완주했으면)
  const done = active.filter(t => t.finishOrder).length;
  const podium = Math.min(RULES.PODIUM_SIZE, active.length);
  if (done >= podium || active.every(t => t.finishOrder)) {
    round.over = true;
    clearLeader();
    broadcast({ t: 'round', round: roundPublic() });
    revealAnswers();
  }
}

// ------------------------------------------------------------
//  게임 루프
// ------------------------------------------------------------
setInterval(() => {
  if (!players.size) return;
  const list = [];
  for (const p of players.values()) {
    // 슈팅 모드에서는 '쓰러진 상태'를 같은 비트(32)로 보낸다
    const down = (p.downUntil > now() || (mode === 'battle' && p.deadUntil > now())) ? 1 : 0;
    list.push([
      p.id,
      Math.round(p.x * 20) / 20,
      Math.round(p.y * 20) / 20,
      Math.round(p.z * 20) / 20,
      Math.round(p.yaw * 100) / 100,
      Math.round(p.pitch * 100) / 100,
      (p.flags & 0x1f) | (down ? 32 : 0) | (isHot(p) ? 64 : 0),   // 64 = 몸에 불이 붙은 상태
    ]);
  }
  broadcast({ t: 's', p: list });
}, 1000 / TICK_HZ);

// 1초 주기: 마취 해제/누적 감소, 마취탄 보급, 시약 리스폰, 라운드 시간
let regenTick = 0;
setInterval(() => {
  const T = now();
  regenTick++;

  // ★ 슈팅 모드일 때는 실험 모드의 회복/보급/라운드 처리를 하지 않는다
  if (mode === 'battle') {
    battle.tick1s();
    if (regenTick % 3 === 0) toTeachers(roster());
    return;
  }

  for (const p of players.values()) {
    if (p.downUntil && p.downUntil <= T) {
      p.downUntil = 0;
      p.tranqHits = 0;
      sendTo(p, { t: 'wake' });
      broadcast({ t: 'up', id: p.id });
    }
    if (p.tranqHits > 0 && T - p.lastTranqAt > RULES.TRANQ_DECAY_SECONDS * 1000) {
      p.tranqHits--; p.lastTranqAt = T;
      sendTo(p, { t: 'hurt', hits: p.tranqHits, decay: true });
    }
    // 총 압수 해제
    if (p.lockUntil && p.lockUntil <= T) {
      p.lockUntil = 0;
      sendTo(p, { t: 'lock', until: 0 });
    }
    // ★ 불이 꺼짐 — 베네딕트를 다시 쏘려면 불에 또 다가가야 한다
    if (p.heatUntil && p.heatUntil <= T) {
      p.heatUntil = 0;
      sendTo(p, { t: 'heat', until: 0, msg: '🔥 불이 꺼졌습니다 — 베네딕트를 쏘려면 다시 데워야 합니다' });
    }
    // 마취탄은 아주 느리게만 회복된다 (완전히 떨어진 학생 구제용).
    // 제대로 채우려면 비커에 시약을 쏴야 한다 — 그게 이 게임의 보상 구조.
    if (p.quizPassed && regenTick % RULES.TRANQ_REGEN_SECONDS === 0 && p.tranqAmmo < RULES.TRANQ_START_AMMO) {
      p.tranqAmmo++;
      sendTo(p, ammoMsg(p));
    }
  }

  // ★ 선두 모둠 공개 (마취 현상금 대상)
  tickLeader(T);

  const respawned = [];
  for (const pu of pickups) {
    if (pu.takenAt && T - pu.takenAt >= RULES.PICKUP_RESPAWN_SECONDS * 1000) {
      pu.takenAt = 0; respawned.push(pu.id);
    }
  }
  if (respawned.length) broadcast({ t: 'pickBack', ids: respawned });

  if (round && !round.over && T >= round.endsAt) {
    round.over = true;
    broadcast({ t: 'round', round: roundPublic() });
    revealAnswers();
  }

  if (regenTick % 3 === 0) toTeachers(roster());
}, 1000);

// ------------------------------------------------------------
//  시작
// ------------------------------------------------------------
function localIPs() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = localIPs();
  const line = '═'.repeat(58);
  console.log(`\n${line}`);
  console.log('  Project_Godeok — 영양소 검출 배틀로얄  서버 실행 중');
  console.log(line);
  console.log('  학생 태블릿에서 아래 주소로 접속하세요 (같은 와이파이):\n');
  if (ips.length === 0) console.log(`     http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`     ➜  http://${ip}:${PORT}`));
  console.log(`\n  선생님 화면(순위·정답):  http://localhost:${PORT}/teacher`);
  console.log(`  인쇄용 학습지        :  http://localhost:${PORT}/worksheet`);
  console.log(`${line}\n`);
  prepareRound();
  console.log('  ※ 학생들은 접속하면 대기 공간에서 조작을 연습합니다.');
  console.log('    선생님 화면에서 [게임 시작]을 눌러야 다같이 출발합니다.\n');
});

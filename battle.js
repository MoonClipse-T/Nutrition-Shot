// ============================================================
//  battle.js — ★ 슈팅 모드(남는 시간용) 서버 로직
//
//  실험 모드와 완전히 분리되어 있습니다. 선생님이 [슈팅 모드]를 눌렀을 때만
//  켜지고, [실험 모드로 돌아가기]를 누르면 원래 수업으로 되돌아갑니다.
//
//  판정은 전부 여기(서버)에서 합니다 — 체력, 명중, 탄약, 자기장, 부활.
//  학생 태블릿이 보내는 값은 '어디를 쐈다'까지만 믿습니다.
// ============================================================
import {
  BATTLE, GUNS, GUN_DROP, LOOT_KINDS, SQUAD_COLORS, SQUAD_COLOR_NAMES, zoneAt,
} from './public/js/battledata.js';
import { LAYOUT, MAP, TRAIN, terrainHeight, trainingSpawn } from './public/js/layout.js';

const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export function makeBattle(ctx) {
  // ctx: { players, broadcast, sendTo, toTeachers, log }
  const { players, broadcast, sendTo, toTeachers, log } = ctx;

  // 근처 사람에게만 보내기 (총격 이펙트처럼 자주 나가는 것)
  function broadcastNear(x, z, r, obj) {
    const s = JSON.stringify(obj);
    for (const p of players.values()) {
      if (Math.hypot(p.x - x, p.z - z) > r) continue;
      try { p.ws.send(s); } catch { /* */ }
    }
  }

  const S = {
    on: false,                 // 슈팅 모드가 켜져 있는가
    phase: 'lobby',            // lobby | playing | over
    startAt: 0,
    endsAt: 0,
    squads: [],                // [{index, members:Set}]
    loot: [],                  // {id, x, y, z, kind, gun, takenAt}
    zone: { x: 0, z: 0, r: MAP.PLAY_R, dps: 0, stage: 0 },
    hops: [],                  // 자기장 중심 이동 경로
  };

  // ---------------- 분대 ----------------
  function ensureSquad(i) {
    while (S.squads.length <= i) S.squads.push({ index: S.squads.length, members: new Set() });
    return S.squads[i];
  }
  function squadOf(p) { return S.squads[p.squad] || null; }
  function leaveSquad(p) {
    const s = squadOf(p);
    if (s) s.members.delete(p.id);
  }
  // 비어 있는 분대 칸을 하나 준다 (= 혼자 하기)
  function soloSquad(p) {
    leaveSquad(p);
    for (let i = 0; i < BATTLE.SQUAD_SLOTS; i++) {
      const s = ensureSquad(i);
      if (s.members.size === 0) { s.members.add(p.id); p.squad = i; return i; }
    }
    const s = ensureSquad(S.squads.length);
    s.members.add(p.id); p.squad = s.index;
    return s.index;
  }
  function joinSquad(p, i) {
    if (!Number.isInteger(i) || i < 0 || i >= BATTLE.SQUAD_SLOTS) return false;
    const s = ensureSquad(i);
    if (s.members.has(p.id)) return true;
    if (s.members.size >= BATTLE.SQUAD_MAX) {
      sendTo(p, { t: 'toast', bad: true, msg: `그 분대는 이미 ${BATTLE.SQUAD_MAX}명이 꽉 찼어요` });
      return false;
    }
    leaveSquad(p);
    s.members.add(p.id);
    p.squad = i;
    return true;
  }

  function squadsPublic() {
    return {
      t: 'bsquads',
      max: BATTLE.SQUAD_MAX,
      squads: S.squads.map(s => ({
        index: s.index,
        color: SQUAD_COLORS[s.index % SQUAD_COLORS.length],
        colorName: SQUAD_COLOR_NAMES[s.index % SQUAD_COLOR_NAMES.length],
        kills: s.kills | 0,
        members: [...s.members].map(id => {
          const q = players.get(id);
          return q ? { id: q.id, nick: q.nick, kills: q.kills | 0, deaths: q.deaths | 0 } : null;
        }).filter(Boolean),
      })),
    };
  }
  function pushSquads() { broadcast(squadsPublic()); }

  // ---------------- 보급 상자 ----------------
  function rollLoot() {
    S.loot = LAYOUT.pickups.map(p => {
      const kind = pick(LOOT_KINDS);
      return {
        id: p.id, x: p.x, y: p.y, z: p.z,
        kind, gun: kind === 'gun' ? pick(GUN_DROP) : null,
        takenAt: 0,
      };
    });
  }
  function lootPublic() {
    return S.loot.map(l => ({ id: l.id, x: l.x, y: l.y, z: l.z, kind: l.kind, gun: l.gun }));
  }

  // ---------------- 플레이어 초기화 ----------------
  function resetPlayer(p, full) {
    p.hp = BATTLE.MAX_HP;
    // ★ 가방(장비창) — 쓰러지면 권총만 남기고 초기화한다.
    //   총을 여러 자루 들고 다니면서 장비창에서 골라 끼울 수 있다.
    p.guns = ['pistol'];
    p.mags = { pistol: GUNS.pistol.mag };
    p.gun = 'pistol';
    p.mag = GUNS.pistol.mag;
    p.ammo = Math.max(p.ammo | 0, BATTLE.START_AMMO);
    p.meds = Math.max(p.meds | 0, 1);
    p.reloadUntil = 0;
    p.medUntil = 0;
    p.deadUntil = 0;
    p.lastFireAt = 0;
    if (full) { p.kills = 0; p.deaths = 0; p.dmgDone = 0; }
  }

  function ammoMsg(p) {
    const g = GUNS[p.gun] || GUNS.pistol;
    return {
      t: 'bammo', hp: p.hp | 0, gun: p.gun, mag: p.mag | 0, magSize: g.mag,
      ammo: p.ammo | 0, meds: p.meds | 0,
      reloadUntil: p.reloadUntil || 0, medUntil: p.medUntil || 0,
      kills: p.kills | 0, deaths: p.deaths | 0,
      guns: (p.guns || ['pistol']).slice(),
      mags: { ...(p.mags || {}) },
      bag: BATTLE.BAG_SIZE,
    };
  }

  // ---------------- 장비창 : 장착 / 버리기 ----------------
  function equip(p, id) {
    if (!S.on || S.phase !== 'playing' || p.deadUntil > now()) return;
    if (!GUNS[id] || !(p.guns || []).includes(id)) return;
    if (p.gun === id) return;
    // 지금 총의 탄창을 가방에 저장해 두고 바꾼다
    p.mags = p.mags || {};
    p.mags[p.gun] = p.mag | 0;
    p.gun = id;
    p.mag = p.mags[id] | 0;
    p.reloadUntil = 0;
    p.lastFireAt = now();                  // 바꾸자마자 난사하지 못하게 한 박자
    sendTo(p, ammoMsg(p));
    sendTo(p, { t: 'toast', good: true, msg: `${GUNS[id].name} 장착` });
    if (p.mag <= 0) startReload(p, GUNS[id]);
  }

  function drop(p, id) {
    if (!S.on || S.phase !== 'playing' || p.deadUntil > now()) return;
    const bag = p.guns || [];
    if (!bag.includes(id)) return;
    if (bag.length <= 1) {
      sendTo(p, { t: 'toast', bad: true, msg: '마지막 총은 버릴 수 없어요' });
      return;
    }
    p.guns = bag.filter(x => x !== id);
    if (p.mags) delete p.mags[id];
    if (p.gun === id) {
      // 버린 게 지금 든 총이면 가방에서 제일 좋은 것으로 자동 교체
      const next = [...p.guns].sort((a, b) => GUNS[b].tier - GUNS[a].tier)[0];
      p.gun = next;
      p.mag = (p.mags && p.mags[next]) | 0;
      p.reloadUntil = 0;
      if (p.mag <= 0) startReload(p, GUNS[next]);
    }
    sendTo(p, ammoMsg(p));
    sendTo(p, { t: 'toast', msg: `${GUNS[id].name} 버림` });
  }

  // 스폰 — 안전지대 안쪽에서, 적과 최대한 먼 곳
  function spawnPoint(p) {
    let best = null, bestD = -1;
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * Math.max(12, S.zone.r * 0.8);
      const x = S.zone.x + Math.cos(a) * r;
      const z = S.zone.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > MAP.PLAY_R - 8) continue;
      let d = 1e9;
      for (const q of players.values()) {
        if (q.id === p.id || q.squad === p.squad) continue;
        if (q.deadUntil > now()) continue;
        d = Math.min(d, Math.hypot(q.x - x, q.z - z));
      }
      if (d > bestD) { bestD = d; best = { x, z }; }
      if (bestD > 60) break;
    }
    if (!best) best = { x: 0, z: 0 };
    return {
      x: best.x, z: best.z, y: terrainHeight(best.x, best.z) + 0.2,
      yaw: Math.atan2(S.zone.x - best.x, S.zone.z - best.z),
    };
  }

  function sendSpawn(p) {
    const sp = spawnPoint(p);
    p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw;
    sendTo(p, { t: 'spawn', spawn: sp, battle: true });
  }

  // ---------------- 모드 켜기 / 끄기 ----------------
  function enterLobby() {
    S.on = true;
    S.phase = 'lobby';
    S.startAt = 0; S.endsAt = 0;
    S.squads = [];
    for (let i = 0; i < BATTLE.SQUAD_SLOTS; i++) ensureSquad(i);
    for (const p of players.values()) {
      p.squad = -1;
      resetPlayer(p, true);
      soloSquad(p);
      const sp = trainingSpawn(p.id);
      p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw;
      sendTo(p, { t: 'spawn', spawn: sp, training: true });
      sendTo(p, ammoMsg(p));
    }
    if (!S.loot.length) rollLoot();
    broadcast(stateMsg());
    pushSquads();
    log('⚔ 슈팅 모드 — 전원 로비(대기 공간)로. 분대를 짜는 중입니다');
  }

  function start() {
    if (!S.on) enterLobby();
    S.phase = 'playing';
    S.startAt = now() + BATTLE.START_COUNTDOWN * 1000;
    S.endsAt = S.startAt + BATTLE.SECONDS * 1000;

    // 자기장 중심 — 첫 원은 섬 중앙 근처, 이후엔 이전 원 안쪽으로 좁혀 간다
    S.hops = [];
    let cx = (Math.random() - 0.5) * 90, cz = (Math.random() - 0.5) * 90;
    let r = MAP.PLAY_R;
    S.hops.push({ x: cx, z: cz, r });
    for (const z of BATTLE.ZONE) {
      const a = Math.random() * Math.PI * 2;
      const off = Math.random() * Math.max(0, r - z.to) * 0.55;
      cx += Math.cos(a) * off; cz += Math.sin(a) * off;
      const d = Math.hypot(cx, cz);
      if (d + z.to > MAP.PLAY_R - 10) {
        const k = (MAP.PLAY_R - 10 - z.to) / (d || 1);
        cx *= k; cz *= k;
      }
      r = z.to;
      S.hops.push({ x: cx, z: cz, r });
    }
    S.zone = { x: S.hops[0].x, z: S.hops[0].z, r: MAP.PLAY_R, dps: 0, stage: 0 };

    rollLoot();
    for (const s of S.squads) s.kills = 0;
    for (const p of players.values()) {
      if (p.squad === undefined || p.squad < 0) soloSquad(p);
      resetPlayer(p, true);
      sendSpawn(p);
      sendTo(p, ammoMsg(p));
    }
    broadcast(stateMsg());
    broadcast({ t: 'bloot', loot: lootPublic() });
    pushSquads();
    const alone = S.squads.filter(s => s.members.size === 1).length;
    const teamed = S.squads.filter(s => s.members.size > 1).length;
    log(`⚔ 슈팅 시작 — ${players.size}명 · 혼자 ${alone}명 · 분대 ${teamed}팀 · ${BATTLE.SECONDS / 60}분`);
  }

  function end(reason) {
    if (!S.on || S.phase === 'over') return;
    S.phase = 'over';
    broadcast(stateMsg());
    broadcast({ t: 'bover', ranking: ranking(), reason: reason || '' });
    const top = ranking().slice(0, 3)
      .map((r, i) => `${['🥇', '🥈', '🥉'][i]} ${r.colorName}(${r.kills}킬)`).join('  ');
    log(`🏁 슈팅 모드 종료 — ${top}`);
  }

  function leave() {                      // 실험 모드로 복귀
    S.on = false;
    S.phase = 'lobby';
    for (const p of players.values()) { p.squad = -1; p.deadUntil = 0; }
  }

  function ranking() {
    return S.squads
      .filter(s => s.members.size > 0)
      .map(s => ({
        index: s.index,
        color: SQUAD_COLORS[s.index % SQUAD_COLORS.length],
        colorName: SQUAD_COLOR_NAMES[s.index % SQUAD_COLOR_NAMES.length],
        kills: s.kills | 0,
        deaths: [...s.members].reduce((a, id) => a + (players.get(id)?.deaths | 0), 0),
        members: [...s.members].map(id => {
          const q = players.get(id);
          return q ? { nick: q.nick, kills: q.kills | 0, deaths: q.deaths | 0 } : null;
        }).filter(Boolean),
      }))
      .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths))
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  function stateMsg() {
    return {
      t: 'bstate',
      on: S.on, phase: S.phase,
      startAt: S.startAt, endsAt: S.endsAt,
      countdown: BATTLE.START_COUNTDOWN,
      zone: { x: r2(S.zone.x), z: r2(S.zone.z), r: r2(S.zone.r), dps: S.zone.dps, stage: S.zone.stage },
      next: S.zone.next || null,
      squadMax: BATTLE.SQUAD_MAX, slots: BATTLE.SQUAD_SLOTS,
    };
  }

  // ---------------- 입장 / 퇴장 ----------------
  function onJoin(p) {
    if (!S.on) return;
    resetPlayer(p, true);
    soloSquad(p);
    if (S.phase === 'playing') sendSpawn(p);
    sendTo(p, stateMsg());
    sendTo(p, { t: 'bloot', loot: lootPublic() });
    sendTo(p, ammoMsg(p));
    pushSquads();
  }
  function onLeave(p) {
    if (!S.on) return;
    leaveSquad(p);
    pushSquads();
  }

  // ---------------- 보급 상자 줍기 ----------------
  function tryLoot(p, id, cx, cz) {
    if (!S.on || S.phase !== 'playing' || p.deadUntil > now()) return;
    const l = S.loot[id | 0];
    if (!l) return;
    if (l.takenAt && now() - l.takenAt < BATTLE.LOOT_RESPAWN_SECONDS * 1000) return;

    const R = BATTLE.LOOT_RADIUS + 3;
    let near = Math.hypot(l.x - p.x, l.z - p.z) <= R;
    if (!near && Number.isFinite(cx) && Number.isFinite(cz) &&
        Math.hypot(cx, cz) < MAP.PLAY_R + 10 && Math.hypot(l.x - cx, l.z - cz) <= R) {
      near = true; p.x = cx; p.z = cz; p.desync = 0;
    }
    if (!near) return;

    let took = false, msg = '';
    if (l.kind === 'gun') {
      const g = GUNS[l.gun];
      p.guns = p.guns || ['pistol'];
      p.mags = p.mags || {};
      const cur = GUNS[p.gun] || GUNS.pistol;
      // ★ 총은 '가방'에 들어간다. 이미 같은 총이 있거나 가방이 꽉 차면 그냥 둔다.
      if (g && !p.guns.includes(g.id) && p.guns.length < BATTLE.BAG_SIZE) {
        p.guns.push(g.id);
        const load = Math.min(g.mag, p.ammo | 0);
        p.mags[g.id] = load;
        p.ammo = Math.max(0, (p.ammo | 0) - load);
        took = true;
        // 지금 든 총보다 좋으면 바로 손에 쥐어 준다 (달리다 총이 나빠지는 일은 없다).
        // 나쁜 총이면 가방에만 넣어 두고, 🎒 장비창에서 직접 골라 끼울 수 있다.
        if (g.tier > cur.tier) {
          p.mags[p.gun] = p.mag | 0;
          p.gun = g.id;
          p.mag = p.mags[g.id] | 0;
          p.reloadUntil = 0;
          msg = `${g.name} 장착! (${g.dmg}데미지 · ${g.mag}발)`;
        } else {
          msg = `${g.name} 가방에 넣음 — 🎒 장비창에서 바꿀 수 있어요`;
        }
      } else if (g && p.guns.includes(g.id)) {
        // 이미 있는 총이면 탄약만 조금 챙긴다
        if ((p.ammo | 0) < BATTLE.AMMO_MAX) {
          p.ammo = Math.min(BATTLE.AMMO_MAX, (p.ammo | 0) + Math.round(BATTLE.AMMO_PER_BOX / 2));
          took = true;
          msg = `${g.name}은 이미 있어요 — 탄약만 +${Math.round(BATTLE.AMMO_PER_BOX / 2)}발`;
        }
      }
    } else if (l.kind === 'ammo') {
      if ((p.ammo | 0) < BATTLE.AMMO_MAX) {
        p.ammo = Math.min(BATTLE.AMMO_MAX, (p.ammo | 0) + BATTLE.AMMO_PER_BOX);
        took = true;
        msg = `탄약 +${BATTLE.AMMO_PER_BOX}발 (${p.ammo}발)`;
      }
    } else if (l.kind === 'med') {
      if ((p.meds | 0) < BATTLE.MED_MAX) {
        p.meds = (p.meds | 0) + 1;
        took = true;
        msg = `구급품 획득 (${p.meds}/${BATTLE.MED_MAX})`;
      }
    }
    if (!took) return;

    l.takenAt = now();
    broadcast({ t: 'blootTaken', id: l.id, by: p.id });
    sendTo(p, ammoMsg(p));
    sendTo(p, { t: 'toast', good: true, msg });
  }

  // ---------------- 구급품 ----------------
  function useMed(p) {
    if (!S.on || S.phase !== 'playing' || p.deadUntil > now()) return;
    if ((p.meds | 0) <= 0) { sendTo(p, { t: 'toast', bad: true, msg: '구급품이 없어요' }); return; }
    if (p.hp >= BATTLE.MAX_HP) { sendTo(p, { t: 'toast', msg: '체력이 이미 가득입니다' }); return; }
    if (now() < (p.medUntil || 0)) return;
    p.meds--;
    p.medUntil = now() + BATTLE.MED_USE_MS;
    setTimeout(() => {
      if (!S.on || p.deadUntil > now()) return;
      p.hp = clamp(p.hp + BATTLE.HEAL, 0, BATTLE.MAX_HP);
      sendTo(p, ammoMsg(p));
      sendTo(p, { t: 'toast', good: true, msg: `🧰 체력 회복 (+${BATTLE.HEAL})` });
    }, BATTLE.MED_USE_MS);
    sendTo(p, ammoMsg(p));
  }

  // ---------------- 사격 ----------------
  function shoot(p, m) {
    if (!S.on || S.phase !== 'playing') return;
    if (p.deadUntil > now()) return;
    if (now() < S.startAt) return;

    const g = GUNS[p.gun] || GUNS.pistol;
    const T = now();

    // 재장전 진행 중이면 끝났는지 확인
    if (p.reloadUntil) {
      if (T < p.reloadUntil) return;
      finishReload(p, g);
    }
    if ((p.mag | 0) <= 0) { startReload(p, g); return; }
    if (T - (p.lastFireAt || 0) < g.cd - 35) return;
    p.lastFireAt = T;
    p.mag--;

    // ★ 총격 이펙트는 '근처 사람에게만' 보낸다.
    //   30명이 기관단총을 난사하면 전원 브로드캐스트는 초당 수천 건이 되어
    //   학교 와이파이가 먼저 무너진다. 어차피 200m 밖 탄도는 보이지도 않는다.
    broadcastNear(p.x, p.z, 150, {
      t: 'bfx', by: p.id, gun: p.gun,
      o: [r2(m.ox), r2(m.oy), r2(m.oz)], h: [r2(m.hx), r2(m.hy), r2(m.hz)],
    });

    if (m.hit === 'player') {
      const target = players.get(m.tid | 0);
      if (target && target.id !== p.id && target.squad !== p.squad &&
          !(target.deadUntil > now())) {
        const d = Math.hypot(target.x - p.x, target.z - p.z);
        if (d <= g.range + BATTLE.HIT_RANGE_SLACK) {
          // 샷건은 멀수록 약해진다 (근접전 무기라는 걸 몸으로 알게)
          let dmg = g.dmg;
          if (g.id === 'shotgun') dmg = Math.round(dmg * clamp(1 - d / g.range, 0.25, 1));
          damage(target, dmg, p);
        }
      }
    }
    if (p.mag <= 0) startReload(p, g);
    sendTo(p, ammoMsg(p));
  }

  function startReload(p, g) {
    if (p.reloadUntil) return;
    if ((p.ammo | 0) <= 0) {
      if (now() - (p.dryAt || 0) > 2500) {
        p.dryAt = now();
        sendTo(p, { t: 'toast', bad: true, msg: '탄약이 없습니다! 📦 탄약 상자를 찾으세요' });
      }
      return;
    }
    p.reloadUntil = now() + g.reload;
    sendTo(p, ammoMsg(p));
    setTimeout(() => {
      if (!S.on || !p.reloadUntil || now() < p.reloadUntil - 30) return;
      finishReload(p, GUNS[p.gun] || GUNS.pistol);
      sendTo(p, ammoMsg(p));
    }, g.reload + 40);
  }
  function finishReload(p, g) {
    const need = g.mag - (p.mag | 0);
    const take = Math.min(need, p.ammo | 0);
    p.mag = (p.mag | 0) + take;
    p.ammo = (p.ammo | 0) - take;
    p.reloadUntil = 0;
  }

  function damage(target, dmg, by) {
    target.hp = (target.hp | 0) - dmg;
    if (by) by.dmgDone = (by.dmgDone | 0) + dmg;
    if (target.hp > 0) {
      sendTo(target, { t: 'bhurt', hp: target.hp, by: by ? by.nick : null, dmg });
      if (by) sendTo(by, { t: 'bhit', hp: target.hp, nick: target.nick, dmg });
      return;
    }
    kill(target, by);
  }

  function kill(target, by) {
    target.hp = 0;
    target.deaths = (target.deaths | 0) + 1;
    target.deadUntil = now() + BATTLE.RESPAWN_SECONDS * 1000;
    target.reloadUntil = 0;
    if (by) {
      by.kills = (by.kills | 0) + 1;
      const s = S.squads[by.squad];
      if (s) s.kills = (s.kills | 0) + 1;
      by.score = (by.score | 0) + BATTLE.SCORE_KILL;
      sendTo(by, { t: 'bkillfeedme', nick: target.nick, kills: by.kills });
      sendTo(by, ammoMsg(by));
    }
    broadcast({
      t: 'bkill',
      by: by ? by.id : null, byNick: by ? by.nick : null,
      bySquad: by ? by.squad : null,
      id: target.id, nick: target.nick, squad: target.squad,
      gun: by ? by.gun : 'zone',
      until: target.deadUntil,
    });
    sendTo(target, { t: 'bdead', until: target.deadUntil, by: by ? by.nick : null });
    pushSquads();
  }

  // ---------------- 1초 틱 ----------------
  function tick1s() {
    if (!S.on) return;
    const T = now();

    if (S.phase === 'playing') {
      const elapsed = Math.max(0, (T - S.startAt) / 1000);
      const hop = zoneAt(elapsed, MAP.PLAY_R);
      // 중심은 단계별로 미리 뽑아 둔 위치로 부드럽게 옮긴다
      const a = S.hops[Math.max(0, hop.stage - 1)] || S.hops[0];
      const b = S.hops[hop.stage] || a;
      let k = 1;
      if (hop.shrinking) {
        const z = BATTLE.ZONE[hop.stage - 1];
        k = clamp((elapsed - z.at) / z.dur, 0, 1);
      }
      S.zone = {
        x: a.x + (b.x - a.x) * k,
        z: a.z + (b.z - a.z) * k,
        r: hop.r, dps: hop.dps, stage: hop.stage,
        next: hop.nextAt ? { at: hop.nextAt, to: hop.nextTo, in: Math.max(0, Math.round(hop.nextAt - elapsed)) } : null,
      };

      for (const p of players.values()) {
        if (p.deadUntil > T || p.hp <= 0) continue;    // 쓰러진 사람은 건너뛴다
        const d = Math.hypot(p.x - S.zone.x, p.z - S.zone.z);
        if (d > S.zone.r) {
          damage(p, S.zone.dps || BATTLE.ZONE_DPS_BEFORE, null);
          if (p.hp > 0) sendTo(p, { t: 'bzonehurt', hp: p.hp });
        }
      }

      // 부활
      for (const p of players.values()) {
        if (p.deadUntil && p.deadUntil <= T) {
          p.deadUntil = 0;
          resetPlayer(p, false);
          sendSpawn(p);
          sendTo(p, ammoMsg(p));
          sendTo(p, { t: 'brespawn' });
        }
      }

      // 보급 상자 리필
      const back = [];
      for (const l of S.loot) {
        if (l.takenAt && T - l.takenAt >= BATTLE.LOOT_RESPAWN_SECONDS * 1000) {
          l.takenAt = 0;
          // 다시 채워질 때 종류를 새로 굴린다 (같은 자리만 파밍하는 걸 막는다)
          l.kind = pick(LOOT_KINDS);
          l.gun = l.kind === 'gun' ? pick(GUN_DROP) : null;
          back.push({ id: l.id, kind: l.kind, gun: l.gun });
        }
      }
      if (back.length) broadcast({ t: 'blootBack', items: back });

      broadcast(stateMsg());
      if (T >= S.endsAt) end('시간 종료');
    }
    toTeachers(squadsPublic());
  }

  function r2(v) { return Math.round((+v || 0) * 100) / 100; }

  return {
    S,
    get on() { return S.on; },
    get phase() { return S.phase; },
    enterLobby, start, end, leave,
    onJoin, onLeave,
    joinSquad, soloSquad, pushSquads, squadsPublic,
    tryLoot, useMed, shoot, tick1s, equip, drop,
    stateMsg, lootPublic, ranking, ammoMsg,
    playing() { return S.on && S.phase === 'playing'; },
    inZoneRadius() { return S.zone.r; },
  };
}

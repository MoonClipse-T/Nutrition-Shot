// ============================================================
//  battle-ui.js — ★ 슈팅 모드 학생 화면
//
//  체력 · 총 · 탄약 · 구급품 · 킬로그 · 자기장 · 분대 로비.
//  실험 모드 UI 는 건드리지 않고, 이 모드일 때만 덮어씁니다.
// ============================================================
import * as THREE from 'three';
import {
  BATTLE, GUNS, LOOT_STYLE, SQUAD_COLORS, SQUAD_COLOR_NAMES,
} from './battledata.js';
import { MAP } from './layout.js';

const esc = (s) => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class BattleUI {
  constructor(game) {
    this.g = game;
    this.on = false;
    this.phase = 'lobby';
    this.startAt = 0; this.endsAt = 0;
    this.zone = { x: 0, z: 0, r: MAP.PLAY_R, dps: 0, stage: 0 };
    this.next = null;
    this.hp = BATTLE.MAX_HP;
    this.gun = 'pistol'; this.mag = 0; this.magSize = 12; this.ammo = 0; this.meds = 0;
    this.kills = 0; this.deaths = 0;
    this.reloadUntil = 0; this.medUntil = 0;
    this.dead = false; this.deadUntil = 0;
    this.mySquad = -1;
    this.squads = [];
    this.lootSent = {};
    this.guns = ['pistol'];
    this.mags = {};
    this.bagSize = BATTLE.BAG_SIZE;
    this._handlers();
    this._buttons();
  }

  // ---------------- 네트워크 ----------------
  _handlers() {
    const n = this.g.net;

    n.on('bstate', (m) => {
      const wasOn = this.on, wasPhase = this.phase;
      this.on = !!m.on;
      this.phase = m.phase;
      this.startAt = m.startAt || 0;
      this.endsAt = m.endsAt || 0;
      if (m.zone) this.zone = m.zone;
      this.next = m.next || null;
      this.g.mode = this.on ? 'battle' : 'science';
      this.applyMode();
      if (this.on && this.phase === 'lobby' && (!wasOn || wasPhase !== 'lobby')) {
        this.openLobby();
      }
      if (this.phase === 'playing' && wasPhase !== 'playing') {
        this.closeLobby();
        document.getElementById('bOverOverlay').hidden = true;
      }
      this.paint();
    });

    n.on('bsquads', (m) => {
      this.squads = m.squads || [];
      const mine = this.squads.find(s => s.members.some(x => x.id === this.g.selfId));
      this.mySquad = mine ? mine.index : -1;
      this.g.squadById = new Map();
      for (const s of this.squads) {
        for (const mem of s.members) this.g.squadById.set(mem.id, s.index);
      }
      this.g.refreshSquadColors?.();
      // 좌상단 표시를 '모둠'에서 '우리 분대'로 바꾼다
      if (this.on && mine) {
        document.getElementById('teamName').textContent = `${mine.colorName} 분대`;
        document.getElementById('teamDot').style.background = mine.color;
        document.getElementById('teamDot').style.color = mine.color;
      }
      this.renderLobby();
      if (!document.getElementById('panelRank').hidden) this.g.hud.renderRank();
      this.paint();
    });

    n.on('bloot', (m) => {
      this.g.world.buildLoot(m.loot);
      for (const l of m.loot) this.g.world.setLoot(l.id, { ...l, visible: true });
      this.g.world.setLootVisible(this.on);
    });
    n.on('blootTaken', (m) => {
      this.g.world.setLoot(m.id, { visible: false });
      if (m.by === this.g.selfId) this.g.sfxPickup();
    });
    n.on('blootBack', (m) => {
      for (const it of m.items) this.g.world.setLoot(it.id, { ...it, visible: true });
    });

    // 다른 사람 총격 (총구 화염 · 탄도 · 소리)
    n.on('bfx', (m) => {
      if (m.by === this.g.selfId) return;
      const g = GUNS[m.gun] || GUNS.pistol;
      this.g._tracerColor(m.o, m.h, g.color);
      const d = Math.hypot(m.o[0] - this.g.me.x, m.o[2] - this.g.me.z);
      if (d < 160) this.g.sfxShot(Math.min(1, d / 160));
      this.g.hud.addGunshot(m.o[0], m.o[2]);
      this.g.flashRemote(m.by);
    });

    n.on('bammo', (m) => {
      const gunChanged = this.gun !== m.gun;
      this.hp = m.hp; this.gun = m.gun; this.mag = m.mag; this.magSize = m.magSize;
      this.ammo = m.ammo; this.meds = m.meds;
      this.reloadUntil = m.reloadUntil || 0; this.medUntil = m.medUntil || 0;
      this.kills = m.kills | 0; this.deaths = m.deaths | 0;
      this.guns = m.guns || ['pistol'];
      this.mags = m.mags || {};
      this.bagSize = m.bag || BATTLE.BAG_SIZE;
      if (gunChanged) this.g.resetZoom();      // 총이 바뀌면 조준경은 원래대로
      this.renderGear();
      this.paint();
    });

    n.on('bhurt', (m) => {
      this.hp = m.hp;
      this.g.hud.hurtFlash();
      this.g.sfxHurt();
      if (m.by) this.g.hud.toast(`💥 ${m.by} 에게 ${m.dmg} 피해 (체력 ${m.hp})`, 'bad', 1600);
      this.paint();
    });
    n.on('bzonehurt', (m) => {
      this.hp = m.hp;
      this.g.hud.hurtFlash();
      this.paint();
    });
    n.on('bhit', (m) => {
      this.g.hud.hitmark();
      this.g.sfxHitmark();
    });

    n.on('bkill', (m) => {
      const mine = m.by === this.g.selfId;
      const victimMe = m.id === this.g.selfId;
      const gunName = GUNS[m.gun]?.short || '자기장';
      this.g.hud.feed(
        `${mine ? '🔥 ' : ''}<b>${esc(m.byNick || '자기장')}</b> ➜ <b>${esc(m.nick)}</b> <span class="kf-gun">${esc(gunName)}</span>`);
      if (mine) { this.g.hud.toast(`💀 ${m.nick} 처치! (${this.kills + 1}킬)`, 'good', 2200); }
      if (victimMe) {
        this.dead = true; this.deadUntil = m.until;
        this.g.resetZoom();
        const ov = document.getElementById('bDeadOverlay');
        ov.hidden = false;
        document.getElementById('bDeadBy').textContent =
          m.byNick ? `${m.byNick} 에게 당했습니다` : '자기장 밖에서 쓰러졌습니다';
        this.g.sfxDown();
        document.exitPointerLock?.();
      }
      const r = this.g.remote.get(m.id);
      if (r) r.down = true;
    });

    n.on('bdead', (m) => {
      this.dead = true; this.deadUntil = m.until;
      const ov = document.getElementById('bDeadOverlay');
      ov.hidden = false;
      document.getElementById('bDeadBy').textContent =
        m.by ? `${m.by} 에게 당했습니다` : '자기장 밖에서 쓰러졌습니다';
    });
    n.on('brespawn', () => {
      this.dead = false; this.deadUntil = 0;
      this.g.resetZoom();
      document.getElementById('bDeadOverlay').hidden = true;
      this.g.hud.toast('부활! 총과 탄약을 다시 챙기세요', 'good');
    });

    n.on('bover', (m) => {
      this.phase = 'over';
      this.showResult(m.ranking, m.reason);
    });
  }

  // ---------------- 버튼 ----------------
  _buttons() {
    document.getElementById('btnMed')?.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.g.net.send({ t: 'bmed' });
    }, { passive: false });
    document.getElementById('btnSquad')?.addEventListener('click', () => this.openLobby());
    document.getElementById('btnGear')?.addEventListener('click', () => this.g.hud.togglePanel('gear'));
    document.getElementById('bLobbyClose')?.addEventListener('click', () => this.closeLobby());
    document.getElementById('bOverClose')?.addEventListener('click', () => {
      document.getElementById('bOverOverlay').hidden = true;
    });
    addEventListener('keydown', (e) => {
      if (!this.on) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'h' || e.key === 'H') this.g.net.send({ t: 'bmed' });
      if (e.key === 'g' || e.key === 'G') this.g.hud.togglePanel('gear');
      if (/^[1-4]$/.test(e.key)) this.quickEquip(+e.key - 1);
    });
  }

  // ---------------- 모드 전환 ----------------
  //  슈팅 모드에서는 실험용 UI(실험노트·정답·자격시험·시약바)를 감춘다.
  applyMode() {
    document.body.classList.toggle('battle', this.on);
    this.g.world.setLootVisible(this.on);
    for (const id of ['btnNote', 'btnAnswer', 'btnQuiz']) {
      const el = document.getElementById(id);
      if (el) el.hidden = this.on;
    }
    if (this.on && this.phase !== 'playing') {
      document.getElementById('roundTimer').textContent = '--:--';
    }
    const med = document.getElementById('btnMed');
    if (med) med.hidden = !this.on;
    const sq = document.getElementById('btnSquad');
    if (sq) sq.hidden = !this.on;
    const gr = document.getElementById('btnGear');
    if (gr) gr.hidden = !this.on;
    if (!this.on) {
      this.g.resetZoom();
      document.getElementById('scope').hidden = true;
      document.getElementById('zoomChip').hidden = true;
      document.getElementById('crosshair').style.opacity = '';
    }
    document.getElementById('ammoBar').hidden = this.on;
    document.getElementById('bBar').hidden = !this.on;
    document.getElementById('beakerStatus').hidden = this.on;
    document.getElementById('btnChat').querySelector('span').textContent = this.on ? '분대' : '모둠';
    this.g.hud._quick(this.on);
    // 대기 공간 안내 문구도 모드에 맞게
    const wb = document.querySelector('#waitBanner .wb-in');
    if (wb) {
      wb.innerHTML = this.on
        ? `<b>⚔ 슈팅 모드 로비</b><span>👥 <u>분대</u> 버튼으로 친구와 팀을 짜세요 (최대 ${BATTLE.SQUAD_MAX}명) — 선생님이 시작하면 섬으로!</span>`
        : `<b>🕹 대기 공간</b><span>조작을 연습하세요 — 선생님이 시작하면 <u>다같이</u> 섬으로 출발합니다</span>`;
    }
    if (!this.on) {
      document.getElementById('bDeadOverlay').hidden = true;
      document.getElementById('bOverOverlay').hidden = true;
      document.getElementById('bZone').hidden = true;
      this.closeLobby();
      this.dead = false;
      // 좌상단을 원래 모둠 표시로 되돌린다
      document.getElementById('teamName').textContent = this.g.teamNameText || '';
      document.getElementById('teamDot').style.background = this.g.teamColor;
      document.getElementById('teamDot').style.color = this.g.teamColor;
      document.getElementById('roundTimer').textContent = '--:--';
    }
  }

  // ---------------- 분대 로비 ----------------
  openLobby() {
    if (!this.on) return;
    this.g.hud.closePanels();
    document.getElementById('bLobby').hidden = false;
    this.renderLobby();
  }
  closeLobby() { document.getElementById('bLobby').hidden = true; }

  renderLobby() {
    const box = document.getElementById('bLobbyList');
    if (!box || document.getElementById('bLobby').hidden) return;
    const live = this.squads.filter(s => s.members.length > 0);
    // 우리 분대 → 자리가 남은 분대 → 꽉 찬 분대 순
    live.sort((a, b) => {
      const am = a.index === this.mySquad ? 0 : 1, bm = b.index === this.mySquad ? 0 : 1;
      if (am !== bm) return am - bm;
      const af = a.members.length >= BATTLE.SQUAD_MAX ? 1 : 0;
      const bf = b.members.length >= BATTLE.SQUAD_MAX ? 1 : 0;
      if (af !== bf) return af - bf;
      return b.members.length - a.members.length;
    });
    box.innerHTML = live.map(s => {
      const mine = s.index === this.mySquad;
      const full = s.members.length >= BATTLE.SQUAD_MAX;
      return `<div class="sq${mine ? ' mine' : ''}${full ? ' full' : ''}">
        <i style="background:${s.color}"></i>
        <div class="sq-b">
          <div class="sq-n">${esc(s.colorName)} 분대
            <span class="sq-c">${s.members.length}/${BATTLE.SQUAD_MAX}</span></div>
          <div class="sq-m">${s.members.map(m => esc(m.nick)).join(' · ')}</div>
        </div>
        ${mine ? '<span class="sq-tag">우리 분대</span>'
          : full ? '<span class="sq-tag off">꽉 참</span>'
          : `<button data-i="${s.index}">합류</button>`}
      </div>`;
    }).join('');
    box.querySelectorAll('button[data-i]').forEach(b => {
      b.onclick = () => this.g.net.send({ t: 'bsquad', i: +b.dataset.i });
    });
    const solo = document.getElementById('bLobbySolo');
    if (solo) solo.onclick = () => this.g.net.send({ t: 'bsolo' });
  }

  // ---------------- ★ 장비창 (총 바꿔 끼우기 / 버리기) ----------------
  renderGear() {
    const box = document.getElementById('gearList');
    if (!box) return;
    const bag = this.guns || ['pistol'];
    box.innerHTML = bag
      .slice()
      .sort((a, b) => GUNS[b].tier - GUNS[a].tier)
      .map((id, i) => {
        const g = GUNS[id];
        const on = id === this.gun;
        const mag = id === this.gun ? this.mag : (this.mags[id] | 0);
        return `<div class="gear${on ? ' on' : ''}">
          <i style="background:${g.color}"></i>
          <div class="gear-b">
            <div class="gear-n">${esc(g.name)}
              <span class="gear-k">${i + 1}</span>
              ${on ? '<span class="gear-eq">장착 중</span>' : ''}</div>
            <div class="gear-s">데미지 ${g.dmg} · 탄창 ${mag}/${g.mag} · 사거리 ${g.range}m
              ${g.zoom > 2 ? ' · 🔭 조준경' : ''}</div>
          </div>
          ${on ? '' : `<button class="gear-use" data-eq="${id}">장착</button>`}
          ${bag.length > 1 ? `<button class="gear-x" data-drop="${id}">버리기</button>` : ''}
        </div>`;
      }).join('') +
      `<p class="hint" style="margin:10px 0 0">가방 ${bag.length}/${this.bagSize}자루 ·
        <b>숫자키 1~4</b> 로도 바꿀 수 있어요. 새로 주운 총은 가방에 들어갑니다
        (지금 총보다 좋으면 바로 장착).</p>`;
    box.querySelectorAll('[data-eq]').forEach(b => {
      b.onclick = () => this.g.net.send({ t: 'bequip', gun: b.dataset.eq });
    });
    box.querySelectorAll('[data-drop]').forEach(b => {
      b.onclick = () => this.g.net.send({ t: 'bdrop', gun: b.dataset.drop });
    });
  }

  // 숫자키로 빠르게 바꾸기
  quickEquip(i) {
    if (!this.on || this.phase !== 'playing') return;
    const bag = (this.guns || []).slice().sort((a, b) => GUNS[b].tier - GUNS[a].tier);
    const id = bag[i];
    if (id && id !== this.gun) this.g.net.send({ t: 'bequip', gun: id });
  }

  // ---------------- ★ 조준경 화면 ----------------
  paintScope(zoom, gun) {
    const el = document.getElementById('scope');
    const chip = document.getElementById('zoomChip');
    if (!el || !chip) return;
    const on = zoom > 1.35;
    el.hidden = !on || !(gun && gun.scope);      // 검은 원형 조준경은 저격총만
    chip.hidden = zoom <= 1.02;
    chip.textContent = `🔭 ${zoom.toFixed(1)}×`;
    document.getElementById('crosshair').style.opacity = on && gun && gun.scope ? '0' : '';
  }

  // ---------------- 결과 ----------------
  showResult(ranking, reason) {
    const box = document.getElementById('bOverRows');
    box.innerHTML = (ranking || []).map((r) => {
      const medal = ['🥇', '🥈', '🥉'][r.rank - 1] || r.rank;
      return `<div class="rv${r.rank <= 3 ? ' podium' : ''}">
        <div class="lb">${medal}</div>
        <div><div class="nm">
          <span style="display:inline-block;width:11px;height:11px;border-radius:4px;
            background:${r.color};border:1px solid #fff;vertical-align:-1px"></span>
          ${esc(r.colorName)} 분대 <b style="color:#ffcc4d">${r.kills}킬</b></div>
        <div class="nu">${r.members.map(m => `${esc(m.nick)} (${m.kills}킬 ${m.deaths}데스)`).join(' · ')}</div>
        </div></div>`;
    }).join('');
    document.getElementById('bOverNote').textContent =
      `${reason || '종료'} · 순위는 분대 전체 킬 수 순입니다`;
    document.getElementById('bOverOverlay').hidden = false;
    this.closeLobby();
  }

  // ---------------- 상단 HUD ----------------
  paint() {
    if (!this.on) return;
    const hpFill = document.getElementById('bHpFill');
    if (hpFill) {
      const pct = Math.max(0, Math.min(100, this.hp));
      hpFill.style.width = pct + '%';
      hpFill.className = pct <= 30 ? 'low' : pct <= 60 ? 'mid' : '';
      document.getElementById('bHpNum').textContent = Math.max(0, this.hp | 0);
    }
    const g = GUNS[this.gun] || GUNS.pistol;
    const gunEl = document.getElementById('bGun');
    if (gunEl) {
      const reloading = Date.now() < this.reloadUntil;
      gunEl.innerHTML =
        `<span class="g-n" style="color:${g.color}">${g.name}</span>` +
        `<span class="g-a">${reloading ? '재장전…' : `${this.mag}<i>/${this.ammo}</i>`}</span>`;
      gunEl.classList.toggle('reload', reloading);
    }
    const medEl = document.getElementById('btnMed');
    if (medEl) {
      medEl.querySelector('.n').textContent = this.meds;
      medEl.classList.toggle('empty', this.meds <= 0);
    }
    const kd = document.getElementById('bKd');
    if (kd) kd.textContent = `${this.kills}킬 ${this.deaths}데스`;
  }

  // 1초에 몇 번만 부르면 되는 것들 (남은 시간 · 자기장 안내 · 부활 카운트)
  tick() {
    if (!this.on) return;
    const T = Date.now();
    if (this.phase === 'playing' && this.endsAt) {
      const left = Math.max(0, Math.floor((this.endsAt - T) / 1000));
      const el = document.getElementById('roundTimer');
      if (el) el.textContent =
        `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    }
    if (this.dead) {
      const s = Math.max(0, Math.ceil((this.deadUntil - T) / 1000));
      const el = document.getElementById('bDeadSec');
      if (el) el.textContent = s;
    }
    // 자기장 안내
    const zb = document.getElementById('bZone');
    if (zb) {
      if (this.phase !== 'playing') { zb.hidden = true; }
      else {
        const me = this.g.me;
        const d = Math.hypot(me.x - this.zone.x, me.z - this.zone.z);
        const out = d > this.zone.r;
        zb.hidden = false;
        zb.className = out ? 'out' : '';
        zb.innerHTML = out
          ? `⚠️ <b>자기장 밖!</b> 안전지대까지 ${Math.round(d - this.zone.r)}m — 체력이 계속 깎입니다`
          : (this.next
            ? `🛡 안전지대 반지름 ${Math.round(this.zone.r)}m · 다음 축소 ${this.next.in}초 후`
            : `🛡 안전지대 반지름 ${Math.round(this.zone.r)}m`);
      }
    }
    this.paint();
  }

  // ---------------- 보급 상자 자동 획득 ----------------
  stepLoot(me, px, pz, segDist2D) {
    if (!this.on || this.phase !== 'playing' || this.dead) return null;
    const w = this.g.world;
    if (!w.lootData) return null;
    const now = performance.now();
    let near = null, nd = 1e9;
    for (const l of w.lootData.values()) {
      if (!l.visible) continue;
      const straight = Math.hypot(l.x - me.x, l.z - me.z);
      if (straight < nd) { nd = straight; near = l; }
      if (segDist2D(l.x, l.z, px, pz, me.x, me.z) >= BATTLE.LOOT_RADIUS) continue;
      if (Math.abs(l.y - me.y) > 4) continue;
      if (now - (this.lootSent[l.id] || 0) < 700) continue;
      this.lootSent[l.id] = now;
      this.g.net.send({ t: 'bloot', id: l.id, x: +me.x.toFixed(2), z: +me.z.toFixed(2) });
    }
    if (near && nd < 14) {
      const st = LOOT_STYLE[near.kind];
      const extra = near.kind === 'gun' ? ` — ${GUNS[near.gun]?.name || ''}` : '';
      return `${st.icon} ${st.name}${extra} (${nd.toFixed(0)}m)`;
    }
    return null;
  }

  // ---------------- 미니맵 자기장 ----------------
  drawZone(ctx, toPx, S) {
    if (!this.on || this.phase !== 'playing') return;
    const [cx, cy] = toPx(this.zone.x, this.zone.z);
    const rr = (this.zone.r / MAP.PLAY_R) * (S / 2 - 8);
    ctx.save();
    // 바깥쪽을 붉게
    ctx.beginPath();
    ctx.rect(0, 0, S, S);
    ctx.arc(cx, cy, Math.max(2, rr), 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(220,50,60,.24)';
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, rr), 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.2; ctx.stroke();
    if (this.next && this.next.to) {
      const nr = (this.next.to / MAP.PLAY_R) * (S / 2 - 8);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, nr), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(120,220,255,.9)';
      ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  drawLoot(ctx, toPx, me) {
    if (!this.on || this.phase !== 'playing') return;
    const w = this.g.world;
    if (!w.lootData) return;
    for (const l of w.lootData.values()) {
      if (!l.visible) continue;
      if (Math.hypot(l.x - me.x, l.z - me.z) > 80) continue;
      const [px, py] = toPx(l.x, l.z);
      ctx.fillStyle = LOOT_STYLE[l.kind].color;
      ctx.fillRect(px - 3, py - 3, 6, 6);
    }
  }

  squadColor(i) { return SQUAD_COLORS[((i | 0) + 999999) % SQUAD_COLORS.length]; }
  squadName(i) { return SQUAD_COLOR_NAMES[((i | 0) + 999999) % SQUAD_COLOR_NAMES.length]; }

  // 지금 총의 사거리/연사 — main.js 의 사격 코드가 참조한다
  gunDef() { return GUNS[this.gun] || GUNS.pistol; }
  canShoot() {
    if (this.phase !== 'playing') return false;
    if (this.dead) return false;
    if (Date.now() < this.startAt) return false;
    if (Date.now() < this.reloadUntil) return false;
    if (this.mag <= 0) return false;
    return true;
  }
}

// ============================================================
//  main.js — Project_Godeok 클라이언트 본체
// ============================================================
import * as THREE from 'three';
import { Net } from './net.js';
import { World } from './world.js';
import { HUD } from './hud.js';
import { Input } from './controls.js';
import { makeAvatar, animateAvatar, flashMuzzle, setGunTank } from './avatar.js';
import { REAGENTS, REAGENT_LIST, RULES, TEAM_COLORS, TEAM_NAMES, DRINKS } from './gamedata.js';
import { LAYOUT, terrainHeight, safeZoneAt, MAP, TRAIN } from './layout.js';
import { BattleUI } from './battle-ui.js';
import { GUNS, BATTLE, RECOIL_RECOVER } from './battledata.js';

const EYE = 1.62, CROUCH_EYE = 1.05, PLAYER_R = 0.45;
const INTERP_DELAY = 130;   // ms — 원격 플레이어를 이만큼 늦게 그려서 부드럽게

// ============================================================
//  간단한 효과음 (외부 파일 없이 WebAudio 로 합성)
// ============================================================
const Sfx = {
  ctx: null,
  init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); },
  blip(freq, dur, type = 'square', gain = 0.06, slideTo = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noise(dur, gain = 0.12, lp = 1400) {
    if (!this.ctx) return;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(this.ctx.destination);
    src.start();
  },
  shot(far = 0) {
    this.noise(0.10, 0.16 * (1 - far * 0.75), 2600 - far * 1600);
    this.blip(180 - far * 60, 0.09, 'sawtooth', 0.05 * (1 - far * 0.7), 60);
  },
  pickup() { this.blip(660, 0.09, 'triangle', 0.08); setTimeout(() => this.blip(990, 0.11, 'triangle', 0.07), 80); },
  positive() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, 0.16, 'triangle', 0.09), i * 90)); },
  negative() { this.blip(200, 0.22, 'sine', 0.07, 120); },
  hurt() { this.noise(0.16, 0.14, 700); this.blip(140, 0.2, 'sine', 0.07, 70); },
  down() { [400, 330, 260, 190].forEach((f, i) => setTimeout(() => this.blip(f, 0.3, 'sine', 0.1), i * 130)); },
  correct() { [659, 784, 988, 1319].forEach((f, i) => setTimeout(() => this.blip(f, 0.2, 'square', 0.07), i * 110)); },
  hitmark() { this.blip(1400, 0.05, 'square', 0.06); },
};

// ============================================================
class Game {
  constructor(net, initMsg, quality) {
    this.net = net;
    this.quality = quality;
    this.selfId = initMsg.selfId;
    this.myTeam = initMsg.team;
    this.myNick = initMsg.nick;
    this.teamColor = initMsg.teamColor;
    this.rules = initMsg.rules || RULES;

    this.remote = new Map();      // id -> {avatar, buf:[], nick, team, down, hits}
    this.rosterById = new Map();
    this.tracers = [];
    // 탄약은 서버가 정한 값을 그대로 쓴다 (임의로 가정하면 화면과 실제가 어긋난다)
    this.reagents = initMsg.ammo?.reagents || { iodine: 0, benedict: 0, biuret: 0, sudan: 0 };
    this.collected = initMsg.ammo?.collected || {};
    this.tranq = initMsg.ammo?.tranq ?? RULES.TRANQ_START_AMMO;
    this.ammoIdx = 0;
    this.score = 0;
    this.down = false;
    this.downUntil = 0;
    this.lockUntil = 0;
    this.phase = initMsg.phase || 'waiting';
    this.startAt = initMsg.startAt || 0;
    this.mode = initMsg.mode || 'science';       // ★ science | battle
    this.squadById = new Map();
    this.inSafe = null;
    this.heatUntil = 0;              // ★ 몸에 불이 붙어 있는 동안만 베네딕트가 반응한다
    this.leader = null;              // ★ 현재 1위 모둠 (마취 현상금 대상)
    this.quizPassed = initMsg.ammo?.quizPassed ?? !RULES.TRANQ_REQUIRE_QUIZ;
    this.tranqCap = initMsg.ammo?.tranqCap ?? RULES.TRANQ_START_AMMO;
    this.hits = 0;
    this.lastShot = 0;
    this.lastPickTry = 0;
    this.roundEndsAt = 0;

    this._three();
    this.world = new World(this.scene, quality);
    this.world.buildPickups(initMsg.pickups);
    for (const p of initMsg.pickups) this.pickupData = initMsg.pickups;

    this.hud = new HUD(this);
    this.hud.quizPassed = this.quizPassed;
    this.hud.tranqCap = this.tranqCap;
    this.hud.buildAmmoBar((i) => this.selectAmmo(i));
    this.hud.renderBeakerStatus();
    this.hud.setPhase(this.phase, this.startAt);

    // 내 캐릭터
    this.me = {
      x: initMsg.spawn.x, y: initMsg.spawn.y, z: initMsg.spawn.z,
      vy: 0, yaw: initMsg.spawn.yaw, pitch: 0, onGround: true, speed: 0,
    };
    this.avatar = makeAvatar(this.teamColor, quality);
    this.scene.add(this.avatar);

    this.input = new Input(document.getElementById('game'));
    this.input.onAmmo = (v) => {
      if (v === '+1') this.selectAmmo((this.ammoIdx + 1) % 5);
      else if (v === '-1') this.selectAmmo((this.ammoIdx + 4) % 5);
      else this.selectAmmo(v);
    };
    this.input.onPanel = (k) => this.hud.togglePanel(k);
    // ★ 조준경 — 슈팅 모드에서만. 실험 모드에서는 휠로 탄알을 바꾸던 예전 동작을 유지한다.
    this.zoom = 1;
    this.input.onZoom = (v, kind, dir) => {
      if (this.mode !== 'battle') {
        if (kind === 'mul' && dir) this.selectAmmo((this.ammoIdx + (dir > 0 ? 1 : 4)) % 5);
        return;
      }
      this.setZoom(this.zoom * v);
    };
    this.input.onTapFire = () => this.tryShoot();

    // 라운드 정보
    this.applyRound(initMsg.round);

    this.teamNameText = initMsg.teamName;
    document.getElementById('teamName').textContent = initMsg.teamName;
    document.getElementById('teamDot').style.background = this.teamColor;
    document.getElementById('teamDot').style.color = this.teamColor;

    this._netHandlers();
    // ★ 슈팅 모드(남는 시간용) — 선생님이 켰을 때만 화면이 바뀐다
    this.battle = new BattleUI(this);
    this.selectAmmo(0);

    this.clock = new THREE.Clock();
    this.lastSend = 0;
    addEventListener('resize', () => this._resize());

    // ★ 위치 전송 보험 —
    //   그림 루프(rAF)는 화면이 꺼지거나 앱을 내려두면 멈춘다. 그 사이 위치를 못 보내면
    //   서버가 아는 위치가 뒤처지고, 돌아왔을 때 시약·불꽃이 안 잡힌다.
    //   그래서 타이머로도 한 번 더 보내고, 화면이 돌아오는 즉시 강제로 보낸다.
    this._posTimer = setInterval(() => {
      if (performance.now() - this.lastSend > 250) this.sendPos();
    }, 250);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { this.sendPos(); setTimeout(() => this.sendPos(), 300); }
    });
    addEventListener('focus', () => this.sendPos());
    addEventListener('pageshow', () => this.sendPos());

    this._resize();
    this.loop();
  }

  // ---------------- Three.js 기본 ----------------
  _three() {
    const canvas = document.getElementById('c');
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: this.quality !== 'low', powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,
      this.quality === 'low' ? 1 : this.quality === 'mid' ? 1.5 : 2));
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.15, 900);

    const hemi = new THREE.HemisphereLight('#cfe6ff', '#5b6b45', 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff3d6', 1.15);
    sun.position.set(90, 130, 60);
    if (this.quality === 'high') {
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      const d = 90;
      sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
      sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
      sun.shadow.camera.far = 400;
      sun.shadow.bias = -0.0012;
    }
    this.scene.add(sun);
    this.sun = sun;

    // 총알 궤적 풀
    const tmat = new THREE.LineBasicMaterial({ transparent: true });
    for (let i = 0; i < 28; i++) {
      const g = new THREE.BufferGeometry().setAttribute(
        'position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const l = new THREE.Line(g, tmat.clone());
      l.visible = false; l.frustumCulled = false;
      this.scene.add(l);
      this.tracers.push({ line: l, until: 0 });
    }

    // 착탄 이펙트 풀
    this.impacts = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 7, 5),
        new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true })
      );
      m.visible = false;
      this.scene.add(m);
      this.impacts.push({ mesh: m, until: 0 });
    }

    // 비커 반응 파티클
    const pgeo = new THREE.BufferGeometry();
    const N = 160;
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.splashMat = new THREE.PointsMaterial({ size: 0.4, transparent: true, opacity: 0 });
    this.splash = new THREE.Points(pgeo, this.splashMat);
    this.splash.frustumCulled = false;
    this.splash.visible = false;
    this.scene.add(this.splash);
    this.splashUntil = 0;
    this.splashVel = new Float32Array(N * 3);
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- 라운드 ----------------
  applyRound(r) {
    if (!r) { this.roundOver = false; return; }
    this.roundEndsAt = r.endsAt;
    this.roundOver = r.over;
    // ★ 이번 라운드 후보 (매 라운드 새로 뽑힌다)
    if (r.candidates) this.hud.roundCandidates = r.candidates;
    // 섬 위 비커는 6개(두 세트). b.index=위치, b.drink=안에 든 음료(0=A,1=B,2=C)
    r.beakers.forEach(b => this.world.setBeakerLiquid(b.index, b.liquid));
    document.getElementById('revealOverlay').hidden = !r.over;
    if (!r.over) {
      this.hud.solved = {};
      this.hud.wrongMark = {};
      this.hud.solvedName = {};
      this.hud.selected = [null, null, null];
      this.hud.notes = [{}, {}, {}];
      this.hud.cooldownUntil = 0;
      this.hud.renderNote();
      this.hud.renderAnswer();
      this.hud.renderBeakerStatus();
      document.getElementById('resultOverlay').hidden = true;
    }
  }

  // ---------------- 네트워크 ----------------
  _netHandlers() {
    const n = this.net;

    n.on('s', (m) => {
      const t = performance.now();
      for (const a of m.p) {
        const [id, x, y, z, yaw, pitch, flags] = a;
        if (id === this.selfId) continue;
        let r = this.remote.get(id);
        if (!r) r = this._addRemote(id);
        r.buf.push({ t, x, y, z, yaw, pitch, flags });
        if (r.buf.length > 12) r.buf.shift();
        r.down = !!(flags & 32);
        r.crouch = !!(flags & 4);
        r.hot = !!(flags & 64);        // ★ 몸에 불이 붙은 상태
      }
      // 사라진 사람 정리
      const alive = new Set(m.p.map(a => a[0]));
      for (const [id, r] of this.remote) {
        if (!alive.has(id)) { this.scene.remove(r.avatar); this.remote.delete(id); }
      }
    });

    n.on('roster', (m) => {
      this.rosterById.clear();
      for (const p of m.players) this.rosterById.set(p.id, p);
      for (const [id, r] of this.remote) {
        const info = this.rosterById.get(id);
        if (info) {
          r.nick = info.nick; r.team = info.team;
          const c = this.colorFor(id, info.team);
          if (r.color !== c) {
            r.color = c;
            this.scene.remove(r.avatar);
            r.avatar = makeAvatar(c, this.quality);
            this.scene.add(r.avatar);
          }
        }
      }
      const myTeam = m.teams[this.myTeam];
      if (myTeam) {
        for (const k in myTeam.solved) this.hud.solved[k] = true;
        this.hud.renderBeakerStatus();
      }
      this.hud.setRoster(m);
    });

    n.on('round', (m) => this.applyRound(m.round));

    // ---- 게임 단계 (대기 → 시작) ----
    n.on('phase', (m) => {
      const was = this.phase;
      this.phase = m.phase;
      this.startAt = m.startAt || 0;
      if (m.phase === 'playing' && was !== 'playing') {
        this.finished = {};                 // ★ 새 라운드 — 등수 확정 표시 초기화
        this.hud.clearFinish();
      }
      this.hud.setPhase(m.phase, m.startAt);
      if (m.phase === 'playing' && was !== 'playing') {
        this.hud.closePanels();
        Sfx.correct();
      }
    });

    // 서버가 지정한 위치로 이동 (라운드 시작 / 대기실 복귀)
    n.on('spawn', (m) => {
      const sp = m.spawn;
      this.me.x = sp.x; this.me.y = sp.y + 0.1; this.me.z = sp.z;
      this.me.yaw = sp.yaw ?? this.me.yaw;
      this.me.vy = 0; this.me.pitch = 0;
      this.input.crouching = false;
      this.net.send({
        t: 'in', x: +sp.x.toFixed(2), y: +sp.y.toFixed(2), z: +sp.z.toFixed(2),
        yaw: +this.me.yaw.toFixed(3), pitch: 0, f: 0,
      });
    });

    n.on('ammo', (m) => {
      this.reagents = m.reagents; this.tranq = m.tranq; this.collected = m.collected || {};
      if (m.tranqCap !== undefined) this.tranqCap = m.tranqCap;
      if (m.quizPassed !== undefined) this.quizPassed = m.quizPassed;
      this.hud.quizPassed = this.quizPassed;
      this.hud.tranqCap = this.tranqCap;
      this.hud.updateAmmo(this.reagents, this.tranq, this.ammoIdx, this.collected);
    });

    // ---- 마취총 자격시험 ----
    n.on('quiz', (m) => this.hud.showQuiz(m.questions));
    n.on('needQuiz', () => {
      if (Date.now() - (this._nagAt || 0) < 4000) return;
      this._nagAt = Date.now();
      this.hud.toast('🔒 마취총은 자격시험을 통과해야 쓸 수 있어요. 🎓 버튼을 누르세요!', 'bad');
      document.getElementById('btnQuiz').classList.add('alert');
      Sfx.negative();
    });
    n.on('quizState', (m) => {
      this.quizPassed = !!m.passed;
      this.hud.quizPassed = this.quizPassed;
      this.hud.onQuizState(m);
      if (m.justPassed) Sfx.correct();
      this.hud.updateAmmo(this.reagents, this.tranq, this.ammoIdx, this.collected);
    });

    // ---- 정답 채점 결과 (A·B·C 한 번에) ----
    n.on('answerResult', (m) => {
      this.hud.showAnswerResult(m);
      const ok = m.results.filter(r => r.correct).length;
      if (ok > 0) Sfx.correct(); else Sfx.negative();
    });

    n.on('score', (m) => {
      this.score = m.score;
      document.getElementById('scoreVal').textContent = m.score;
      if (m.delta) this.hud.feed(
        `<b style="color:${m.delta > 0 ? '#7ee2a8' : '#ff9c8f'}">${m.delta > 0 ? '+' : ''}${m.delta}</b> ${m.why}`);
    });

    n.on('pickTaken', (m) => {
      this.world.setPickupTaken(m.id, true);
      if (m.by === this.selfId) Sfx.pickup();
    });
    n.on('pickBack', (m) => m.ids.forEach(id => this.world.setPickupTaken(id, false)));

    n.on('fx', (m) => {
      if (m.by === this.selfId) return;
      this._tracer(m.o, m.h, m.ammo);
      const d = Math.hypot(m.o[0] - this.me.x, m.o[2] - this.me.z);
      if (d < 140) Sfx.shot(Math.min(1, d / 140));
      this.hud.addGunshot(m.o[0], m.o[2]);
      const r = this.remote.get(m.by);
      if (r) flashMuzzle(r.avatar);
    });

    // 이 메시지는 '우리 모둠'에게만 온다 (다른 모둠의 반응은 아예 안 보임)
    n.on('beakerReact', (m) => {
      const rg = REAGENTS[m.reagent];
      const b = this.world.beakers[m.bi];
      if (!b) return;
      if (m.positive) {
        this.world.reactBeaker(m.bi, m.color, RULES.BEAKER_REACTION_SECONDS);
        this._splash(m.bi, m.color);
      }
      // 누가 무슨 시약을 쐈고 결과가 뭔지 비커 위에 띄운다.
      // (모둠원끼리 연달아 쏴도 어느 반응인지 헷갈리지 않게)
      this.world.showBeakerLabel(m.bi, {
        text: `${rg.shortName} → ${m.positive ? rg.posText : '변화 없음'}`,
        sub: `${m.nick} · ${m.positive ? '양성 ＋' : '음성 －'}`,
        color: m.positive ? rg.posColor : '#8fa0b2',
        positive: m.positive,
        seconds: RULES.BEAKER_REACTION_SECONDS,
      });

      const dist = Math.hypot(b.x - this.me.x, b.z - this.me.z);
      if (dist < 120) {
        if (m.positive) Sfx.positive(); else Sfx.negative();
      }
      if (m.by !== this.selfId) {
        this.hud.feed(`🧪 <b>${m.nick}</b> → 비커 ${b.label} · ${rg.shortName} ` +
          (m.positive ? `<b style="color:${m.color}">${rg.posText}!</b>` : '무반응'));
      }
    });

    // ---- ★ 가열 (베네딕트 반응 조건) ----
    n.on('heat', (m) => {
      const was = this.heatUntil > Date.now();
      this.heatUntil = m.until || 0;
      const hot = this.heatUntil > Date.now();
      this.hud.setHeat(this.heatUntil);
      if (m.msg) this.hud.toast(m.msg, hot ? 'good' : 'bad');
      if (hot && !was) Sfx.positive();
    });
    n.on('noHeat', (m) => {
      if (Date.now() - (this._heatNagAt || 0) > 2000) {
        this._heatNagAt = Date.now();
        this.hud.toast(m.msg, 'bad');
        Sfx.negative();
      }
      this.hud.showHeatNeeded(m.fire);
    });

    // ---- ★ 등수 확정 (음료 3개를 먼저 다 맞힌 순서) ----
    n.on('finish', (m) => {
      this.finished = this.finished || {};
      this.finished[m.team] = m;
      const mine = m.team === this.myTeam;
      this.hud.showFinish(m, mine);
      this.hud.feed(mine
        ? `${m.medal} <b>우리 모둠 ${m.order}등 확정!</b> (+${m.bonus}점)`
        : `${m.medal} <b style="color:${m.color}">${m.colorName} 모자</b>(${m.name}) ${m.order}등 확정`);
      if (mine) Sfx.correct(); else Sfx.blip(620, 0.12, 'square', 0.05, 420);
    });

    // ---- ★ 선두 모둠 공개 (마취총의 '이유') ----
    n.on('leader', (m) => {
      const wasMine = this.leader && this.leader.team === this.myTeam;
      this.leader = (m.team === null || m.team === undefined) ? null : m;
      this.hud.setLeader(this.leader, this.myTeam);
      if (!this.leader) return;
      const mine = this.leader.team === this.myTeam;
      if (mine && !wasMine) Sfx.correct();
      else if (!mine) Sfx.blip(760, 0.1, 'square', 0.05, 520);
      this.hud.feed(mine
        ? `👑 <b>우리 모둠이 1위</b> — 표적이 되었습니다`
        : `👑 1위 <b style="color:${this.leader.color}">${this.leader.colorName} 모자</b> · ` +
          `${this.leader.nicks.join(' · ')} — 마취 <b>+${this.leader.bounty}점</b>`);
    });

    // 선생님이 내 화면을 보고 있을 때만 켜진다
    n.on('stream', (m) => {
      this.streaming = !!m.on;
      this.streamFps = m.fps || RULES.WATCH_FPS;
      const el = document.getElementById('watchedBadge');
      if (el) el.hidden = !this.streaming;
    });

    // 총 압수 (실험 없이 마취탄만 남발했을 때)
    n.on('lock', (m) => {
      this.lockUntil = m.until || 0;
      const el = document.getElementById('lockOverlay');
      if (this.lockUntil > Date.now()) {
        el.hidden = false;
        Sfx.negative();
      } else {
        el.hidden = true;
      }
    });

    n.on('testResult', (m) => {
      this.hud.setResult(m.bi, m.reagent, m.positive);
      this.hud.toast(m.text, m.positive ? 'good' : null);
    });

    n.on('hurt', (m) => {
      this.hits = m.hits;
      if (!m.decay) { Sfx.hurt(); this.hud.hurtFlash(); this.hud.toast(`💉 ${m.by}에게 맞았습니다 (${m.hits}/${RULES.TRANQ_HITS_TO_DOWN})`, 'bad'); }
    });

    n.on('hitmark', (m) => { this.hud.hitmark(); Sfx.hitmark(); });

    n.on('down', (m) => {
      const r = this.remote.get(m.id);
      if (r) r.down = true;
      if (m.id === this.selfId) {
        this.down = true; this.downUntil = m.until;
        this.everDowned = true;          // (검증용 기록)
        document.getElementById('downOverlay').hidden = false;
        document.getElementById('downBy').textContent = `${m.byNick} 에게 마취당했습니다`;
        Sfx.down();
        document.exitPointerLock?.();
      } else {
        this.hud.feed(m.bounty
          ? `👑💤 <b>${m.byNick}</b> 이(가) <b style="color:#ffcc4d">선두 ${m.nick}</b> 을(를) 마취! ` +
            `<b>+${RULES.SCORE_TRANQ_LEADER}점</b>`
          : `💤 <b>${m.byNick}</b> 이(가) <b>${m.nick}</b> 을(를) 마취시켰습니다`);
      }
    });
    n.on('up', (m) => { const r = this.remote.get(m.id); if (r) r.down = false; });
    n.on('wake', () => {
      this.down = false; this.hits = 0;
      document.getElementById('downOverlay').hidden = true;
      this.hud.toast('마취가 풀렸습니다! 다시 뛰어보세요', 'good');
    });

    n.on('toast', (m) => this.hud.toast(m.msg, m.bad ? 'bad' : m.good ? 'good' : null));
    n.on('quick', (m) => this.hud.addChat(m.nick, m.msg));

    n.on('solved', (m) => {
      if (m.team === this.myTeam) { Sfx.correct(); this.hud.solved[m.bi] = true; this.hud.renderAnswer(); this.hud.renderNote(); }
      else this.hud.feed(`✅ ${TEAM_NAMES[m.team]} 이(가) 비커 ${'ABC'[m.bi]} 정답!`);
    });

    n.on('reveal', (m) => {
      document.getElementById('revealAnswers').innerHTML = m.answers.map(a =>
        `<div class="rv"><div class="lb">${a.label}</div><div><div class="nm">${a.name}</div>
         <div class="nu">포함 영양소 : ${a.has.length ? a.has.map(h => ({ starch: '녹말', sugar: '당류', protein: '단백질', fat: '지방' }[h])).join(' · ') : '없음 (4가지 모두 음성)'}</div>
         </div></div>`).join('');
      // ★ 순위 = 음료 3개를 먼저 다 맞힌 순서
      const mm = (s) => s == null ? '' :
        `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
      document.getElementById('revealRank').innerHTML =
        `<p class="hint" style="margin:0 0 8px">순위는 <b>음료 3개를 먼저 다 맞힌 순서</b>입니다.</p>` +
        m.ranking.map((t) => {
          const medal = ['🥇', '🥈', '🥉'][(t.finishOrder || 0) - 1];
          return `<div class="rv${t.finishOrder ? ' podium' : ''}">
            <div class="lb">${medal || t.rank}</div>
            <div><div class="nm">
              <span style="display:inline-block;width:11px;height:11px;border-radius:4px;
                background:${t.color};border:1px solid #fff;vertical-align:-1px"></span>
              ${t.name} <span style="font-size:12px;color:#93a3b4">${t.colorName} 모자</span></div>
            <div class="nu">${t.finishOrder
              ? `<b style="color:#ffcc4d">완주 ${mm(t.seconds)}</b> · `
              : `비커 ${t.solved}/3 · 검사 ${t.tested}/12 · `}${t.score}점
              ${t.members.length ? `<br>${t.members.join(' · ')}` : ''}</div></div></div>`;
        }).join('');
      document.getElementById('revealOverlay').hidden = false;
      this.hud.closePanels();
    });
  }

  // 슈팅 모드용 효과음 다리 (battle-ui.js 에서 부른다)
  sfxPickup() { Sfx.pickup(); }
  sfxHurt() { Sfx.hurt(); }
  sfxHitmark() { Sfx.hitmark(); }
  sfxDown() { Sfx.down(); }
  sfxShot(far) { Sfx.shot(far); }

  // ---------------- ★ 조준경 (두 손가락 확대 / 마우스 휠) ----------------
  //  저격총은 6배까지, 다른 총은 조금만 당겨진다. 당길수록 조준 감도가 낮아진다.
  setZoom(z) {
    const g = this.mode === 'battle' ? this.battle.gunDef() : null;
    const max = g ? (g.zoom || 1.6) : 1;
    const nz = Math.max(1, Math.min(max, z));
    if (Math.abs(nz - this.zoom) < 0.001) return;
    this.zoom = nz;
    this.input.lookScale = 1 / Math.sqrt(this.zoom);      // 당기면 손이 덜 떨리게
    this.camera.fov = 72 / this.zoom;
    this.camera.updateProjectionMatrix();
    if (this.mode === 'battle') this.battle.paintScope(this.zoom, g);
  }
  resetZoom() { this.setZoom(1); }
  flashRemote(id) { const r = this.remote.get(id); if (r) flashMuzzle(r.avatar); }

  // 아바타 색 — 실험 모드는 모둠 색, 슈팅 모드는 분대 색
  colorFor(id, team) {
    if (this.mode === 'battle') {
      const s = this.squadById.get(id);
      return this.battle.squadColor(s === undefined ? 0 : s);
    }
    return TEAM_COLORS[(team ?? 8) % TEAM_COLORS.length];
  }
  mySide() {
    return this.mode === 'battle' ? (this.battle.mySquad ?? -1) : this.myTeam;
  }
  sideOf(id, team) {
    return this.mode === 'battle' ? (this.squadById.get(id) ?? -2) : team;
  }
  refreshSquadColors() {
    if (this.mode !== 'battle') return;
    for (const [id, r] of this.remote) {
      const c = this.colorFor(id, r.team);
      if (r.color === c) continue;
      r.color = c;
      this.scene.remove(r.avatar);
      r.avatar = makeAvatar(c, this.quality);
      this.scene.add(r.avatar);
    }
    const mine = this.colorFor(this.selfId, this.myTeam);
    if (this._avatarColor !== mine) {
      this._avatarColor = mine;
      this.scene.remove(this.avatar);
      this.avatar = makeAvatar(mine, this.quality);
      this.scene.add(this.avatar);
    }
  }

  _addRemote(id) {
    const info = this.rosterById.get(id);
    const color = this.colorFor(id, info?.team);
    const av = makeAvatar(color, this.quality);
    this.scene.add(av);
    const r = { avatar: av, buf: [], nick: info?.nick || '???', team: info?.team ?? -1, color, down: false, x: 0, z: 0, y: 0 };
    this.remote.set(id, r);
    return r;
  }

  // ---------------- 탄약 ----------------
  selectAmmo(i) {
    this.ammoIdx = Math.max(0, Math.min(4, i | 0));
    const s = this.hud.ammoSlots[this.ammoIdx];
    setGunTank(this.avatar, s.id === 'tranq' ? '#7fd4ff' : REAGENTS[s.id].color);
    this.hud.updateAmmo(this.reagents, this.tranq, this.ammoIdx, this.collected);
  }
  currentAmmo() { return this.hud.ammoSlots[this.ammoIdx].id; }
  ammoCount() {
    const a = this.currentAmmo();
    return a === 'tranq' ? this.tranq : (this.reagents[a] | 0);
  }

  // ---------------- 사격 ----------------
  // ---------------- ★ 슈팅 모드 사격 ----------------
  //  총마다 연사 속도·사거리·탄퍼짐이 다르다. 판정(체력/명중)은 전부 서버가 한다.
  _battleShoot(now) {
    const B = this.battle;
    if (B.phase !== 'playing') { this._practiceShot(now); return; }
    if (!B.canShoot()) {
      if (B.mag <= 0 && B.ammo <= 0 && now - (this._emptyAt || 0) > 1500) {
        this._emptyAt = now;
        this.hud.toast('탄약이 없습니다! 📦 탄약 상자를 찾으세요', 'bad');
        Sfx.blip(160, 0.08, 'square', 0.05);
      }
      return;
    }
    const g = B.gunDef();
    if (now - this.lastShot < g.cd) return;
    this.lastShot = now;
    B.mag = Math.max(0, B.mag - 1);          // 화면은 바로 반영, 정확한 값은 서버가 보내 준다
    B.paint();

    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3()).normalize();
    // 탄퍼짐 — 뛰거나 서 있을 때 더 벌어진다
    const spread = g.spread * (this.input.crouching ? 0.55 : this.me.speed > 4 ? 1.7 : 1);
    if (spread > 0) {
      dir.x += (Math.random() - 0.5) * spread;
      dir.y += (Math.random() - 0.5) * spread;
      dir.z += (Math.random() - 0.5) * spread;
      dir.normalize();
    }

    let best = g.range, hitType = null, hitId = null;
    const mySide = this.mySide();
    for (const [id, r] of this.remote) {
      if (this.sideOf(id, r.team) === mySide) continue;   // 같은 분대는 안 맞음
      if (r.down) continue;
      const t = rayAABB(origin, dir, r.x - 0.45, r.y, r.z - 0.45, r.x + 0.45, r.y + 1.95, r.z + 0.45);
      if (t !== null && t > 0.5 && t < best) { best = t; hitType = 'player'; hitId = id; }
    }
    const w = this.world.raycastSolids(origin, dir, best);
    if (w.dist < best) { best = w.dist; hitType = 'world'; hitId = null; }
    const hitPt = origin.clone().addScaledVector(dir, best);

    const muzzle = new THREE.Vector3();
    this.avatar.userData.muzzle.getWorldPosition(muzzle);
    flashMuzzle(this.avatar);
    Sfx.shot(0);
    this.hud.addGunshot(this.me.x, this.me.z);
    this._tracerColor([muzzle.x, muzzle.y, muzzle.z], [hitPt.x, hitPt.y, hitPt.z], g.color);
    this._impactColor(hitPt, g.color);

    const msg = {
      t: 'shoot', gun: g.id,
      ox: muzzle.x, oy: muzzle.y, oz: muzzle.z,
      hx: hitPt.x, hy: hitPt.y, hz: hitPt.z,
    };
    if (hitType === 'player') { msg.hit = 'player'; msg.tid = hitId; }
    this.net.send(msg);
    // 반동 — 총마다 다르고, 튄 만큼은 step() 에서 저절로 되돌아온다
    const kick = (g.recoil ?? 0.012) * (this.input.crouching ? 0.6 : 1);
    this.me.pitch = Math.max(-1.2, this.me.pitch - kick);
    this._recoil = Math.min(0.35, (this._recoil || 0) + kick);
  }

  tryShoot() {
    const now = performance.now();
    if (this.mode === 'battle') {
      if (this.battle.dead) return;
      this._battleShoot(now);
      return;
    }
    if (this.down) return;
    if (this.phase === 'playing' && this.roundOver) return;
    if (this.phase === 'playing' && Date.now() < this.startAt) return;   // 카운트다운
    if (this.lockUntil > Date.now()) return;              // 총 압수 중
    if (now - this.lastShot < RULES.FIRE_COOLDOWN_MS) return;

    // 대기 공간 — 탄약 무제한 연습 사격
    if (this.phase !== 'playing') { this._practiceShot(now); return; }

    const ammo = this.currentAmmo();
    if (this.currentAmmo() === 'tranq' && this.inSafe) {
      if (now - (this._safeWarn || 0) > 2500) {
        this._safeWarn = now;
        this.hud.toast('🛡 안전구역 안에서는 마취총을 쏠 수 없습니다', 'bad');
      }
      return;
    }
    if (this.ammoCount() <= 0) {
      if (now - (this._emptyAt || 0) > 1200) {
        this._emptyAt = now;
        this.hud.toast(ammo === 'tranq' ? '마취탄이 없어요 (시간이 지나면 보급됩니다)'
          : `${REAGENTS[ammo].shortName} 탄알이 없어요. 섬에서 시약을 더 주우세요!`, 'bad');
        Sfx.blip(160, 0.08, 'square', 0.05);
      }
      return;
    }
    this.lastShot = now;

    // 카메라 정중앙에서 레이 발사
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3()).normalize();

    let best = RULES.MAX_RANGE, hitType = null, hitId = null, hitPt = null;

    // 사람
    for (const [id, r] of this.remote) {
      if (r.team === this.myTeam) continue;
      const t = rayAABB(origin, dir, r.x - 0.42, r.y, r.z - 0.42, r.x + 0.42, r.y + 1.95, r.z + 0.42);
      if (t !== null && t > 0.5 && t < best) { best = t; hitType = 'player'; hitId = id; }
    }
    // 비커 (원기둥 근사) — 섬에 6개, hitId 는 '비커 번호'
    this.world.beakers.forEach((b, i) => {
      if (Math.hypot(b.x - this.me.x, b.z - this.me.z) > RULES.MAX_RANGE) return;
      const t = rayAABB(origin, dir, b.x - 2.7, b.y + 0.4, b.z - 2.7, b.x + 2.7, b.y + 8.0, b.z + 2.7);
      if (t !== null && t > 0.5 && t < best) { best = t; hitType = 'beaker'; hitId = i; }
    });
    // 지형/구조물
    const w = this.world.raycastSolids(origin, dir, best);
    if (w.dist < best) { best = w.dist; hitType = 'world'; hitId = null; }

    hitPt = origin.clone().addScaledVector(dir, best);

    // 총구 위치
    const muzzle = new THREE.Vector3();
    this.avatar.userData.muzzle.getWorldPosition(muzzle);
    flashMuzzle(this.avatar);
    Sfx.shot(0);
    this.hud.addGunshot(this.me.x, this.me.z);

    this._tracer([muzzle.x, muzzle.y, muzzle.z], [hitPt.x, hitPt.y, hitPt.z], ammo);
    this._impact(hitPt, ammo);

    const msg = {
      t: 'shoot', ammo,
      ox: muzzle.x, oy: muzzle.y, oz: muzzle.z,
      hx: hitPt.x, hy: hitPt.y, hz: hitPt.z,
    };
    if (hitType === 'player') { msg.hit = 'player'; msg.tid = hitId; }
    else if (hitType === 'beaker') { msg.hit = 'beaker'; msg.bi = hitId; }
    this.net.send(msg);

    // 반동
    this.me.pitch = Math.max(-1.2, this.me.pitch - 0.022);
  }

  // 대기 공간용 연습 사격 (탄약 소모 없음, 판정 없음)
  _practiceShot(now) {
    this.lastShot = now;
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3()).normalize();
    const w = this.world.raycastSolids(origin, dir, 120);
    const hit = origin.clone().addScaledVector(dir, w.dist);
    const muzzle = new THREE.Vector3();
    this.avatar.userData.muzzle.getWorldPosition(muzzle);
    flashMuzzle(this.avatar);
    Sfx.shot(0);
    const ammo = this.currentAmmo();
    this._tracer([muzzle.x, muzzle.y, muzzle.z], [hit.x, hit.y, hit.z], ammo);
    this._impact(hit, ammo);
    this.me.pitch = Math.max(-1.2, this.me.pitch - 0.022);
    this.net.send({
      t: 'shoot', ammo, practice: true,
      ox: muzzle.x, oy: muzzle.y, oz: muzzle.z,
      hx: hit.x, hy: hit.y, hz: hit.z,
    });
    // 과녁을 맞히면 표시
    for (const tg of (this.world.trainTargets || [])) {
      if (hit.distanceTo(tg.pos) < 2.6) { this.world.hitTarget(tg); Sfx.hitmark(); this.hud.hitmark(); }
    }
  }

  _tracer(o, h, ammo) {
    this._tracerColor(o, h, ammo === 'tranq' ? '#9fe6ff' : REAGENTS[ammo]?.color || '#ffffff');
  }

  _tracerColor(o, h, col) {
    const tr = this.tracers.find(t => !t.line.visible) || this.tracers[0];
    const p = tr.line.geometry.attributes.position;
    p.setXYZ(0, o[0], o[1], o[2]);
    p.setXYZ(1, h[0], h[1], h[2]);
    p.needsUpdate = true;
    tr.line.material.color.set(col);
    tr.line.material.opacity = 0.95;
    tr.line.visible = true;
    tr.until = performance.now() + 130;
  }

  _impact(pt, ammo) {
    this._impactColor(pt, ammo === 'tranq' ? '#9fe6ff' : REAGENTS[ammo]?.color || '#fff');
  }

  _impactColor(pt, col) {
    const im = this.impacts.find(t => !t.mesh.visible) || this.impacts[0];
    im.mesh.position.copy(pt);
    im.mesh.material.color.set(col);
    im.mesh.material.opacity = 0.9;
    im.mesh.scale.setScalar(0.5);
    im.mesh.visible = true;
    im.until = performance.now() + 260;
  }

  _splash(bi, color) {
    const b = this.world.beakers[bi];
    const p = this.splash.geometry.attributes.position;
    const N = p.count;
    for (let i = 0; i < N; i++) {
      p.setXYZ(i, b.x + (Math.random() - .5) * 1.5, b.y + 5 + Math.random() * 2, b.z + (Math.random() - .5) * 1.5);
      this.splashVel[i * 3] = (Math.random() - .5) * 7;
      this.splashVel[i * 3 + 1] = 4 + Math.random() * 7;
      this.splashVel[i * 3 + 2] = (Math.random() - .5) * 7;
    }
    p.needsUpdate = true;
    this.splashMat.color.set(color);
    this.splashMat.opacity = 1;
    this.splash.visible = true;
    this.splashUntil = performance.now() + 1400;
  }

  // ---------------- 물리/이동 ----------------
  step(dt) {
    const me = this.me;
    const look = this.input.consumeLook();
    if (!this.hud.anyPanelOpen() && !this.down) {
      me.yaw -= look.x;
      me.pitch = Math.max(-1.25, Math.min(1.25, me.pitch - look.y));
    }

    // ★ 반동 회복 — 쏘면 화면이 위로 튀지만 저절로 제자리로 돌아온다.
    //   (예전에는 튄 만큼 그대로 남아서 기관단총을 쏘면 하늘만 보게 됐다)
    if (this._recoil > 0) {
      const back = Math.min(this._recoil, RECOIL_RECOVER * dt);
      me.pitch += back;
      this._recoil -= back;
    }

    if (this.down) { me.speed = 0; return; }
    if (this.phase === 'playing' && Date.now() < this.startAt) { me.speed = 0; return; }

    const crouch = this.input.crouching;
    // 앉으면 달릴 수 없고 아주 느려진다 (엄폐·잠복용)
    let sp = (this.input.running && !crouch) ? RULES.RUN_SPEED : RULES.WALK_SPEED;
    if (crouch) sp = RULES.WALK_SPEED * RULES.CROUCH_SPEED_MULT;

    const mv = this.input.move;
    const mag = Math.min(1, Math.hypot(mv.x, mv.y));
    const fwd = new THREE.Vector3(Math.sin(me.yaw), 0, Math.cos(me.yaw));
    // 화면 기준 오른쪽 = fwd × up = (-cos yaw, 0, sin yaw)
    // (예전 버전은 부호가 반대여서 좌우가 뒤집혀 있었다)
    const right = screenRight(me.yaw);

    let vx = 0, vz = 0;
    if (mag > 0.08) {
      const nx = mv.x / (mag || 1), ny = mv.y / (mag || 1);
      vx = (fwd.x * ny + right.x * nx) * sp * mag;
      vz = (fwd.z * ny + right.z * nx) * sp * mag;
    }
    me.speed = Math.hypot(vx, vz);

    me.x += vx * dt;
    me.z += vz * dt;

    if (this.phase === 'playing') {
      // 섬 밖으로 못 나가게
      const d = Math.hypot(me.x, me.z);
      if (d > MAP.PLAY_R) {
        me.x *= MAP.PLAY_R / d; me.z *= MAP.PLAY_R / d;
        if (!this._edgeWarn || performance.now() - this._edgeWarn > 4000) {
          this._edgeWarn = performance.now();
          this.hud.toast('섬 밖은 바다입니다. 안쪽으로!', 'bad');
        }
      }
    } else {
      // 대기 공간 밖으로 못 나가게
      const H = TRAIN.half - 1.2;
      me.x = Math.max(TRAIN.cx - H, Math.min(TRAIN.cx + H, me.x));
      me.z = Math.max(TRAIN.cz - H, Math.min(TRAIN.cz + H, me.z));
      if (me.y < TRAIN.floorY - 3) { me.y = TRAIN.floorY; me.vy = 0; }
    }

    // 점프/중력 — 앉은 채로는 못 뛴다
    if (this.input.consumeJump() && me.onGround && !crouch) {
      me.vy = RULES.JUMP_V;
      me.onGround = false;
      Sfx.blip(320, 0.07, 'sine', 0.05, 520);
    }
    me.vy -= RULES.GRAVITY * dt;
    me.y += me.vy * dt;

    const groundY = this.world.resolve(me, PLAYER_R, crouch ? 1.2 : 1.85);
    if (me.y <= groundY) { me.y = groundY; me.vy = 0; me.onGround = true; }
    else if (me.vy < -0.4) me.onGround = false;

    // 대기 공간에서는 시약/비커 상호작용이 없다
    if (this.phase !== 'playing') { this.hud.showPrompt(null); return; }

    // ---- ★ 슈팅 모드 : 보급 상자 자동 획득 ----
    if (this.mode === 'battle') {
      const px0 = this._prevX ?? me.x, pz0 = this._prevZ ?? me.z;
      this._prevX = me.x; this._prevZ = me.z;
      const txt = this.battle.stepLoot(me, px0, pz0, segDist2D);
      if (performance.now() - this.lastPickTry > 200) {
        this.lastPickTry = performance.now();
        this.hud.showPrompt(txt);
      }
      return;
    }

    // ---- 시약 자동 획득 ----
    // 빠르게 뛰면 한 프레임 사이에 상자를 지나칠 수 있으므로 매 프레임 검사한다.
    // 또, '가장 가까운 상자 하나'만 보면 그게 가득 찬 종류일 때 옆의 다른 상자를
    // 영영 못 줍는다 → 반경 안의 상자를 전부 훑는다.
    const now = performance.now();
    let promptNear = null, promptDist = 1e9;
    // 프레임이 끊긴 사이에 상자를 '뛰어넘는' 것을 막기 위해, 이번 프레임에 지나온
    // 선분(이전 위치 → 지금 위치)까지 검사한다. 태블릿이 느릴수록 중요하다.
    const px = this._prevX ?? me.x, pz = this._prevZ ?? me.z;
    this._prevX = me.x; this._prevZ = me.z;
    for (const m of this.world.pickupMeshes.values()) {
      if (!m.visible) continue;
      const dd = segDist2D(m.data.x, m.data.z, px, pz, me.x, me.z);
      const straight = Math.hypot(m.data.x - me.x, m.data.z - me.z);
      if (straight < promptDist) { promptDist = straight; promptNear = m; }
      if (dd >= RULES.PICKUP_RADIUS) continue;
      if (Math.abs(m.data.y - me.y) > 4) continue;
      // 이미 가득 찬 종류는 굳이 요청하지 않는다 (서버도 거절한다)
      if ((this.reagents[m.data.reagent] | 0) >= RULES.REAGENT_MAX_CARRY) continue;
      if (now - (this.pickSentAt?.[m.data.id] || 0) < 700) continue;
      (this.pickSentAt ||= {})[m.data.id] = now;
      // 내 위치를 같이 보낸다 — 서버 위치가 잠깐 뒤처져 있어도 인정받도록
      this.net.send({ t: 'pick', id: m.data.id, x: +me.x.toFixed(2), z: +me.z.toFixed(2) });
    }

    if (now - this.lastPickTry > 200) {
      this.lastPickTry = now;
      if (promptNear && promptDist < 12) {
        const rg = REAGENTS[promptNear.data.reagent];
        const have = this.reagents[promptNear.data.reagent] | 0;
        this.hud.showPrompt(have >= RULES.REAGENT_MAX_CARRY
          ? `${rg.shortName} 탄알이 가득 찼습니다 (${have}발) — 비커에 쓰고 오세요`
          : `${rg.shortName} 시약 — 가까이 가면 자동 획득 (${promptDist.toFixed(0)}m · 보유 ${have}발)`);
      } else {
        let bn = null, bd = 1e9;
        for (const b of this.world.beakers) {
          const dd = Math.hypot(b.x - me.x, b.z - me.z);
          if (dd < bd) { bd = dd; bn = b; }
        }
        if (bn && bd < 24) this.hud.showPrompt(`미지의 음료 (${bn.label}) — 시약 탄알로 조준해서 쏘세요`);
        else this.hud.showPrompt(null);
      }
    }
  }

  // ---------------- 카메라 ----------------
  updateCamera() {
    const me = this.me;
    const eye = this.input.crouching ? CROUCH_EYE : EYE;
    const head = new THREE.Vector3(me.x, me.y + eye, me.z);

    const cp = Math.cos(me.pitch), sp = Math.sin(me.pitch);
    const fwd = new THREE.Vector3(Math.sin(me.yaw) * cp, sp, Math.cos(me.yaw) * cp).normalize();
    const right = screenRight(me.yaw);

    // ★ 조준경을 당기면 1인칭(눈높이)으로 붙는다 — 6배로 어깨 너머를 보면 못 쓴다
    if (this.zoom > 1.35) {
      this.camera.position.copy(head).addScaledVector(fwd, 0.25);
      this.camera.lookAt(this.camera.position.clone().addScaledVector(fwd, 60));
      if (this.sun.castShadow) {
        this.sun.position.set(me.x + 90, 130, me.z + 60);
        this.sun.target.position.set(me.x, 0, me.z);
        this.sun.target.updateMatrixWorld();
      }
      return;
    }

    // 배그식 오버숄더: 카메라를 오른쪽 어깨 위로 평행 이동시킨다.
    // 시선을 캐릭터 쪽으로 되돌리지 않기 때문에 몸이 화면 왼쪽 아래로 빠지고,
    // 조준점(화면 정중앙)이 곧 총알이 날아가는 방향이 된다.
    const pivot = head.clone()
      .addScaledVector(right, 0.95)
      .add(new THREE.Vector3(0, 0.5, 0));

    const dir = fwd.clone().negate();
    const len = 4.2;
    const hit = this.world.raycastSolids(pivot, dir, len);
    const dist = Math.max(1.2, Math.min(len, hit.dist - 0.35));
    this.camera.position.copy(pivot).addScaledVector(dir, dist);

    // 카메라가 땅속으로 파고들면 지면이 뚫려 바다가 비쳐 보인다 → 항상 지면 위로 올린다
    if (this.phase === 'playing') {
      const gy = terrainHeight(this.camera.position.x, this.camera.position.z) + 0.55;
      if (this.camera.position.y < gy) this.camera.position.y = gy;
    } else if (this.camera.position.y < TRAIN.floorY + 0.55) {
      this.camera.position.y = TRAIN.floorY + 0.55;
    }

    this.camera.lookAt(this.camera.position.clone().addScaledVector(fwd, 60));

    // 태양 그림자 카메라를 따라오게
    if (this.sun.castShadow) {
      this.sun.position.set(me.x + 90, 130, me.z + 60);
      this.sun.target.position.set(me.x, 0, me.z);
      this.sun.target.updateMatrixWorld();
    }
  }

  // ---------------- 이름표 ----------------
  updateTags() {
    const items = [];
    const v = new THREE.Vector3();
    const camPos = this.camera.position;
    for (const [id, r] of this.remote) {
      if (!r.buf.length) continue;
      v.set(r.x, r.y + 2.15, r.z);
      const dist = camPos.distanceTo(v);
      if (dist > 120) continue;
      v.project(this.camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) continue;
      const battle = this.mode === 'battle';
      const mate = battle ? this.sideOf(id, r.team) === this.mySide() : r.team === this.myTeam;
      items.push({
        x: (v.x * 0.5 + 0.5) * innerWidth,
        y: (-v.y * 0.5 + 0.5) * innerHeight,
        nick: r.nick, mate, down: r.down, hits: 0,
        leader: !battle && this.leader && r.team === this.leader.team && !mate,
        medal: battle ? '' : (this.finished && this.finished[r.team]) ? this.finished[r.team].medal : '',
        opacity: dist > 90 ? 0.45 : dist > 55 ? 0.75 : 1,
      });
    }
    this.hud.updateTags(items);
  }

  // ---------------- 루프 ----------------
  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const now = performance.now();

    this.step(dt);
    this.updateCamera();

    // 내 아바타
    this.avatar.position.set(this.me.x, this.me.y, this.me.z);
    this.avatar.rotation.y = this.me.yaw;
    animateAvatar(this.avatar, dt, this.me.speed, this.down, t, this.input.crouching);
    // 3인칭에서 내 몸이 카메라를 가리지 않게 살짝 투명 처리
    const near = this.camera.position.distanceTo(this.avatar.position) < 1.7;
    this.avatar.visible = !near && this.zoom <= 1.35;

    // 원격 보간
    const rt = now - INTERP_DELAY;
    for (const [id, r] of this.remote) {
      const b = r.buf;
      if (!b.length) continue;
      let a = b[0], c = b[b.length - 1];
      for (let i = 0; i < b.length - 1; i++) {
        if (b[i].t <= rt && b[i + 1].t >= rt) { a = b[i]; c = b[i + 1]; break; }
      }
      const span = Math.max(1, c.t - a.t);
      const k = Math.max(0, Math.min(1, (rt - a.t) / span));
      const px = r.x, pz = r.z;
      r.x = a.x + (c.x - a.x) * k;
      r.y = a.y + (c.y - a.y) * k;
      r.z = a.z + (c.z - a.z) * k;
      let dy = c.yaw - a.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      r.yaw = a.yaw + dy * k;
      r.avatar.position.set(r.x, r.y, r.z);
      r.avatar.rotation.y = r.yaw;
      // 멀리 있는 사람은 아예 그리지 않는다 (32명 동시 접속 대비)
      const far = Math.hypot(r.x - this.me.x, r.z - this.me.z);
      r.avatar.visible = far < 170;
      if (!r.avatar.visible) continue;
      const spd = Math.hypot(r.x - px, r.z - pz) / Math.max(dt, 0.001);
      r.smoothSpeed = (r.smoothSpeed || 0) * 0.7 + Math.min(spd, 12) * 0.3;
      animateAvatar(r.avatar, dt, r.smoothSpeed, r.down, t, r.crouch);
    }

    // 사격
    if (this.input.firing && !this.hud.anyPanelOpen()) this.tryShoot();

    // 이펙트 정리
    for (const tr of this.tracers) {
      if (tr.line.visible) {
        const left = (tr.until - now) / 130;
        if (left <= 0) tr.line.visible = false;
        else tr.line.material.opacity = left;
      }
    }
    for (const im of this.impacts) {
      if (im.mesh.visible) {
        const left = (im.until - now) / 260;
        if (left <= 0) im.mesh.visible = false;
        else { im.mesh.material.opacity = left * 0.9; im.mesh.scale.setScalar(0.5 + (1 - left) * 1.6); }
      }
    }
    if (this.splash.visible) {
      const left = (this.splashUntil - now) / 1400;
      if (left <= 0) this.splash.visible = false;
      else {
        const p = this.splash.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          this.splashVel[i * 3 + 1] -= 15 * dt;
          p.setXYZ(i,
            p.getX(i) + this.splashVel[i * 3] * dt,
            p.getY(i) + this.splashVel[i * 3 + 1] * dt,
            p.getZ(i) + this.splashVel[i * 3 + 2] * dt);
        }
        p.needsUpdate = true;
        this.splashMat.opacity = left;
      }
    }

    // ---- 안전구역 판정 (실험 모드 전용 — 슈팅 모드엔 안전구역이 없다) ----
    if (this.phase === 'playing' && this.mode === 'science') {
      const z = safeZoneAt(this.me.x, this.me.z);
      if ((z && z.team) !== (this.inSafe && this.inSafe.team) || (!!z !== !!this.inSafe)) {
        this.inSafe = z;
        this.hud.setSafeZone(z);
        if (z) Sfx.blip(880, 0.09, 'triangle', 0.05, 1200);
      }
      this.inSafe = z;
    } else if (this.inSafe) { this.inSafe = null; this.hud.setSafeZone(null); }

    // ---- 시작 카운트다운 ----
    if (this.phase === 'playing' && Date.now() < this.startAt) {
      this.hud.showCountdown(Math.ceil((this.startAt - Date.now()) / 1000));
    } else if (this._cdShown) {
      this.hud.showCountdown(0);
    }
    this._cdShown = this.phase === 'playing' && Date.now() < this.startAt;

    this.world.updateBeakers(t, this.camera);
    this.world.updateFires(t, this.camera);
    if (this.mode === 'battle') this.world.updateLoot(t);
    else this.world.updatePickups(t);
    this.updateTags();

    // ★ 슈팅 모드 — 남은 시간 / 자기장 / 부활 카운트 (1초에 한 번)
    if (this.mode === 'battle' && now - (this._bTickAt || 0) > 500) {
      this._bTickAt = now;
      this.battle.tick();
    }

    // ★ 가열 — 남은 시간 표시(0.4초마다) + 몸에 붙은 불 애니메이션(매 프레임)
    if (now - (this._heatPaintAt || 0) > 400) {
      this._heatPaintAt = now;
      this.hud._paintHeat();
    }
    this._updateFlames(t);

    // 마취 카운트다운
    if (this.down) {
      const s = Math.max(0, Math.ceil((this.downUntil - Date.now()) / 1000));
      document.getElementById('downSec').textContent = s;
    }
    // 총 압수 카운트다운
    if (this.lockUntil) {
      const s = Math.max(0, Math.ceil((this.lockUntil - Date.now()) / 1000));
      document.getElementById('lockSec').textContent = s;
      if (s <= 0) { this.lockUntil = 0; document.getElementById('lockOverlay').hidden = true; }
    }

    // 라운드 타이머 (슈팅 모드에서는 battle-ui 가 자기 시간을 쓴다)
    if (this.roundEndsAt && this.mode !== 'battle') {
      const left = Math.max(0, Math.floor((this.roundEndsAt - Date.now()) / 1000));
      document.getElementById('roundTimer').textContent =
        `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    }

    this.hud.drawCompass(this.me);

    // 미니맵 (3프레임에 1번)
    this._mmTick = (this._mmTick || 0) + 1;
    if (this._mmTick % 3 === 0) {
      this.hud.drawMinimap(this.me, [...this.remote.values()],
        this.mode === 'battle' ? [] : [...this.world.pickupMeshes.values()],
        this.myTeam, this.phase, this.mode === 'battle' ? this.battle : null);
    }

    // 서버로 위치 전송 (15Hz)
    if (now - this.lastSend > 66) this.sendPos();

    this.renderer.render(this.scene, this.camera);

    // ★ 선생님 화면 송출 — 반드시 render() 바로 뒤, 같은 프레임 안에서 읽어야
    //   preserveDrawingBuffer 없이도 캔버스 내용을 가져올 수 있다.
    //
    //   화면을 뜨는 일은 GPU→CPU 복사라 태블릿에서 무겁다. 그래서
    //     · 캡처에 걸린 시간을 재서 간격을 스스로 늘린다 (렉의 원인 제거)
    //     · JPEG 인코딩은 toBlob 으로 비동기 처리 (메인 스레드를 잡지 않는다)
    //     · 앞 장을 아직 못 보냈으면 이번 장은 건너뛴다
    //     · 앱을 내려두면 아예 뜨지 않는다
    if (this.streaming && !this._capBusy && !document.hidden &&
        now - (this._lastFrameAt || 0) >= this._captureInterval()) {
      this._lastFrameAt = now;
      this._sendFrame();
    }
  }

  // 캡처 간격(ms) — 서버가 정한 fps 와 '실제 캡처 비용' 중 느린 쪽을 따른다.
  // 캡처 한 번이 화면 시간의 10%를 넘지 않도록 스스로 감속한다.
  _captureInterval() {
    const want = 1000 / (this.streamFps || RULES.WATCH_FPS || 2);
    const cost = this._capCost || 0;
    return Math.min(4000, Math.max(want, cost * 10));
  }

  // 내 위치를 서버에 알린다. 그림 그리는 루프와 별도로도 불린다 —
  // 태블릿 화면이 꺼지거나 앱이 잠깐 내려가면 rAF 가 멈춰서 위치 전송이 끊기는데,
  // 그러면 서버가 아는 위치가 뒤처져 시약·불꽃 근접 판정이 실패한다.
  sendPos() {
    this.lastSend = performance.now();
    this.net.send({
      t: 'in', x: +this.me.x.toFixed(2), y: +this.me.y.toFixed(2), z: +this.me.z.toFixed(2),
      yaw: +this.me.yaw.toFixed(3), pitch: +this.me.pitch.toFixed(3),
      f: (this.me.speed > 0.5 ? 1 : 0) | (this.input.running ? 2 : 0) | (this.input.crouching ? 4 : 0),
    });
  }

  // ---------------- ★ 몸에 붙은 불 ----------------
  //  가열된 사람 머리 위에서 타오른다. 나도, 다른 학생도 보인다.
  //  (불이 붙은 친구를 보고 "아 저기 불이 있구나" 하고 따라가게 된다)
  _updateFlames(t) {
    if (!this._flamePool) {
      this._flamePool = [];
      const geo = new THREE.ConeGeometry(0.21, 0.66, 6);
      geo.translate(0, 0.33, 0);
      this._flameGeo = geo;
      this._flameMats = ['#ff5d1f', '#ffb02b', '#ffe066'].map(c =>
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthWrite: false }));
    }
    // 불이 필요한 대상 모으기 : 나 + 가열된 다른 학생
    const targets = [];
    if (this.heatUntil > Date.now() && this.phase === 'playing') {
      targets.push({ x: this.me.x, y: this.me.y, z: this.me.z, crouch: this.input.crouching });
    }
    // 다른 학생의 불은 가까운 몇 명만 그린다 (32명이 전부 타오르면 태블릿이 힘들다)
    const nearHot = [];
    for (const r of this.remote.values()) {
      if (!r.hot || r.down) continue;
      const d = Math.hypot(r.x - this.me.x, r.z - this.me.z);
      if (d > 70) continue;
      nearHot.push({ d, x: r.x, y: r.y, z: r.z, crouch: r.crouch });
    }
    nearHot.sort((a, b) => a.d - b.d);
    for (const r of nearHot.slice(0, 8)) targets.push(r);

    const need = targets.length * 3;
    while (this._flamePool.length < need) {
      const i = this._flamePool.length;
      const m = new THREE.Mesh(this._flameGeo, this._flameMats[i % 3]);
      m.visible = false;
      this.scene.add(m);
      this._flamePool.push(m);
    }
    for (let i = 0; i < this._flamePool.length; i++) this._flamePool[i].visible = i < need;

    targets.forEach((tg, ti) => {
      const top = (tg.crouch ? 1.18 : 1.88);
      for (let k = 0; k < 3; k++) {
        const m = this._flamePool[ti * 3 + k];
        const ph = t * (4.0 + k) + ti * 2.3 + k * 1.9;
        const s = 0.8 + 0.25 * Math.sin(ph) - k * 0.16;
        m.position.set(
          tg.x + Math.sin(ph * 0.9) * 0.10,
          tg.y + top + k * 0.10,
          tg.z + Math.cos(ph * 0.8) * 0.10
        );
        m.rotation.set(Math.sin(ph) * 0.12, ph * 0.6, Math.cos(ph) * 0.12);
        m.scale.set(s, s * (1 + 0.25 * Math.sin(ph * 1.4)), s);
      }
    });
  }

  // ---------------- 교사용 화면 송출 ----------------
  _sendFrame() {
    try {
      const t0 = performance.now();
      if (!this._capCv) {
        this._capCv = document.createElement('canvas');
        this._capCv.width = 416; this._capCv.height = 234;
        this._capCx = this._capCv.getContext('2d', { alpha: false, willReadFrequently: false });
      }
      const cx = this._capCx, W = this._capCv.width, H = this._capCv.height;
      cx.drawImage(this.renderer.domElement, 0, 0, W, H);

      // 3D 화면만으로는 상황을 알기 어려우니 핵심 HUD를 얹어 준다
      cx.textBaseline = 'middle';
      cx.fillStyle = 'rgba(0,0,0,.55)';
      cx.fillRect(0, 0, W, 20);
      cx.fillRect(0, H - 22, W, 22);
      cx.font = 'bold 12px sans-serif';
      cx.textAlign = 'left';
      cx.fillStyle = this.teamColor;
      cx.fillText(`${this.myNick}`, 6, 10);
      cx.fillStyle = '#e8eef5';
      cx.fillText(`점수 ${this.score}`, 92, 10);
      cx.textAlign = 'right';
      const abc = [0, 1, 2].map(bi => `${'ABC'[bi]}${this.hud.solved[bi] ? '✓' : '·'}`).join(' ');
      cx.fillText(abc, W - 6, 10);

      cx.textAlign = 'left';
      const cur = this.hud.ammoSlots[this.ammoIdx];
      const ammoTxt = REAGENT_LIST.map(r =>
        `${REAGENTS[r].shortName.slice(0, 2)} ${this.reagents[r] | 0}`).join('  ');
      cx.fillStyle = '#c3cede';
      cx.fillText(ammoTxt, 6, H - 11);
      cx.textAlign = 'right';
      cx.fillStyle = this.quizPassed ? '#7fd4ff' : '#ff9c8f';
      cx.fillText(this.quizPassed ? `마취탄 ${this.tranq}` : '마취총 잠김', W - 6, H - 11);
      cx.textAlign = 'center';
      cx.fillStyle = '#ffcc4d';
      cx.fillText(`선택: ${cur ? (cur.id === 'tranq' ? '마취탄' : REAGENTS[cur.id].shortName) : '-'}`, W / 2, H - 11);

      // 조준점
      cx.strokeStyle = 'rgba(255,255,255,.9)'; cx.lineWidth = 1.5;
      cx.beginPath();
      cx.moveTo(W / 2 - 7, H / 2); cx.lineTo(W / 2 - 2, H / 2);
      cx.moveTo(W / 2 + 2, H / 2); cx.lineTo(W / 2 + 7, H / 2);
      cx.moveTo(W / 2, H / 2 - 7); cx.lineTo(W / 2, H / 2 - 2);
      cx.moveTo(W / 2, H / 2 + 2); cx.lineTo(W / 2, H / 2 + 7);
      cx.stroke();

      // 지금 무슨 창을 보고 있는지
      const open = document.querySelector('.panel:not([hidden])');
      const overlay = !document.getElementById('downOverlay').hidden ? '💤 마취됨'
        : !document.getElementById('lockOverlay').hidden ? '🚫 총 압수됨'
        : open ? { panelNote: '🧪 실험노트', panelAnswer: '✍️ 정답제출', panelQuiz: '🎓 자격시험',
                   panelRank: '🏆 순위', panelChat: '💬 모둠대화' }[open.id] : null;
      if (overlay) {
        cx.fillStyle = 'rgba(10,15,21,.82)';
        cx.fillRect(W / 2 - 78, H / 2 - 16, 156, 32);
        cx.fillStyle = '#ffcc4d';
        cx.font = 'bold 15px sans-serif';
        cx.textAlign = 'center';
        cx.fillText(overlay, W / 2, H / 2);
      }

      // 여기까지가 '메인 스레드를 잡는' 부분 — 비용을 재서 다음 간격에 반영한다
      const cost = performance.now() - t0;
      this._capCost = this._capCost ? this._capCost * 0.7 + cost * 0.3 : cost;

      // 상태값(작다)을 먼저 보내고, 그림은 바로 뒤에 바이너리로 붙인다.
      this.net.send({
        t: 'frameStat',
        fps: Math.round(1000 / this._captureInterval() * 10) / 10,
        cost: Math.round(this._capCost),
        st: {
          score: this.score, tranq: this.tranq, quiz: this.quizPassed,
          reagents: this.reagents,
          notes: this.hud.notes.map(o => Object.keys(o).length),
          solved: Object.keys(this.hud.solved).length,
          down: this.down, locked: this.lockUntil > Date.now(),
          hot: this.heatUntil > Date.now(),
        },
      });

      // JPEG 인코딩은 비동기로 — 여기서 메인 스레드를 붙잡지 않는다
      this._capBusy = true;
      this._capCv.toBlob((blob) => {
        this._capBusy = false;
        if (!blob || !this.streaming) return;
        blob.arrayBuffer().then((buf) => {
          if (this.streaming) this.net.sendBinary(buf);
        }).catch(() => {});
      }, 'image/jpeg', 0.42);
    } catch {
      this._capBusy = false;   /* 캡처 실패는 게임에 영향 없게 무시 */
    }
  }
}

// 화면 기준 '오른쪽' 벡터. 카메라가 fwd 를 바라볼 때 fwd × up 이 화면 오른쪽이 된다.
//   fwd = (sin y, 0, cos y),  up = (0,1,0)
//   fwd × up = (-cos y, 0, sin y)
function screenRight(yaw) {
  return new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
}

// 점 (px,pz) 와 선분 (ax,az)-(bx,bz) 사이의 최단 거리
function segDist2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  if (L2 < 1e-6) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

// ---- AABB 레이 교차 (사람/비커 판정용) ----
function rayAABB(o, d, x0, y0, z0, x1, y1, z1) {
  let tmin = -Infinity, tmax = Infinity;
  const p = [o.x, o.y, o.z], dd = [d.x, d.y, d.z], lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-8) { if (p[i] < lo[i] || p[i] > hi[i]) return null; continue; }
    let t1 = (lo[i] - p[i]) / dd[i], t2 = (hi[i] - p[i]) / dd[i];
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin > 0 ? tmin : (tmax > 0 ? tmax : null);
}

// ============================================================
//  로비
// ============================================================
const net = new Net();
const statusEl = document.getElementById('lobbyStatus');
const joinBtn = document.getElementById('joinBtn');
let quality = 'mid';

document.querySelectorAll('#qualitySeg button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#qualitySeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    quality = b.dataset.q;
  };
});
// 모바일이면 기본값을 '가볍게'로
if (matchMedia('(pointer: coarse)').matches) {
  document.querySelector('#qualitySeg button[data-q="low"]').click();
}

const sel = document.getElementById('teamSelect');
TEAM_NAMES.forEach((n, i) => {
  const o = document.createElement('option');
  o.value = i; o.textContent = n;
  sel.appendChild(o);
});

const savedNick = localStorage.getItem('godeok_nick');
if (savedNick) document.getElementById('nickInput').value = savedNick;

joinBtn.disabled = true;
net.connect().then(() => {
  statusEl.textContent = '서버 연결됨 — 닉네임을 넣고 시작하세요';
  statusEl.className = 'status ok';
  joinBtn.disabled = false;
}).catch(() => {
  statusEl.textContent = '서버에 연결할 수 없습니다. 선생님 노트북 주소가 맞는지, 같은 와이파이인지 확인하세요.';
  statusEl.className = 'status err';
});

joinBtn.onclick = () => {
  const nick = document.getElementById('nickInput').value.trim();
  if (!nick) { statusEl.textContent = '닉네임을 입력해 주세요'; statusEl.className = 'status err'; return; }
  localStorage.setItem('godeok_nick', nick);
  joinBtn.disabled = true;
  Sfx.init();

  net.on('init', (m) => {
    document.getElementById('lobby').remove();
    document.getElementById('game').hidden = false;
    // 전체화면 (태블릿에서 주소창 감추기)
    const el = document.documentElement;
    el.requestFullscreen?.().catch(() => {});
    screen.orientation?.lock?.('landscape').catch(() => {});
    window.__game = new Game(net, m, quality);
  });

  const team = parseInt(sel.value, 10);
  net.send({ t: 'join', nick, team: team >= 0 ? team : undefined });
};

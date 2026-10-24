// ============================================================
//  hud.js — 화면 UI (실험노트 · 정답제출 · 순위 · 미니맵 · 이름표)
// ============================================================
import { REAGENTS, REAGENT_LIST, DRINKS, NUTRIENTS, RULES, TEAM_COLORS, TEAM_NAMES } from './gamedata.js';
import { MAP, LAYOUT, TRAIN } from './layout.js';

export class HUD {
  constructor(game) {
    this.game = game;
    this.notes = [{}, {}, {}];       // [beaker][reagent] = true(양성)/false(음성)
    this.selected = [null, null, null];
    this.solved = {};
    this.hintOn = false;
    this.chat = [];
    this.tagPool = [];
    this.gunshots = [];              // 미니맵 총성 표시

    this.el = {
      tags: document.getElementById('tags'),
      toasts: document.getElementById('toasts'),
      feed: document.getElementById('feed'),
      prompt: document.getElementById('prompt'),
      ammoBar: document.getElementById('ammoBar'),
      minimap: document.getElementById('minimap'),
      note: document.getElementById('noteTable'),
      deduce: document.getElementById('noteDeduce'),
      answer: document.getElementById('answerForm'),
      rank: document.getElementById('rankBody'),
      chatLog: document.getElementById('chatLog'),
      quick: document.getElementById('quickBtns'),
      crosshair: document.getElementById('crosshair'),
      hurt: document.getElementById('hurtFlash'),
    };
    this.mctx = this.el.minimap.getContext('2d');
    this.el.compass = document.getElementById('compass');
    this.cctx = this.el.compass.getContext('2d');

    this._panels();
    this._quick();
    this.renderNote();
    this.renderAnswer();
  }

  // ---------------- 패널 열고 닫기 ----------------
  _panels() {
    const map = {
      note: 'panelNote', answer: 'panelAnswer', quiz: 'panelQuiz',
      rank: 'panelRank', chat: 'panelChat', gear: 'panelGear',
    };
    this.panelMap = map;
    const bind = (btn, key) => document.getElementById(btn)
      .addEventListener('click', () => this.togglePanel(key));
    bind('btnNote', 'note'); bind('btnAnswer', 'answer'); bind('btnQuiz', 'quiz');
    bind('btnRank', 'rank'); bind('btnChat', 'chat');
    document.querySelectorAll('.panel .x').forEach(x =>
      x.addEventListener('click', () => this.closePanels()));
    document.getElementById('resultClose').addEventListener('click', () => {
      document.getElementById('resultOverlay').hidden = true;
    });
  }

  togglePanel(key) {
    if (key === 'close') { this.closePanels(); return; }
    // 슈팅 모드에서는 실험용 패널을 열 수 없다 (단축키로도)
    if (this.game.mode === 'battle' && ['note', 'answer', 'quiz'].includes(key)) return;
    // ★ 대기 공간에서는 자격시험을 열 수 없다 (미리 응시 금지)
    if (key === 'quiz' && this.phase !== 'playing') {
      this.toast('🎓 자격시험은 게임이 시작된 뒤에 볼 수 있습니다', 'bad');
      return;
    }
    const id = this.panelMap[key];
    const wasOpen = !document.getElementById(id).hidden;
    this.closePanels();
    if (!wasOpen) {
      document.getElementById(id).hidden = false;
      document.exitPointerLock?.();
      if (key === 'note') this.renderNote();
      if (key === 'answer') this.renderAnswer();
      if (key === 'rank') this.renderRank();
      if (key === 'gear') this.game.battle?.renderGear();
      if (key === 'quiz') {
        document.getElementById('btnQuiz').classList.remove('alert');
        if (this.quizPassed) this.onQuizState({ passed: true });
        else this.game.net.send({ t: 'quizStart' });
      }
      if (key === 'chat') document.getElementById('btnChat').classList.remove('alert');
    }
  }
  closePanels() {
    document.querySelectorAll('.panel').forEach(p => { p.hidden = true; });
  }
  anyPanelOpen() { return !!document.querySelector('.panel:not([hidden])'); }

  // ---------------- 탄약 바 ----------------
  buildAmmoBar(onSelect) {
    const bar = this.el.ammoBar;
    bar.innerHTML = '';
    this.ammoEls = [];
    const slots = [
      { id: 'tranq', name: '마취탄', color: '#7fd4ff' },
      ...REAGENT_LIST.map(r => ({ id: r, name: REAGENTS[r].shortName, color: REAGENTS[r].color })),
    ];
    this.ammoSlots = slots;
    slots.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'ammo';
      d.innerHTML = `<span class="key">${i + 1}</span>
        <div class="nm">${s.name}</div><div class="ct">0</div>
        <div class="swatch" style="background:${s.color}"></div>`;
      d.addEventListener('pointerdown', (e) => { e.preventDefault(); onSelect(i); }, { passive: false });
      bar.appendChild(d);
      this.ammoEls.push(d);
    });
  }

  updateAmmo(reagents, tranq, selIdx, collected) {
    if (!this.ammoEls) return;
    this.ammoSlots.forEach((s, i) => {
      const el = this.ammoEls[i];
      const nm = el.querySelector('.nm');
      const ct = el.querySelector('.ct');

      if (s.id === 'tranq') {
        if (this.quizPassed === false) {
          nm.textContent = '🔒 잠김';
          ct.textContent = '시험';
          el.classList.add('empty', 'locked');
          el.classList.toggle('sel', i === selIdx);
          return;
        }
        el.classList.remove('locked');
        nm.textContent = s.name;
        ct.textContent = this.tranqCap ? `${tranq}/${this.tranqCap}` : tranq;
        el.classList.toggle('sel', i === selIdx);
        el.classList.toggle('empty', tranq <= 0);
        return;
      }

      const n = reagents[s.id] | 0;
      ct.textContent = n;
      el.classList.toggle('sel', i === selIdx);
      el.classList.toggle('empty', n <= 0);
      nm.textContent = collected?.[s.id] ? s.name : '???';
    });
  }

  // ---------------- 마취총 자격시험 ----------------
  showQuiz(questions) {
    this.quizQ = questions;
    this.quizPick = new Array(questions.length).fill(null);
    document.getElementById('quizBody').innerHTML =
      questions.map((q, i) => `
        <div class="quiz-q" data-i="${i}">
          <h3>${i + 1}. ${q.q}</h3>
          <div class="quiz-choices">
            ${q.choices.map(c => `<button class="quiz-c" data-i="${i}" data-v="${c}">${c}</button>`).join('')}
          </div>
        </div>`).join('') +
      `<button id="quizSubmit" class="ans-submit" disabled>4문제를 모두 고르세요</button>`;

    const body = document.getElementById('quizBody');
    body.querySelectorAll('.quiz-c').forEach(b => {
      b.onclick = () => {
        const i = +b.dataset.i;
        this.quizPick[i] = b.dataset.v;
        body.querySelectorAll(`.quiz-c[data-i="${i}"]`)
          .forEach(x => x.classList.toggle('sel', x === b));
        const done = this.quizPick.every(v => v !== null);
        const sub = document.getElementById('quizSubmit');
        sub.disabled = !done;
        sub.textContent = done ? '제출하기' : `${this.quizPick.filter(v => v).length}/4 선택함`;
      };
    });
    document.getElementById('quizSubmit').onclick = () => {
      this.game.net.send({ t: 'quizSubmit', answers: this.quizPick });
      document.getElementById('quizSubmit').disabled = true;
      document.getElementById('quizSubmit').textContent = '채점 중…';
    };
  }

  onQuizState(m) {
    const body = document.getElementById('quizBody');
    const btn = document.getElementById('btnQuiz');
    if (m.passed) {
      btn.classList.add('passed');
      btn.querySelector('span').textContent = '합격';
      body.innerHTML = `<div class="quiz-pass">
        <div class="big">🎉</div>
        <h3>합격! 마취총이 해금되었습니다</h3>
        <p>이제 마취탄을 쓸 수 있습니다. 다만 탄약은 <b>비커를 검사할 때만</b> 채워지고,
           보유 상한은 <b>우리 모둠이 맞힌 비커 수</b>에 따라 올라갑니다.</p>
      </div>`;
      if (m.justPassed) {
        this.toast('🎓 자격시험 합격! 마취총이 해금되었습니다 (+15점)', 'good');
        setTimeout(() => this.closePanels(), 2200);
      }
      if (m.byTeacher) this.toast('🎓 선생님이 자격시험을 면제해 주셨습니다', 'good');
      return;
    }

    // ★ 대기 공간에서는 미리 볼 수 없다
    if (m.notYet) {
      body.innerHTML = `<div class="quiz-fail">
        <div class="big">⏳</div>
        <h3>아직 응시할 수 없습니다</h3>
        <p>자격시험은 <b>게임이 시작된 뒤</b>에 볼 수 있습니다.<br>
           지금은 <b>학습지 (2)번 표</b>를 채우면서 조작을 연습하세요.</p>
      </div>`;
      return;
    }

    if (m.waitSec) {
      let left = m.waitSec;
      body.innerHTML = `<div class="quiz-fail">
        <div class="big">❌</div>
        <h3>${m.wrong ? `${m.wrong}문제가 틀렸습니다` : '아직 재응시할 수 없습니다'}</h3>
        <p>어느 문제가 틀렸는지는 알려주지 않습니다.<br>
           <b>학습지 (2)번 표</b>를 다시 보고 도전하세요.</p>
        <div class="quiz-timer"><span id="quizSec">${left}</span>초 후 재응시</div>
      </div>`;
      clearInterval(this._quizTimer);
      this._quizTimer = setInterval(() => {
        left--;
        const el = document.getElementById('quizSec');
        if (!el) { clearInterval(this._quizTimer); return; }
        el.textContent = Math.max(0, left);
        if (left <= 0) {
          clearInterval(this._quizTimer);
          if (!document.getElementById('panelQuiz').hidden) this.game.net.send({ t: 'quizStart' });
        }
      }, 1000);
    }
  }

  // ---------------- A·B·C 채점 현황 ----------------
  renderBeakerStatus() {
    const el = document.getElementById('beakerStatus');
    if (!el) return;
    el.innerHTML = [0, 1, 2].map(bi => {
      const st = this.solved[bi] ? 'ok' : (this.wrongMark?.[bi] ? 'no' : 'todo');
      const mark = st === 'ok' ? '✅' : st === 'no' ? '❌' : '⬜';
      const name = st === 'ok' && this.solvedName?.[bi] ? this.solvedName[bi] : '';
      return `<div class="bs ${st}"><b>${'ABC'[bi]}</b><span>${mark}</span>${name ? `<em>${name}</em>` : ''}</div>`;
    }).join('');
  }

  // ---------------- 정답 채점 결과 ----------------
  showAnswerResult(m) {
    this.wrongMark = this.wrongMark || {};
    this.solvedName = this.solvedName || {};
    for (const r of m.results) {
      if (r.correct) { this.solved[r.bi] = true; this.wrongMark[r.bi] = false; if (r.answerName) this.solvedName[r.bi] = r.answerName; }
      else this.wrongMark[r.bi] = true;
    }
    if (m.solved) for (const k in m.solved) this.solved[k] = true;

    const nOk = m.results.filter(r => r.correct && !r.skipped).length;
    const nNo = m.results.filter(r => !r.correct).length;

    document.getElementById('resultTitle').textContent =
      nNo === 0 ? `🎉 ${nOk}개 전부 정답!` : `채점 결과 — 정답 ${nOk} · 오답 ${nNo}`;
    document.getElementById('resultRows').innerHTML = m.results.map(r => `
      <div class="rrow ${r.correct ? 'ok' : 'no'}">
        <div class="lb">${'ABC'[r.bi]}</div>
        <div class="rr">
          <div class="mk">${r.skipped ? '✅ 이미 맞힘' : r.correct ? '✅ 정답' : '❌ 오답'}</div>
          <div class="sub">${r.correct && r.answerName ? `${r.answerName}` :
            r.skipped ? '' : `제출: ${r.guessName || '-'} — 다시 추리해 보세요`}</div>
        </div>
      </div>`).join('');
    this.cooldownUntil = m.cooldownUntil || 0;
    document.getElementById('resultNote').textContent = m.cooldown
      ? `틀린 것이 있어 ${m.cooldown}초 뒤에 다시 제출할 수 있습니다. (계속 찍으면 대기가 길어져요)`
      : (nNo === 0 ? '실험노트에 결과가 남아 있습니다. 학습지에도 옮겨 적으세요.' : '');

    this.closePanels();                       // 제출 후 제출지를 닫는다
    document.getElementById('resultOverlay').hidden = false;
    this.renderBeakerStatus();
    this.renderAnswer();
    this.renderNote();
  }

  // ---------------- 실험 노트 ----------------
  setResult(bi, reagent, positive) {
    this.notes[bi][reagent] = positive;
    if (!document.getElementById('panelNote').hidden) this.renderNote();
    document.getElementById('btnNote').classList.add('alert');
  }

  renderNote() {
    const head = REAGENT_LIST.map(r => {
      const g = REAGENTS[r];
      return `<th>${g.shortName}${g.needsHeat ? ' 🔥' : ''}` +
        `<small>${NUTRIENTS[g.reactTo].name} 검출<br>양성 → ${g.posText}` +
        `${g.needsHeat ? '<br><b style="color:#ff9a3c">가열 필요</b>' : ''}</small></th>`;
    }).join('');

    const rows = [0, 1, 2].map(bi => {
      const cells = REAGENT_LIST.map(r => {
        const v = this.notes[bi][r];
        if (v === undefined) return `<td><span class="res unk">? 미검사</span></td>`;
        return v
          ? `<td><span class="res pos">＋ ${REAGENTS[r].posText}</span></td>`
          : `<td><span class="res neg">－ 변화없음</span></td>`;
      }).join('');
      const done = this.solved[bi] ? ' ✅' : '';
      return `<tr><td class="bk">${'ABC'[bi]}${done}</td>${cells}</tr>`;
    }).join('');

    this.el.note.innerHTML =
      `<table class="note"><thead><tr><th>비커</th>${head}</tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="hint" style="margin-top:10px">비커는 섬에 <b>두 세트(제1·제2 실험장)</b>가 있습니다.
       <b>같은 글자면 안에 든 음료도 똑같으니</b>, 사람이 몰리면 반대편 실험장으로 가세요.<br>
       색 반응은 <b>우리 모둠에게만</b> 보입니다 — 다른 모둠이 쏜 것 때문에 헷갈릴 일은 없습니다.</p>
       <p class="hint" style="margin-top:8px;border-left:3px solid #ff8a3c;padding-left:9px">
       🔥 <b>베네딕트는 가열해야 반응합니다.</b> 필드의 <b>가열대(불꽃)</b>에 다가가 몸을 데운 뒤
       ${RULES.HEAT_SECONDS}초 안에 쏘세요. 식은 채로 쏘면 <b>아무 일도 일어나지 않습니다</b>
       (음성으로 기록되지도 않습니다). 불꽃 위치는 미니맵에 주황 삼각형으로 표시됩니다.</p>`;

    // 음료 후보 8종 — 무엇 중에서 고르는지 알아야 추리를 시작할 수 있다
    this.el.deduce.innerHTML =
      `<div class="cand-box">
         <h3>이번 판 후보 (이 ${this.candidates().length}개 중 3개입니다)</h3>
         <div class="cand-list">${this.candidates().map(d => `<span class="cand">${d.name}</span>`).join('')}</div>
         <p class="hint" style="margin:8px 0 0">
           네 시약의 ＋/－ 조합이 후보마다 <b>모두 다릅니다</b> — 표를 채우면 반드시 하나로 좁혀집니다.<br>
           <b>4가지 모두 －</b> 인 음료도 있습니다. 반응이 없는 것도 답을 좁히는 정보입니다.<br>
           <b style="color:var(--acc)">후보는 라운드마다 새로 뽑힙니다.</b> 지난 판 답을 외워도 소용없어요.
         </p>
       </div>`;
  }

  // ---------------- 정답 제출 ----------------
  // A·B·C 를 한 화면에서 고르고 '한 번에' 제출한다
  // 이번 라운드 후보 (없으면 전체 목록으로 대체)
  candidates() {
    return (this.roundCandidates && this.roundCandidates.length)
      ? this.roundCandidates : DRINKS.map(d => ({ id: d.id, name: d.name }));
  }

  renderAnswer() {
    const rows = [0, 1, 2].map(bi => {
      if (this.solved[bi]) {
        const nm = this.solvedName?.[bi] || '';
        return `<div class="ans-row done"><h3>비커 ${'ABC'[bi]}</h3>
          <div class="solved-badge">✅ 정답${nm ? ` — ${nm}` : ''}</div></div>`;
      }
      const known = REAGENT_LIST.filter(r => this.notes[bi][r] !== undefined);
      const sum = known.length === 0
        ? '<b style="color:var(--bad)">아직 검사 안 함 — 비커에 시약을 쏘고 오세요</b>'
        : known.map(r => `${REAGENTS[r].shortName} ${this.notes[bi][r] ? '＋' : '－'}`).join(' · ');
      const wrong = this.wrongMark?.[bi] ? ' wrong' : '';
      return `<div class="ans-row${wrong}" data-bi="${bi}">
        <h3>비커 ${'ABC'[bi]} ${this.wrongMark?.[bi] ? '<span class="xmark">❌ 이전 제출 오답</span>' : ''}</h3>
        <div class="sub">우리 모둠 실험 결과: ${sum}</div>
        <div class="drinks">${this.candidates().map(d =>
          `<button class="drink" data-bi="${bi}" data-id="${d.id}">${d.name}</button>`).join('')}</div>
      </div>`;
    }).join('');

    const remaining = [0, 1, 2].filter(bi => !this.solved[bi]);
    const inSafe = !!this.safeZone;
    const waitMs = (this.cooldownUntil || 0) - Date.now();
    const notice = inSafe
      ? `<div class="safe-ok">🛡 ${this.safeZone.name} 안전구역 — 지금 제출할 수 있습니다</div>`
      : `<div class="safe-no">🛡 안전구역 밖입니다 — <b>가장 가까운 창고 안으로 들어가야</b> 제출할 수 있어요<br>
         <small>내 모둠 창고든 다른 모둠 창고든 상관없습니다. 미니맵의 동그란 구역을 찾으세요.</small></div>`;
    this.el.answer.innerHTML = notice + rows +
      `<button id="ansSubmitAll" class="ans-submit" ${remaining.length && inSafe && waitMs <= 0 ? '' : 'disabled'}>
        ${!remaining.length ? '세 개 모두 맞혔습니다 🎉'
          : waitMs > 0 ? `⏳ ${Math.ceil(waitMs / 1000)}초 후 다시 제출`
          : inSafe ? '선택한 비커 제출하기' : '안전구역에서만 제출 가능'}
       </button>`;

    // 이전에 고른 값 복원
    for (const bi of remaining) {
      if (!this.selected[bi]) continue;
      const b = this.el.answer.querySelector(`.drink[data-bi="${bi}"][data-id="${this.selected[bi]}"]`);
      if (b) b.classList.add('sel');
    }

    const refresh = () => {
      const picked = remaining.filter(bi => this.selected[bi]);
      const sub = document.getElementById('ansSubmitAll');
      if (!sub) return;
      const left = (this.cooldownUntil || 0) - Date.now();
      if (left > 0) {
        sub.disabled = true;
        sub.textContent = `⏳ ${Math.ceil(left / 1000)}초 후 다시 제출`;
        return;
      }
      if (!inSafe) { sub.disabled = true; sub.textContent = '안전구역에서만 제출 가능'; return; }
      sub.disabled = picked.length === 0;
      sub.textContent = picked.length === 0
        ? '음료를 고르세요'
        : `${picked.map(bi => 'ABC'[bi]).join(' · ')} ${picked.length}개 한 번에 제출`;
    };

    // 오답 대기 중이면 버튼의 남은 초를 1초마다 갱신한다 (멈춘 것처럼 보이지 않게)
    clearInterval(this._cdTimer);
    if (waitMs > 0) {
      this._cdTimer = setInterval(() => {
        if (document.getElementById('panelAnswer').hidden) { clearInterval(this._cdTimer); return; }
        if ((this.cooldownUntil || 0) - Date.now() <= 0) { clearInterval(this._cdTimer); this.renderAnswer(); return; }
        refresh();
      }, 500);
    }

    this.el.answer.querySelectorAll('.drink').forEach(b => {
      b.onclick = () => {
        const bi = +b.dataset.bi;
        const same = this.selected[bi] === b.dataset.id;
        this.selected[bi] = same ? null : b.dataset.id;    // 다시 누르면 해제
        this.el.answer.querySelectorAll(`.drink[data-bi="${bi}"]`)
          .forEach(x => x.classList.toggle('sel', !same && x === b));
        refresh();
      };
    });

    const sub = document.getElementById('ansSubmitAll');
    if (sub) {
      sub.onclick = () => {
        const picks = {};
        for (const bi of remaining) if (this.selected[bi]) picks[bi] = this.selected[bi];
        if (!Object.keys(picks).length) return;
        this.game.net.send({ t: 'answer', picks });
        sub.disabled = true;
        sub.textContent = '채점 중…';
      };
    }
    refresh();
  }

  // ---------------- 순위 ----------------
  setRoster(msg) {
    this.roster = msg;
    document.getElementById('aliveVal').textContent = msg.players.length;
    if (!document.getElementById('panelRank').hidden) this.renderRank();
  }

  // ★ 순위 = '음료 3개를 먼저 다 맞힌 순서'. 아직 못 끝낸 모둠은 그 뒤로 진행률 순.
  //   (슈팅 모드에서는 분대 킬 순위를 보여준다)
  renderRank() {
    if (this.game.mode === 'battle') { this.renderBattleRank(); return; }
    const r = this.roster;
    if (!r) { this.el.rank.innerHTML = '<p class="hint">불러오는 중…</p>'; return; }
    const teams = r.teams.filter(t => t.members.length).sort((a, b) => {
      const fa = a.finishOrder || 99, fb = b.finishOrder || 99;
      if (fa !== fb) return fa - fb;
      const sa = Object.keys(a.solved || {}).length, sb = Object.keys(b.solved || {}).length;
      if (sa !== sb) return sb - sa;
      return b.score - a.score;
    });
    const myTeam = this.game.myTeam;
    const medalOf = (t) => ['🥇', '🥈', '🥉'][(t.finishOrder || 0) - 1] || '';
    const mmss = (s) => s == null ? '' :
      `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
    this.el.rank.innerHTML =
      `<p class="hint" style="margin:0 0 8px">순위는 점수가 아니라
       <b>음료 3개를 먼저 다 맞힌 순서</b>입니다. <b>3등</b>이 나오면 라운드가 끝납니다.</p>` +
      `<table class="rank">
      <thead><tr><th>순위</th><th>모둠</th><th>맞힌 비커</th><th style="text-align:right">점수</th></tr></thead>
      <tbody>${teams.map((t, i) => `
        <tr class="${t.index === myTeam ? 'mine' : ''}${t.finishOrder ? ' done' : ''}">
          <td>${medalOf(t) || (i + 1)}</td>
          <td><span class="tdot" style="background:${t.color}"></span><b>${t.name}</b>
              <span class="hatname">${t.colorName || ''} 모자</span>
              <div class="mini-mem">${t.members.join(' · ')}${
                t.finishOrder ? ` · <b style="color:var(--acc)">완주 ${mmss(t.finishSeconds)}</b>` : ''}</div></td>
          <td>${['A', 'B', 'C'].map(l => t.solved[{ A: 0, B: 1, C: 2 }[l]] ? `✅${l}` : `⬜${l}`).join(' ')}</td>
          <td class="sc">${t.score}</td>
        </tr>`).join('')}</tbody></table>`;
  }

  // ★ 슈팅 모드 순위 — 분대 킬 수
  renderBattleRank() {
    const B = this.game.battle;
    const list = (B?.squads || []).filter(s => s.members.length)
      .sort((a, b) => (b.kills - a.kills) ||
        (a.members.reduce((x, m) => x + m.deaths, 0) - b.members.reduce((x, m) => x + m.deaths, 0)));
    this.el.rank.innerHTML =
      `<p class="hint" style="margin:0 0 8px">순위는 <b>분대 전체 킬 수</b>입니다.
        같은 킬이면 덜 쓰러진 분대가 위입니다.</p>` +
      `<table class="rank">
       <thead><tr><th>순위</th><th>분대</th><th style="text-align:right">킬</th></tr></thead>
       <tbody>${list.map((s, i) => `
        <tr class="${s.index === B.mySquad ? 'mine' : ''}">
          <td>${['🥇', '🥈', '🥉'][i] || (i + 1)}</td>
          <td><span class="tdot" style="background:${s.color}"></span><b>${esc(s.colorName)} 분대</b>
            <div class="mini-mem">${s.members.map(m =>
              `${esc(m.nick)} <span style="color:var(--dim)">${m.kills}/${m.deaths}</span>`).join(' · ')}</div></td>
          <td class="sc">${s.kills}</td>
        </tr>`).join('')}</tbody></table>`;
  }

  // ---------------- 모둠 대화 ----------------
  _quick(battle) {
    const presets = battle
      ? ['여기 총 있어!', '탄약 좀!', '구급품 있어?', '같이 가자',
         '도와줘!', '적 발견!', '나 쓰러졌어', '자기장 안으로!']
      : ['여기 시약 있어!', '비커 A 간다', '비커 B 간다', '비커 C 간다',
         '도와줘!', '적 발견!', '나 마취됐어', '정답 알 것 같아'];
    this.el.quick.innerHTML = presets
      .map((p, i) => `<button data-i="${i}">${p}</button>`).join('');
    this.el.quick.querySelectorAll('button').forEach(b => {
      b.onclick = () => this.game.net.send({ t: 'quick', i: +b.dataset.i });
    });
  }

  addChat(nick, msg) {
    this.chat.push(`<b>${esc(nick)}</b> : ${esc(msg)}`);
    if (this.chat.length > 40) this.chat.shift();
    this.el.chatLog.innerHTML = this.chat.join('<br>');
    this.el.chatLog.scrollTop = 1e6;
    if (document.getElementById('panelChat').hidden) {
      document.getElementById('btnChat').classList.add('alert');
      this.toast(`💬 ${nick} : ${msg}`);
    }
  }

  // ---------------- 토스트 / 피드 ----------------
  toast(msg, kind, ms = 3200) {
    const d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.innerHTML = esc(msg);
    this.el.toasts.appendChild(d);
    setTimeout(() => { d.style.transition = 'opacity .4s'; d.style.opacity = '0'; }, ms);
    setTimeout(() => d.remove(), ms + 500);
  }

  // ---------------- ★ 선두 모둠 공개 ----------------
  //  "몇 모둠"은 서로 몰라도 모자 색은 눈에 보인다 → 색으로 부른다.
  setLeader(L, myTeam) {
    this.leader = L;
    const chip = document.getElementById('leaderChip');
    const ban = document.getElementById('leaderBanner');
    if (!chip || !ban) return;

    if (!L) { chip.hidden = true; ban.hidden = true; return; }

    const mine = L.team === myTeam;
    // 항상 떠 있는 작은 표시 (지금 1위가 누구인지 언제든 확인)
    chip.hidden = false;
    chip.className = mine ? 'mine' : '';
    chip.innerHTML =
      `<i style="background:${esc(L.color)}"></i>` +
      `<span>👑 1위 <b>${esc(L.colorName)} 모자</b> · 비커 ${L.solved}/3</span>`;

    // 발표 배너 (잠깐 크게)
    ban.hidden = false;
    ban.className = mine ? 'mine' : '';
    ban.innerHTML = mine
      ? `<div class="lb-head"><i style="background:${esc(L.color)}"></i>
           👑 우리 모둠이 1위입니다 — <b>${esc(L.colorName)} 모자</b></div>
         <div class="lb-sub">다른 모둠이 우리를 노립니다. 안전구역(창고)을 잘 쓰세요!</div>`
      : `<div class="lb-head"><i style="background:${esc(L.color)}"></i>
           👑 1위는 <b>${esc(L.colorName)} 모자</b> — ${esc(L.name)}</div>
         <div class="lb-sub">${esc(L.nicks.join(' · '))}
           &nbsp;·&nbsp; 비커 <b>${L.solved}/3</b> · 검사 <b>${L.tested}/12</b>
           &nbsp;·&nbsp; 마취시키면 <b>+${L.bounty}점</b></div>`;
    clearTimeout(this._leaderT);
    this._leaderT = setTimeout(() => { ban.hidden = true; }, 6500);
  }

  feed(html) {
    const d = document.createElement('div');
    d.className = 'feed-it';
    d.innerHTML = html;
    this.el.feed.appendChild(d);
    while (this.el.feed.children.length > 6) this.el.feed.firstChild.remove();
    setTimeout(() => d.remove(), 7000);
  }

  hurtFlash() {
    this.el.hurt.classList.add('on');
    setTimeout(() => this.el.hurt.classList.remove('on'), 90);
  }

  hitmark() {
    this.el.crosshair.classList.add('hitmark');
    setTimeout(() => this.el.crosshair.classList.remove('hitmark'), 150);
  }

  showPrompt(text) {
    this.el.prompt.hidden = !text;
    if (text) this.el.prompt.textContent = text;
  }

  // ---------------- 이름표 ----------------
  updateTags(items) {
    const pool = this.tagPool;
    while (pool.length < items.length) {
      const d = document.createElement('div');
      d.className = 'tag';
      d.innerHTML = `<span class="nm"></span><div class="bar"><i></i></div>`;
      this.el.tags.appendChild(d);
      pool.push(d);
    }
    pool.forEach((d, i) => {
      const it = items[i];
      if (!it) { d.style.display = 'none'; return; }
      d.style.display = '';
      d.style.left = it.x + 'px';
      d.style.top = it.y + 'px';
      d.className = 'tag ' + (it.mate ? 'mate' : 'foe') + (it.down ? ' downed' : '') +
        (it.medal ? ' done' : it.leader ? ' leader' : '');
      d.style.opacity = it.opacity;
      const nm = d.firstChild;
      // ★ 등수를 확정한 모둠은 메달, 아직 경쟁 중인 1위는 왕관 — 둘 다 표적이다
      const mark = it.medal ? `${it.medal} ` : it.leader ? '👑 ' : '';
      const label = it.down ? `💤 ${mark}${it.nick}` : `${mark}${it.nick}`;
      if (nm.textContent !== label) nm.textContent = label;
      nm.style.color = it.mate ? '' : '';
      const bar = d.lastChild;
      bar.style.display = it.hits > 0 ? '' : 'none';
      bar.firstChild.style.width = Math.min(100, (it.hits / RULES.TRANQ_HITS_TO_DOWN) * 100) + '%';
    });
  }

  // ---------------- 게임 단계 / 안전구역 ----------------
  setPhase(phase, startAt) {
    this.phase = phase;
    document.getElementById('waitBanner').hidden = (phase === 'playing');
    if (phase !== 'playing') {
      document.getElementById('safeBadge').hidden = true;
      this.safeZone = null;
    }
    // 대기 중에는 실험/정답/자격시험 버튼을 잠근다
    // (★ 자격시험은 게임이 시작된 뒤에만 — 대기 공간에서 미리 못 본다)
    for (const id of ['btnNote', 'btnAnswer', 'btnRank', 'btnQuiz']) {
      document.getElementById(id).classList.toggle('dimmed', phase !== 'playing');
    }
    if (phase !== 'playing') {
      document.getElementById('btnQuiz').classList.remove('alert');
      if (!document.getElementById('panelQuiz').hidden) this.closePanels();
    }
  }

  // ---------------- ★ 가열 상태 ----------------
  //  베네딕트는 이 배지가 켜져 있는 동안에만 반응한다.
  setHeat(until) {
    this.heatUntil = until || 0;
    this._paintHeat();
  }

  // 남은 초는 굳이 띄우지 않는다 — '불이 붙어 있나 아닌가'만 보이면 충분하고,
  // 숫자를 띄우면 시약 반응 결과 알림을 가린다는 수업 피드백이 있었다.
  // (꺼지기 직전에만 살짝 깜빡여서 알려 준다)
  _paintHeat() {
    const el = document.getElementById('heatBadge');
    if (!el) return;
    if (Date.now() < (this._heatMsgUntil || 0)) return;   // 경고 문구를 띄워 둔 동안은 건드리지 않는다
    const left = ((this.heatUntil || 0) - Date.now()) / 1000;
    if (left <= 0) { el.hidden = true; el.classList.remove('low'); return; }
    el.hidden = false;
    el.innerHTML = '🔥 몸에 불이 붙었습니다 — 베네딕트 발사 가능';
    el.classList.toggle('low', left <= (RULES.HEAT_WARN_SECONDS || 5));
  }

  // 가열 없이 베네딕트를 쐈을 때 — 가장 가까운 불이 어디인지 알려 준다
  showHeatNeeded(fire) {
    const el = document.getElementById('heatBadge');
    if (!el) return;
    el.hidden = false;
    el.classList.add('low');
    el.innerHTML = fire
      ? `🔥 가열 필요 — 가장 가까운 불꽃까지 <b>${fire.dist}</b>m`
      : '🔥 가열이 필요합니다 — 불꽃에 다가가세요';
    this._heatMsgUntil = Date.now() + 3000;
  }

  // ---------------- ★ 등수 확정 발표 ----------------
  showFinish(m, mine) {
    const ban = document.getElementById('finishBanner');
    if (!ban) return;
    const mm = `${Math.floor(m.seconds / 60)}분 ${String(m.seconds % 60).padStart(2, '0')}초`;
    ban.hidden = false;
    ban.className = mine ? 'mine' : '';
    ban.innerHTML =
      `<div class="fb-head"><span class="fb-medal">${m.medal}</span>
         <i style="background:${esc(m.color)}"></i>
         ${mine ? '우리 모둠' : `${esc(m.colorName)} 모자`} <b>${m.order}등 확정!</b></div>
       <div class="fb-sub">${esc(m.name)} · ${esc(m.nicks.join(' · '))} · ${mm} · 보너스 +${m.bonus}점<br>
         ${m.remaining > 0
           ? `<b>${m.remaining}팀</b>만 더 완주하면 라운드가 끝납니다 — 확정된 모둠도 계속 뛸 수 있고, 마취탄에 맞습니다`
           : '라운드 종료!'}</div>`;
    clearTimeout(this._finishT);
    this._finishT = setTimeout(() => { ban.hidden = true; }, 7000);
  }

  clearFinish() {
    const ban = document.getElementById('finishBanner');
    if (ban) ban.hidden = true;
  }

  setSafeZone(zone) {
    this.safeZone = zone;
    const el = document.getElementById('safeBadge');
    el.hidden = !zone;
    if (zone) el.querySelector('b').textContent = zone.name;
    if (!document.getElementById('panelAnswer').hidden) this.renderAnswer();
  }

  showCountdown(sec) {
    const el = document.getElementById('countdown');
    if (sec <= 0) { el.hidden = true; return; }
    el.hidden = false;
    const n = el.querySelector('.cd-num');
    if (n.textContent !== String(sec)) {
      n.textContent = sec;
      n.style.animation = 'none';
      void n.offsetWidth;
      n.style.animation = '';
    }
  }

  // ---------------- 나침반 ----------------
  // 배그처럼 위쪽에 방위와 비커 방향을 띄운다. 32명이 넓은 섬에서 길을 잃지 않게.
  drawCompass(me) {
    const ctx = this.cctx;
    const W = this.el.compass.width, H = this.el.compass.height;
    ctx.clearRect(0, 0, W, H);

    // 배경
    ctx.fillStyle = 'rgba(8,12,17,.55)';
    roundRect(ctx, 0, 6, W, H - 14, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 2; ctx.stroke();

    // 북쪽 = -Z 기준 방위각
    const fx = Math.sin(me.yaw), fz = Math.cos(me.yaw);
    const bearing = (Math.atan2(fx, -fz) * 180 / Math.PI + 360) % 360;
    const PPD = W / 150;                 // 화면에 보이는 각도 범위 150°
    const at = (deg) => W / 2 + (((deg - bearing + 540) % 360) - 180) * PPD;

    const LBL = { 0: '북', 45: '북동', 90: '동', 135: '남동', 180: '남', 225: '남서', 270: '서', 315: '북서' };
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 5) {
      const x = at(d);
      if (x < -30 || x > W + 30) continue;
      const major = d % 45 === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.32)';
      ctx.lineWidth = major ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, major ? 12 : 18); ctx.lineTo(x, 26); ctx.stroke();
      if (major) {
        ctx.fillStyle = (d === 0) ? '#ffcc4d' : 'rgba(255,255,255,.9)';
        ctx.font = 'bold 17px sans-serif';
        ctx.fillText(LBL[d], x, 40);
      }
    }

    // 비커 방향 표시 — 섬에 6개(두 세트)라 가까운 것부터 3개만 보여준다
    // (슈팅 모드에는 비커가 없으므로 방위만 그린다)
    const near = this.game.mode === 'battle' ? [] : [...LAYOUT.beakers]
      .map(b => ({ b, d: Math.hypot(b.x - me.x, b.z - me.z) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, 3);
    for (const { b, d: dist } of near) {
      const dx = b.x - me.x, dz = b.z - me.z;
      const bd = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
      const x = at(bd);
      if (x < 10 || x > W - 10) continue;
      const solved = !!this.solved[b.drink];
      ctx.fillStyle = solved ? '#3fd07a' : '#ffcc4d';
      ctx.beginPath();
      ctx.moveTo(x, 2); ctx.lineTo(x + 9, 12); ctx.lineTo(x - 9, 12);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#0b0f14';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(b.label, x, 9);
      ctx.fillStyle = solved ? '#9df0bd' : '#ffe6a8';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(`${Math.round(dist)}m`, x, 53);
    }

    // 중앙 표식
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(W / 2, 28); ctx.lineTo(W / 2 + 6, 20); ctx.lineTo(W / 2 - 6, 20);
    ctx.closePath(); ctx.fill();
  }

  // ---------------- 미니맵 ----------------
  addGunshot(x, z) {
    this.gunshots.push({ x, z, t: performance.now() });
    if (this.gunshots.length > 40) this.gunshots.shift();
  }

  drawMinimap(me, others, pickups, teamIdx, phase, battle) {
    const ctx = this.mctx;
    const S = this.el.minimap.width;

    // 대기 공간에서는 훈련장만 그린다
    if (phase && phase !== 'playing') {
      ctx.clearRect(0, 0, S, S);
      const H = TRAIN.half + 6;
      const tp = (x, z) => [S / 2 + ((x - TRAIN.cx) / H) * (S / 2 - 10), S / 2 + ((z - TRAIN.cz) / H) * (S / 2 - 10)];
      const [ax, ay] = tp(TRAIN.cx - TRAIN.half, TRAIN.cz - TRAIN.half);
      const [bx2, by2] = tp(TRAIN.cx + TRAIN.half, TRAIN.cz + TRAIN.half);
      ctx.fillStyle = 'rgba(90,110,130,.55)';
      ctx.fillRect(ax, ay, bx2 - ax, by2 - ay);
      ctx.strokeStyle = 'rgba(255,204,77,.6)'; ctx.lineWidth = 2;
      ctx.strokeRect(ax, ay, bx2 - ax, by2 - ay);
      for (const o of others) {
        const [px, py] = tp(o.x, o.z);
        ctx.fillStyle = o.team === teamIdx ? '#5de08f' : 'rgba(255,255,255,.55)';
        ctx.beginPath(); ctx.arc(px, py, 4, 0, 7); ctx.fill();
      }
      const [mx0, my0] = tp(me.x, me.z);
      ctx.save(); ctx.translate(mx0, my0); ctx.rotate(Math.PI - me.yaw);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7);
      ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.fillStyle = '#ffcc4d'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('대기 공간', S / 2, 20);
      return;
    }

    const R = MAP.PLAY_R;
    const toPx = (x, z) => [S / 2 + (x / R) * (S / 2 - 8), S / 2 + (z / R) * (S / 2 - 8)];

    ctx.clearRect(0, 0, S, S);
    // 섬
    ctx.fillStyle = 'rgba(90,120,70,.55)';
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 8, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 2; ctx.stroke();

    // 컨테이너 야드 사각형
    const [ax, ay] = toPx(-MAP.YARD, -MAP.YARD), [bx, by] = toPx(MAP.YARD, MAP.YARD);
    ctx.fillStyle = 'rgba(120,110,90,.5)';
    ctx.fillRect(ax, ay, bx - ax, by - ay);

    // 시약 (가까운 것만)
    ctx.globalAlpha = 0.95;
    for (const p of pickups) {
      if (!p.visible) continue;
      const d = Math.hypot(p.data.x - me.x, p.data.z - me.z);
      if (d > 90) continue;
      const [px, py] = toPx(p.data.x, p.data.z);
      ctx.fillStyle = REAGENTS[p.data.reagent].color;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, 7); ctx.fill();
    }

    // ★ 슈팅 모드 — 보급 상자
    if (battle) battle.drawLoot(ctx, toPx, me);

    // 모둠 안전구역 8곳 (슈팅 모드에서는 안전구역이 아니라 그냥 창고다)
    if (!battle) for (const b of LAYOUT.bases) {
      const [px, py] = toPx(b.x, b.z);
      const rr = (b.r / R) * (S / 2 - 8);
      ctx.fillStyle = b.color + '33';
      ctx.beginPath(); ctx.arc(px, py, rr, 0, 7); ctx.fill();
      ctx.strokeStyle = b.color; ctx.lineWidth = b.team === teamIdx ? 3 : 1.6;
      ctx.stroke();
      ctx.fillStyle = b.team === teamIdx ? '#fff' : b.color;
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(b.team + 1), px, py);
    }

    // ★ 가열대(불꽃) — 베네딕트를 쏘려면 여기부터 들러야 한다
    if (!battle) for (const f of (LAYOUT.fires || [])) {
      const [px, py] = toPx(f.x, f.z);
      ctx.fillStyle = 'rgba(255,120,40,.9)';
      ctx.beginPath();
      ctx.moveTo(px, py - 6); ctx.lineTo(px + 5, py + 4); ctx.lineTo(px - 5, py + 4);
      ctx.closePath(); ctx.fill();
    }

    // 비커 6개 (두 세트, 같은 글자면 같은 음료)
    if (!battle) LAYOUT.beakers.forEach((b) => {
      const [px, py] = toPx(b.x, b.z);
      ctx.fillStyle = this.solved[b.drink] ? '#3fd07a' : '#ffd76a';
      ctx.beginPath(); ctx.arc(px, py, 10, 0, 7); ctx.fill();
      ctx.fillStyle = '#1a1204'; ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.label, px, py + 1);
    });

    // 총성
    const now = performance.now();
    for (const g of this.gunshots) {
      const age = (now - g.t) / 2500;
      if (age > 1) continue;
      const [px, py] = toPx(g.x, g.z);
      ctx.strokeStyle = `rgba(255,120,90,${1 - age})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 4 + age * 12, 0, 7); ctx.stroke();
    }

    // 같은 편 (실험 모드 = 모둠원 / 슈팅 모드 = 분대원)
    const g = this.game;
    for (const [id, o] of (battle ? [...g.remote] : others.map(o => [o.id, o]))) {
      const same = battle ? g.sideOf(id, o.team) === g.mySide() : o.team === teamIdx;
      if (!same) continue;
      const [px, py] = toPx(o.x, o.z);
      ctx.fillStyle = o.down ? '#7aa0c0' : '#5de08f';
      ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
    }

    // ★ 자기장 (슈팅 모드) — 마지막에 그려서 위에 얹는다
    if (battle) battle.drawZone(ctx, toPx, S);

    // 나
    const [mx, my] = toPx(me.x, me.z);
    ctx.save();
    // 화살표는 위(-y)를 향해 그리고, 월드 정면 (sin yaw, cos yaw) 로 맞춘다 → θ = π - yaw
    ctx.translate(mx, my); ctx.rotate(Math.PI - me.yaw);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

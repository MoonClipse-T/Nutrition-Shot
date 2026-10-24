// ============================================================
//  controls.js — 태블릿(터치) + PC(키보드·마우스) 조작
// ============================================================
export class Input {
  constructor(root) {
    this.move = { x: 0, y: 0 };     // -1..1  (y: 앞이 +)
    this.lookDX = 0;                // 프레임마다 소비
    this.lookDY = 0;
    this.firing = false;
    this.jumpQueued = false;
    this.running = false;
    this.crouching = false;
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.onAmmo = () => {};
    this.onPanel = () => {};
    this.onZoom = () => {};         // ★ 두 손가락 확대 / 마우스 휠 → 조준경
    this.onTapFire = () => {};      // ★ PC : 짧게 클릭하면 한 발
    this.lookSens = 0.0032;
    this.lookScale = 1;             // 조준경을 당기면 감도를 낮춘다

    this.root = root;
    this._touch(root);
    this._keys();
    if (!this.isTouch) document.body.classList.add('desktop');
  }

  consumeLook() {
    const d = { x: this.lookDX, y: this.lookDY };
    this.lookDX = 0; this.lookDY = 0;
    return d;
  }
  consumeJump() {
    if (this.jumpQueued) { this.jumpQueued = false; return true; }
    return false;
  }

  // ---------------- 터치 ----------------
  _touch(root) {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('stickKnob');
    const R = () => stick.getBoundingClientRect();

    let stickId = null, lookId = null, lastLook = null;
    // ★ 두 손가락 확대(핀치) — 저격경
    const pinch = new Map();          // pointerId -> {x,y}  (조이스틱이 아닌 손가락들)
    let pinchBase = 0;

    const isUI = (el) => !!(el && el.closest &&
      el.closest('#actions,#rightTabs,#ammoBar,#bBar,.panel,#stick,#topLeft,#topRight,' +
                 '#revealOverlay,#downOverlay,#bDeadOverlay,#bLobby,#bOverOverlay,#resultOverlay'));

    root.addEventListener('pointerdown', (e) => {
      if (isUI(e.target) && e.target.closest('#stick') === null) return;

      const r = R();
      const inStick = e.clientX < Math.max(r.right + 40, innerWidth * 0.42) &&
                      e.clientY > innerHeight * 0.35;
      if (stickId === null && inStick) {
        stickId = e.pointerId;
        // 조이스틱을 손가락 위치로 옮겨준다 (배그 모바일과 동일)
        stick.style.left = (e.clientX - r.width / 2) + 'px';
        stick.style.top = (e.clientY - r.height / 2) + 'px';
        stick.style.bottom = 'auto';
        this._stickMove(e, stick, knob);
        root.setPointerCapture?.(e.pointerId);
        return;
      }
      pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.size === 2) {
        pinchBase = this._pinchDist(pinch);
        lookId = null; lastLook = null;       // 확대 중에는 시점을 돌리지 않는다
      }
      if (lookId === null && pinch.size < 2) {
        lookId = e.pointerId;
        lastLook = { x: e.clientX, y: e.clientY };
      }
    }, { passive: true });

    root.addEventListener('pointermove', (e) => {
      if (e.pointerId === stickId) { this._stickMove(e, stick, knob); return; }
      if (pinch.has(e.pointerId)) pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // ★ 두 손가락을 벌리면 확대, 오므리면 축소
      if (pinch.size >= 2) {
        const d = this._pinchDist(pinch);
        if (pinchBase > 0 && d > 0) {
          this.onZoom(d / pinchBase, 'set');
          pinchBase = pinchBase * 0.82 + d * 0.18;   // 조금씩 기준을 따라가 부드럽게
        }
        return;
      }
      if (e.pointerId === lookId && lastLook) {
        this.lookDX += (e.clientX - lastLook.x) * this.lookSens * this.lookScale;
        this.lookDY += (e.clientY - lastLook.y) * this.lookSens * this.lookScale;
        lastLook = { x: e.clientX, y: e.clientY };
      }
    }, { passive: true });

    const up = (e) => {
      if (e.pointerId === stickId) {
        stickId = null; this.move.x = 0; this.move.y = 0;
        knob.style.transform = '';
        stick.style.left = ''; stick.style.top = ''; stick.style.bottom = '';
      }
      pinch.delete(e.pointerId);
      if (pinch.size < 2) pinchBase = 0;
      if (e.pointerId === lookId) { lookId = null; lastLook = null; }
    };
    root.addEventListener('pointerup', up, { passive: true });
    root.addEventListener('pointercancel', up, { passive: true });

    const hold = (el, on, off) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); on(); }, { passive: false });
      el.addEventListener('pointerup', () => off && off());
      el.addEventListener('pointerleave', () => off && off());
      el.addEventListener('pointercancel', () => off && off());
    };
    hold(document.getElementById('btnFire'),
      () => { this.firing = true; }, () => { this.firing = false; });
    hold(document.getElementById('btnJump'),
      () => { this.jumpQueued = true; });
    const cb = document.getElementById('btnCrouch');
    hold(cb, () => {
      this.crouching = !this.crouching;
      cb.style.background = this.crouching ? 'rgba(255,204,77,.3)' : '';
    });
  }

  _pinchDist(map) {
    const [a, b] = [...map.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _stickMove(e, stick, knob) {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const max = r.width / 2 - 8;
    const d = Math.hypot(dx, dy);
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    this.move.x = dx / max;
    this.move.y = -dy / max;
    this.running = d > max * 0.82;
  }

  // ---------------- 키보드 / 마우스 ----------------
  _keys() {
    const k = {};
    this.keys = k;
    const apply = () => {
      this.move.x = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
      this.move.y = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
      this.running = !!(k.ShiftLeft || k.ShiftRight);
    };

    addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (k[e.code]) return;
      k[e.code] = true;
      if (e.code === 'Space') { this.jumpQueued = true; e.preventDefault(); }
      if (e.code === 'KeyC') this.crouching = !this.crouching;
      if (/^Digit[1-5]$/.test(e.code)) this.onAmmo(parseInt(e.code.slice(5), 10) - 1);
      if (e.code === 'KeyN') this.onPanel('note');
      if (e.code === 'KeyB') this.onPanel('answer');
      if (e.code === 'Tab') { this.onPanel('rank'); e.preventDefault(); }
      if (e.code === 'KeyT') this.onPanel('chat');
      if (e.code === 'Escape') this.onPanel('close');
      apply();
    });
    addEventListener('keyup', (e) => { k[e.code] = false; apply(); });
    addEventListener('blur', () => { for (const c in k) k[c] = false; apply(); this.firing = false; });

    // ============================================================
    //  ★ PC 마우스 — 포인터 잠금(마우스 감추기)을 쓰지 않는다.
    //
    //  예전에는 화면을 한 번 클릭하면 마우스가 잡혀 버려서, 구급품이나
    //  장비창을 누르려면 ESC 를 먼저 눌러야 했다. 그래서 이렇게 바꿨다.
    //
    //   · 왼쪽 버튼을 누른 채로 끌기  → 시점 회전
    //   · 왼쪽 버튼을 짧게 톡 클릭    → 한 발 발사
    //   · 왼쪽 버튼을 가만히 누르고 있기(0.22초) → 연사 (끌어도 계속 쏜다)
    //   · 오른쪽 버튼을 누르고 있기   → 무조건 연사
    //   · 휠                          → 조준경 확대/축소
    //
    //  마우스 커서가 늘 보이므로 화면 위 버튼을 바로 누를 수 있다.
    // ============================================================
    const cvs = document.getElementById('c');
    if (document.pointerLockElement) document.exitPointerLock?.();

    let dragging = false, moved = 0, downAt = 0, lastM = null, holdT = null;
    const overUI = (t) => !!(t && t.closest && t.closest(
      '#actions,#rightTabs,#ammoBar,#bBar,.panel,#stick,#topLeft,#topRight,' +
      '#revealOverlay,#downOverlay,#bDeadOverlay,#bLobby,#bOverOverlay,#resultOverlay'));

    const stopHold = () => { if (holdT) { clearTimeout(holdT); holdT = null; } };

    addEventListener('mousedown', (e) => {
      if (this.isTouch) return;
      if (overUI(e.target)) return;
      if (e.button === 2) {                      // 오른쪽 = 그냥 연사
        this.firing = true;
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      dragging = true; moved = 0; downAt = performance.now();
      lastM = { x: e.clientX, y: e.clientY };
      stopHold();
      // 가만히 누르고 있으면 연사 시작 (끌기 시작했으면 취소)
      holdT = setTimeout(() => { if (dragging && moved < 8) this.firing = true; }, 220);
    });

    addEventListener('mousemove', (e) => {
      if (!dragging || !lastM) return;
      const dx = e.clientX - lastM.x, dy = e.clientY - lastM.y;
      moved += Math.hypot(dx, dy);
      if (moved >= 8) stopHold();                // 끌기 = 회전. 자동 연사는 걸지 않는다
      this.lookDX += dx * 0.0026 * this.lookScale;
      this.lookDY += dy * 0.0026 * this.lookScale;
      lastM = { x: e.clientX, y: e.clientY };
    });

    addEventListener('mouseup', (e) => {
      if (e.button === 2) { this.firing = false; return; }
      if (e.button !== 0) return;
      stopHold();
      const quick = performance.now() - downAt < 220;
      const wasFiring = this.firing;
      this.firing = false;
      // 끌지 않고 톡 눌렀다 뗐으면 한 발
      if (dragging && quick && moved < 8 && !wasFiring) this.onTapFire();
      dragging = false; lastM = null;
    });

    addEventListener('blur', () => { dragging = false; lastM = null; stopHold(); this.firing = false; });
    addEventListener('contextmenu', (e) => { if (!this.isTouch && !overUI(e.target)) e.preventDefault(); });

    addEventListener('wheel', (e) => {
      if (this.isTouch) return;
      if (overUI(e.target)) return;
      this.onZoom(e.deltaY > 0 ? 0.86 : 1.16, 'mul', e.deltaY > 0 ? 1 : -1);
      e.preventDefault();
    }, { passive: false });
  }
}

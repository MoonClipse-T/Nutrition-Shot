// ============================================================
//  world.js — 섬 지형 · 컨테이너 야드 · 비커 · 시약 상자 만들기
//             + 충돌 판정 (박스 그리드)
// ============================================================
import * as THREE from 'three';
import { LAYOUT, terrainHeight, MAP, TRAIN, SEA_Y } from './layout.js';
import { REAGENTS } from './gamedata.js';

const TMP = new THREE.Object3D();
const STEP_UP = 0.8;   // 이 높이까지는 점프 없이 걸어서 올라간다 (계단 한 칸)

export class World {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.beakers = [];
    this.pickupMeshes = new Map();
    this.grid = new Map();          // 충돌 가속용 격자
    this.cell = 18;

    this._sky(scene);
    this._terrain(scene);
    this._sea(scene);
    this._solids(scene);
    this._props(scene);
    this._beakers(scene);
    this._bases(scene);
    this._fires(scene);
    this._training(scene);
    this._buildGrid();
  }

  // ---------- 하늘 ----------
  _sky(scene) {
    const geo = new THREE.SphereGeometry(700, 24, 14);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color('#4a86c9') },
        mid: { value: new THREE.Color('#a8c8e0') },
        bot: { value: new THREE.Color('#d8e4ec') },
      },
      vertexShader: `varying float vY;
        void main(){ vY = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vY; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
        void main(){
          float y = vY*0.5+0.5;
          vec3 c = mix(bot, mid, smoothstep(0.42,0.55,y));
          c = mix(c, top, smoothstep(0.55,0.9,y));
          gl_FragColor = vec4(c,1.0);
        }`,
    });
    scene.add(new THREE.Mesh(geo, mat));
    scene.fog = new THREE.Fog('#b9cfdd', 90, 330);
  }

  // ---------- 지형 ----------
  _terrain(scene) {
    const seg = this.quality === 'low' ? 112 : this.quality === 'mid' ? 164 : 216;
    const size = MAP.ISLAND_R * 2 + 70;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color('#61833f');
    const grass2 = new THREE.Color('#7a9a4c');
    const sand = new THREE.Color('#d8c48c');
    const dirt = new THREE.Color('#8a7a55');
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const d = Math.hypot(x, z);
      let h = d > MAP.ISLAND_R + 12 ? -14 : terrainHeight(x, z);
      pos.setY(i, h);

      if (h < 0.4) c.copy(sand);
      else if (Math.max(Math.abs(x), Math.abs(z)) < 64) c.copy(dirt);
      else c.copy(grass).lerp(grass2, (Math.sin(x * 0.07) * Math.cos(z * 0.06) + 1) / 2);
      // 살짝 얼룩
      const n = (Math.sin(x * 0.31 + z * 0.17) + 1) * 0.5;
      c.offsetHSL(0, 0, (n - 0.5) * 0.06);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = this.quality === 'high';
    scene.add(mesh);
    this.terrainMesh = mesh;
  }

  // ---------- 바다 ----------
  _sea(scene) {
    const geo = new THREE.PlaneGeometry(1600, 1600, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: '#2f6f96', transparent: true, opacity: 0.9,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = SEA_Y;
    scene.add(m);
    this.sea = m;
  }

  // ---------- 컨테이너 · 벽 · 바위 (인스턴싱) ----------
  _solids(scene) {
    const list = LAYOUT.solids;
    this.solidBoxes = list;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: false });
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    inst.castShadow = this.quality === 'high';
    inst.receiveShadow = this.quality !== 'low';
    const col = new THREE.Color();
    list.forEach((b, i) => {
      TMP.position.set(b.x, b.y, b.z);
      TMP.rotation.set(0, b.rot, 0);
      TMP.scale.set(b.sx, b.sy, b.sz);
      TMP.updateMatrix();
      inst.setMatrixAt(i, TMP.matrix);
      inst.setColorAt(i, col.set(b.color));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);

    // 컨테이너 세로 골판 느낌을 주는 얇은 띠 (성능 위해 high 에서만)
    if (this.quality === 'high') {
      const cts = list.filter(b => b.kind === 'container');
      const g2 = new THREE.BoxGeometry(1, 1, 1);
      const i2 = new THREE.InstancedMesh(g2, new THREE.MeshLambertMaterial(), cts.length * 2);
      let k = 0;
      for (const b of cts) {
        for (const s of [-1, 1]) {
          TMP.position.set(b.x, b.y + b.sy * 0.32 * s, b.z);
          TMP.scale.set(b.sx * 1.004, 0.10, b.sz * 1.004);
          TMP.rotation.set(0, 0, 0);
          TMP.updateMatrix();
          i2.setMatrixAt(k, TMP.matrix);
          i2.setColorAt(k, col.set(b.color).multiplyScalar(0.72));
          k++;
        }
      }
      i2.instanceMatrix.needsUpdate = true;
      if (i2.instanceColor) i2.instanceColor.needsUpdate = true;
      scene.add(i2);
    }
  }

  _props(scene) {
    const list = LAYOUT.props;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), list.length);
    inst.castShadow = this.quality === 'high';
    const col = new THREE.Color();
    list.forEach((b, i) => {
      TMP.position.set(b.x, b.y, b.z);
      TMP.rotation.set(0, b.rot, 0);
      TMP.scale.set(b.sx, b.sy, b.sz);
      TMP.updateMatrix();
      inst.setMatrixAt(i, TMP.matrix);
      inst.setColorAt(i, col.set(b.color));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
  }

  // ---------- 거대 비커 3개 ----------
  _beakers(scene) {
    const R = 2.6, H = 7.2;
    LAYOUT.beakers.forEach((b, i) => {
      const g = new THREE.Group();
      g.position.set(b.x, b.y, b.z);

      // 받침대
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(R + 1.1, R + 1.4, 0.7, 20),
        new THREE.MeshLambertMaterial({ color: '#3c4653' })
      );
      base.position.y = 0.35;
      g.add(base);

      // 유리
      const glass = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, H, 26, 1, true),
        new THREE.MeshPhongMaterial({
          color: '#cfe8f5', transparent: true, opacity: 0.26,
          side: THREE.DoubleSide, shininess: 90, depthWrite: false,
        })
      );
      glass.position.y = 0.7 + H / 2;
      g.add(glass);

      // 액체 (멀리서도 색이 보이도록 꽉 채우고 불투명하게)
      const liq = new THREE.Mesh(
        new THREE.CylinderGeometry(R - 0.1, R - 0.1, H * 0.72, 26),
        new THREE.MeshLambertMaterial({ color: '#cfe9f5' })
      );
      liq.position.y = 0.7 + H * 0.36;
      g.add(liq);

      // 눈금
      for (let k = 1; k <= 4; k++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(R + 0.02, 0.035, 4, 22),
          new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45 })
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.7 + (H / 5) * k;
        g.add(ring);
      }

      // 라벨판 (A/B/C)
      const cvs = document.createElement('canvas');
      cvs.width = 256; cvs.height = 256;
      const cx = cvs.getContext('2d');
      cx.fillStyle = '#f6f2e6'; cx.fillRect(0, 0, 256, 256);
      cx.strokeStyle = '#c9bfa5'; cx.lineWidth = 10; cx.strokeRect(5, 5, 246, 246);
      cx.fillStyle = '#20262e'; cx.font = 'bold 140px sans-serif';
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText(b.label, 128, 108);
      cx.font = 'bold 30px sans-serif'; cx.fillStyle = '#7a6a4a';
      cx.fillText('미지의 음료', 128, 196);
      cx.font = 'bold 24px sans-serif'; cx.fillStyle = '#a2937a';
      cx.fillText(`제${b.zone}실험장`, 128, 228);
      const tex = new THREE.CanvasTexture(cvs);
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(2.6, 2.6),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true })
      );
      label.position.set(0, 0.7 + H * 0.55, R + 0.06);
      g.add(label);
      const label2 = label.clone();
      label2.position.set(0, 0.7 + H * 0.55, -R - 0.06);
      label2.rotation.y = Math.PI;
      g.add(label2);

      // 멀리서도 보이는 기둥 빛 (배그 보급 상자 느낌)
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 0.85, R * 1.15, 46, 14, 1, true),
        new THREE.MeshBasicMaterial({
          color: '#ffe08a', transparent: true, opacity: 0.10,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      beam.position.y = 24;
      g.add(beam);

      // 반응 결과 표시판 (누가 무슨 시약을 쐈고 결과가 뭔지)
      const rc = document.createElement('canvas');
      rc.width = 512; rc.height = 160;
      const rtex = new THREE.CanvasTexture(rc);
      const resultPanel = new THREE.Mesh(
        new THREE.PlaneGeometry(7.2, 2.25),
        new THREE.MeshBasicMaterial({ map: rtex, transparent: true, depthTest: false })
      );
      resultPanel.position.set(0, 0.7 + H + 2.2, 0);
      resultPanel.renderOrder = 10;
      resultPanel.visible = false;
      g.add(resultPanel);

      scene.add(g);
      this.beakers.push({
        resultPanel, resultCanvas: rc, resultTex: rtex, resultUntil: 0,
        index: i, drink: b.drink, zone: b.zone,
        group: g, liquid: liq, glass, beam,
        x: b.x, y: b.y, z: b.z, label: b.label,
        baseColor: new THREE.Color('#cfe9f5'), reactUntil: 0,
      });
    });
  }

  setBeakerLiquid(i, hex) {
    const b = this.beakers[i];
    if (!b) return;
    b.baseColor.set(hex);
    if (performance.now() > b.reactUntil) b.liquid.material.color.copy(b.baseColor);
  }

  reactBeaker(i, color, seconds) {
    const b = this.beakers[i];
    if (!b) return;
    if (color) {
      b.liquid.material.color.set(color);
      b.reactUntil = performance.now() + seconds * 1000;
    }
  }

  // 비커 위에 "뷰렛 → 보라색 / 홍길동 · 양성 ＋" 같은 결과판을 띄운다.
  // 모둠원끼리 연달아 쏴도 무엇에 대한 반응인지 헷갈리지 않게 하는 장치.
  showBeakerLabel(i, { text, sub, color, positive, seconds }) {
    const b = this.beakers[i];
    if (!b) return;
    const c = b.resultCanvas.getContext('2d');
    const W = b.resultCanvas.width, H = b.resultCanvas.height;
    c.clearRect(0, 0, W, H);

    c.fillStyle = 'rgba(12,17,24,.9)';
    roundRect(c, 4, 4, W - 8, H - 8, 22); c.fill();
    c.strokeStyle = color; c.lineWidth = 6; c.stroke();

    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = positive ? color : '#c3cede';
    c.font = 'bold 56px "Noto Sans KR", sans-serif';
    c.fillText(text, W / 2, 62);
    c.fillStyle = '#93a3b4';
    c.font = 'bold 34px "Noto Sans KR", sans-serif';
    c.fillText(sub, W / 2, 116);

    b.resultTex.needsUpdate = true;
    b.resultPanel.visible = true;
    b.resultPanel.material.opacity = 1;
    b.resultUntil = performance.now() + seconds * 1000;
  }

  updateBeakers(t, camera) {
    const now = performance.now();
    for (const b of this.beakers) {
      if (b.reactUntil && now > b.reactUntil) {
        b.reactUntil = 0;
        b.liquid.material.color.copy(b.baseColor);
      }
      if (b.resultPanel.visible) {
        const left = (b.resultUntil - now) / 1000;
        if (left <= 0) b.resultPanel.visible = false;
        else {
          b.resultPanel.material.opacity = Math.min(1, left);
          if (camera) b.resultPanel.lookAt(camera.position);   // 항상 정면을 보게
        }
      }
      b.beam.material.opacity = 0.08 + Math.sin(t * 1.6 + b.index) * 0.03;
    }
  }

  // ---------- 모둠 안전구역 표시 ----------
  _bases(scene) {
    this.baseRings = [];
    for (const b of LAYOUT.bases) {
      const g = new THREE.Group();
      g.position.set(b.x, b.y + 0.06, b.z);

      // 바닥 링 (안전구역 경계)
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(b.r - 1.2, b.r, 56),
        new THREE.MeshBasicMaterial({
          color: b.color, transparent: true, opacity: 0.42,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      g.add(ring);

      // 안쪽을 살짝 물들여 '여기가 안전구역'임을 알린다
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(b.r - 1.2, 44),
        new THREE.MeshBasicMaterial({
          color: b.color, transparent: true, opacity: 0.07,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.02;
      g.add(disc);

      // 창고 위 모둠 간판
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 168;
      const cx = cv.getContext('2d');
      cx.fillStyle = 'rgba(12,17,24,.92)';
      roundRect(cx, 4, 4, 504, 160, 26); cx.fill();
      cx.strokeStyle = b.color; cx.lineWidth = 7; cx.stroke();
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillStyle = b.color;
      cx.font = 'bold 66px "Noto Sans KR", sans-serif';
      cx.fillText(b.name, 256, 62);
      cx.fillStyle = '#93a3b4';
      cx.font = 'bold 36px "Noto Sans KR", sans-serif';
      cx.fillText('🛡 안전구역 · 정답 제출', 256, 124);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(11, 3.6),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true })
      );
      sign.position.y = b.H + 4.6;
      g.add(sign);
      const sign2 = sign.clone();
      sign2.rotation.y = Math.PI;
      g.add(sign2);

      // 멀리서도 보이는 모둠 색 기둥
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 3.2, 40, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: b.color, transparent: true, opacity: 0.09,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      beam.position.y = b.H + 20;
      g.add(beam);

      scene.add(g);
      this.baseRings.push({ base: b, group: g, ring, sign, sign2 });
    }
  }

  // ---------- 가열대(불꽃) ----------
  //  베네딕트 반응은 가열이 필요하다 → 필드 곳곳의 불에 다가가 몸을 데운다.
  //  여러 곳 × 여러 조각이라 전부 InstancedMesh 로 묶어서 그린다 (태블릿 배려).
  _fires(scene) {
    const list = LAYOUT.fires || [];
    this.fires = list;
    if (!list.length) return;
    const C = new THREE.Color();

    // 1) 돌 화덕 + 장작 (움직이지 않는 부분)
    const stone = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1.9, 2.2, 0.5, 10),
      new THREE.MeshLambertMaterial(), list.length);
    const logs = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.6, 0.42, 0.42),
      new THREE.MeshLambertMaterial(), list.length * 2);
    list.forEach((f, i) => {
      TMP.position.set(f.x, f.y + 0.22, f.z);
      TMP.rotation.set(0, 0, 0); TMP.scale.set(1, 1, 1);
      TMP.updateMatrix();
      stone.setMatrixAt(i, TMP.matrix);
      stone.setColorAt(i, C.set('#6b6864'));
      for (let k = 0; k < 2; k++) {
        TMP.position.set(f.x, f.y + 0.5, f.z);
        TMP.rotation.set(0, k ? Math.PI / 2.4 : 0, k ? 0.12 : -0.1);
        TMP.scale.set(1, 1, 1);
        TMP.updateMatrix();
        logs.setMatrixAt(i * 2 + k, TMP.matrix);
        logs.setColorAt(i * 2 + k, C.set('#5c4025'));
      }
    });
    stone.instanceMatrix.needsUpdate = true;
    logs.instanceMatrix.needsUpdate = true;
    if (stone.instanceColor) stone.instanceColor.needsUpdate = true;
    if (logs.instanceColor) logs.instanceColor.needsUpdate = true;
    scene.add(stone); scene.add(logs);

    // 2) 불꽃 — 콘 3개씩, 매 프레임 흔들린다
    this.flameCount = 3;
    const flameGeo = new THREE.ConeGeometry(0.62, 2.0, 7);
    flameGeo.translate(0, 1.0, 0);          // 밑동이 원점에 오도록
    this.flames = new THREE.InstancedMesh(
      flameGeo,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92, depthWrite: false }),
      list.length * this.flameCount
    );
    this.flames.frustumCulled = false;
    const FCOL = ['#ff5d1f', '#ffa62b', '#ffe066'];
    for (let i = 0; i < list.length; i++) {
      for (let k = 0; k < this.flameCount; k++) {
        this.flames.setColorAt(i * this.flameCount + k, C.set(FCOL[k]));
      }
    }
    if (this.flames.instanceColor) this.flames.instanceColor.needsUpdate = true;
    scene.add(this.flames);

    // 3) 멀리서도 보이는 주황 기둥 (불을 찾아갈 수 있게)
    const smoke = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.9, 2.0, 22, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: '#ff9a3c', transparent: true, opacity: 0.10,
        side: THREE.DoubleSide, depthWrite: false,
      }),
      list.length
    );
    list.forEach((f, i) => {
      TMP.position.set(f.x, f.y + 11.5, f.z);
      TMP.rotation.set(0, 0, 0); TMP.scale.set(1, 1, 1);
      TMP.updateMatrix();
      smoke.setMatrixAt(i, TMP.matrix);
    });
    smoke.instanceMatrix.needsUpdate = true;
    scene.add(smoke);

    // 4) 「🔥 가열대」 안내판 — 무엇에 쓰는 물건인지 바로 알 수 있게
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 160;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(20,12,6,.90)';
    roundRect(c, 4, 4, 504, 152, 22); c.fill();
    c.strokeStyle = '#ff9a3c'; c.lineWidth = 6; c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#ffcc4d';
    c.font = 'bold 56px "Noto Sans KR", sans-serif';
    c.fillText('🔥 가열대', 256, 52);
    c.fillStyle = '#e8d6c0';
    c.font = 'bold 30px "Noto Sans KR", sans-serif';
    c.fillText('베네딕트는 데운 뒤에 쏘기', 256, 112);
    const signMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false,
    });
    this.fireSigns = [];
    for (const f of list) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(5.0, 1.56), signMat);
      s.position.set(f.x, f.y + 4.9, f.z);
      scene.add(s);
      this.fireSigns.push(s);
    }
  }

  // 불꽃 애니메이션 + 간판이 항상 카메라를 보게
  updateFires(t, camera) {
    if (!this.flames || !this.fires) return;
    const n = this.flameCount;
    for (let i = 0; i < this.fires.length; i++) {
      const f = this.fires[i];
      for (let k = 0; k < n; k++) {
        const ph = t * (3.2 + k * 0.9) + i * 1.7 + k * 2.1;
        const s = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(ph)) - k * 0.16;
        TMP.position.set(
          f.x + Math.sin(ph * 0.7) * 0.16,
          f.y + 0.55 + k * 0.16,
          f.z + Math.cos(ph * 0.6) * 0.16
        );
        TMP.rotation.set(0, ph * 0.5, Math.sin(ph) * 0.09);
        TMP.scale.set(s, s * (1.05 + 0.2 * Math.sin(ph * 1.3)), s);
        TMP.updateMatrix();
        this.flames.setMatrixAt(i * n + k, TMP.matrix);
      }
    }
    this.flames.instanceMatrix.needsUpdate = true;
    if (camera && this.fireSigns) {
      for (const s of this.fireSigns) s.quaternion.copy(camera.quaternion);
    }
  }

  // 가장 가까운 불꽃까지의 거리 (HUD 안내용)
  nearestFire(x, z) {
    let best = null, bd = Infinity;
    for (const f of (this.fires || [])) {
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < bd) { bd = d; best = f; }
    }
    return best ? { fire: best, dist: bd } : null;
  }

  // ---------- 대기 공간(훈련장) ----------
  _training(scene) {
    const t = LAYOUT.training;
    this.trainTargets = [];
    const g = new THREE.Group();
    scene.add(g);

    // 과녁 얼굴
    for (const tg of t.targets) {
      const cv = document.createElement('canvas');
      cv.width = 128; cv.height = 128;
      const c = cv.getContext('2d');
      const rings = [['#e0453c', 60], ['#f6f2e6', 46], ['#e0453c', 32], ['#f6f2e6', 18], ['#e0453c', 8]];
      c.fillStyle = '#f6f2e6'; c.fillRect(0, 0, 128, 128);
      for (const [col, r] of rings) { c.fillStyle = col; c.beginPath(); c.arc(64, 64, r, 0, 7); c.fill(); }
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(4.0, 4.0),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv) })
      );
      face.position.set(tg.x, tg.y, tg.z - 0.45);
      face.rotation.y = Math.PI;
      g.add(face);
      this.trainTargets.push({ pos: new THREE.Vector3(tg.x, tg.y, tg.z), mesh: face, until: 0 });
    }

    // 안내판
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(12,17,24,.94)';
    roundRect(c, 6, 6, 1012, 500, 34); c.fill();
    c.strokeStyle = '#ffcc4d'; c.lineWidth = 8; c.stroke();
    c.textAlign = 'center'; c.fillStyle = '#ffcc4d';
    c.font = 'bold 62px "Noto Sans KR", sans-serif';
    c.fillText('대기 공간 — 조작 연습', 512, 86);
    c.textAlign = 'left';
    c.fillStyle = '#e8eef5';
    c.font = 'bold 40px "Noto Sans KR", sans-serif';
    const lines = [
      '① 왼쪽 화면을 드래그해서 이동 (끝까지 밀면 달리기)',
      '② 오른쪽 화면을 문질러 시점 돌리기',
      '③ [점프]로 색깔 상자에 올라가 보기',
      '④ [앉기]로 낮은 통로 지나가 보기',
      '⑤ [발사]로 과녁 맞히기 — 여기선 탄약이 줄지 않아요',
      '⑥ 🎓 자격시험은 게임이 시작된 뒤에 볼 수 있습니다',
    ];
    lines.forEach((L, i) => c.fillText(L, 66, 172 + i * 56));
    c.textAlign = 'center';
    c.fillStyle = '#93a3b4';
    c.font = 'bold 34px "Noto Sans KR", sans-serif';
    c.fillText('선생님이 시작하면 다같이 섬으로 출발합니다', 512, 478);

    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 13),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true })
    );
    board.position.set(TRAIN.cx, TRAIN.floorY + 8.5, TRAIN.cz - TRAIN.half + 1.2);
    g.add(board);
    this.trainGroup = g;
  }

  hitTarget(tg) {
    tg.mesh.material.color.set('#7fd4ff');
    clearTimeout(tg._t);
    tg._t = setTimeout(() => tg.mesh.material.color.set('#ffffff'), 220);
  }

  // ---------- 시약 상자 (시약 종류별 인스턴싱 = 드로우콜 8개) ----------
  buildPickups(list) {
    this.pickupGroups = {};
    const byReagent = {};
    for (const p of list) {
      (byReagent[p.reagent] ||= []).push(p);
      this.pickupMeshes.set(p.id, { data: p, visible: true, slot: byReagent[p.reagent].length - 1 });
    }

    for (const rid in byReagent) {
      const arr = byReagent[rid];
      const rg = REAGENTS[rid];
      const geo = mergeColored([
        { g: new THREE.BoxGeometry(1.1, 0.9, 1.1), c: '#3b4552', p: [0, 0, 0] },
        { g: new THREE.BoxGeometry(1.16, 0.14, 1.16), c: '#252c35', p: [0, 0.44, 0] },
        { g: new THREE.CylinderGeometry(0.3, 0.34, 0.9, 10), c: rg.color, p: [0, 0.9, 0] },
        { g: new THREE.CylinderGeometry(0.16, 0.16, 0.25, 8), c: '#e9edf2', p: [0, 1.45, 0] },
      ]);
      const inst = new THREE.InstancedMesh(geo,
        new THREE.MeshLambertMaterial({ vertexColors: true }), arr.length);
      inst.frustumCulled = false;
      this.scene.add(inst);

      const halo = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.95, 0.95, 9, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: rg.color, transparent: true, opacity: 0.16,
          side: THREE.DoubleSide, depthWrite: false,
        }), arr.length);
      halo.frustumCulled = false;
      this.scene.add(halo);

      this.pickupGroups[rid] = { inst, halo, arr };
    }
    this.updatePickups(0);
  }

  setPickupTaken(id, taken) {
    const m = this.pickupMeshes.get(id);
    if (!m) return;
    m.visible = !taken;
  }

  // ---------- ★ 슈팅 모드 보급 상자 (총 / 탄약 / 구급품) ----------
  //  시약 상자와 같은 자리를 쓰지만 겉모습이 다르다. 종류는 매 판 새로 굴린다.
  buildLoot(list) {
    if (this.lootGroups) return;
    this.lootData = new Map();
    for (const l of list) this.lootData.set(l.id, { ...l, visible: true });
    this.lootOrder = list.map(l => l.id);

    const N = list.length;
    const make = (parts, color) => {
      const inst = new THREE.InstancedMesh(mergeColored(parts),
        new THREE.MeshLambertMaterial({ vertexColors: true }), N);
      inst.frustumCulled = false;
      inst.visible = false;
      this.scene.add(inst);
      const halo = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.95, 0.95, 9, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.18,
          side: THREE.DoubleSide, depthWrite: false,
        }), N);
      halo.frustumCulled = false;
      halo.visible = false;
      this.scene.add(halo);
      return { inst, halo };
    };

    this.lootGroups = {
      // 총기 상자 — 노란 나무상자 위에 총 실루엣
      gun: make([
        { g: new THREE.BoxGeometry(1.3, 0.8, 0.9), c: '#8a6b32', p: [0, 0, 0] },
        { g: new THREE.BoxGeometry(1.36, 0.12, 0.96), c: '#5d4720', p: [0, 0.4, 0] },
        { g: new THREE.BoxGeometry(1.5, 0.14, 0.16), c: '#2f3640', p: [0, 0.75, 0] },
        { g: new THREE.BoxGeometry(0.3, 0.34, 0.14), c: '#2f3640', p: [-0.4, 0.56, 0] },
        { g: new THREE.CylinderGeometry(0.1, 0.1, 0.5, 6), c: '#ffd76a', p: [0.55, 0.95, 0] },
      ], '#ffd76a'),
      // 탄약 상자 — 파란 철제 상자
      ammo: make([
        { g: new THREE.BoxGeometry(1.0, 0.66, 0.7), c: '#33506e', p: [0, 0, 0] },
        { g: new THREE.BoxGeometry(1.06, 0.12, 0.76), c: '#22384f', p: [0, 0.34, 0] },
        { g: new THREE.CylinderGeometry(0.09, 0.09, 0.42, 6), c: '#e8c15a', p: [-0.2, 0.6, 0] },
        { g: new THREE.CylinderGeometry(0.09, 0.09, 0.42, 6), c: '#e8c15a', p: [0.05, 0.6, 0] },
        { g: new THREE.CylinderGeometry(0.09, 0.09, 0.42, 6), c: '#e8c15a', p: [0.3, 0.6, 0] },
      ], '#9fd0ff'),
      // 구급품 — 흰 상자에 빨간 십자
      med: make([
        { g: new THREE.BoxGeometry(1.0, 0.7, 0.8), c: '#f2f4f7', p: [0, 0, 0] },
        { g: new THREE.BoxGeometry(1.04, 0.12, 0.84), c: '#d7dde4', p: [0, 0.36, 0] },
        { g: new THREE.BoxGeometry(0.66, 0.16, 0.06), c: '#e5484d', p: [0, 0.1, 0.42] },
        { g: new THREE.BoxGeometry(0.16, 0.5, 0.06), c: '#e5484d', p: [0, 0.1, 0.42] },
        { g: new THREE.TorusGeometry(0.2, 0.05, 6, 10), c: '#9aa7b4', p: [0, 0.5, 0] },
      ], '#ff8a8a'),
    };
  }

  setLootVisible(on) {
    this.lootOn = !!on;
    // 슈팅 모드에서는 시약 상자를 감춘다 (반대도 마찬가지).
    // 보급 상자가 아직 안 왔더라도 시약 상자는 먼저 감춰야 화면이 섞이지 않는다.
    for (const rid in (this.pickupGroups || {})) {
      this.pickupGroups[rid].inst.visible = !on;
      this.pickupGroups[rid].halo.visible = !on;
    }
    if (!this.lootGroups) return;
    for (const k in this.lootGroups) {
      this.lootGroups[k].inst.visible = !!on;
      this.lootGroups[k].halo.visible = !!on;
    }
  }

  setLoot(id, patch) {
    const l = this.lootData?.get(id);
    if (l) Object.assign(l, patch);
  }

  updateLoot(t) {
    if (!this.lootGroups || !this.lootOn) return;
    const order = this.lootOrder;
    for (const kind in this.lootGroups) {
      const { inst, halo } = this.lootGroups[kind];
      for (let i = 0; i < order.length; i++) {
        const l = this.lootData.get(order[i]);
        if (!l || !l.visible || l.kind !== kind) {
          TMP.scale.set(0, 0, 0); TMP.position.set(0, -999, 0); TMP.rotation.set(0, 0, 0);
          TMP.updateMatrix();
          inst.setMatrixAt(i, TMP.matrix);
          halo.setMatrixAt(i, TMP.matrix);
          continue;
        }
        TMP.scale.set(1, 1, 1);
        TMP.position.set(l.x, l.y + 0.6 + Math.sin(t * 2 + l.id) * 0.12, l.z);
        TMP.rotation.set(0, t * 0.9, 0);
        TMP.updateMatrix();
        inst.setMatrixAt(i, TMP.matrix);
        TMP.position.set(l.x, l.y + 4.4, l.z);
        TMP.rotation.set(0, 0, 0);
        TMP.updateMatrix();
        halo.setMatrixAt(i, TMP.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      halo.instanceMatrix.needsUpdate = true;
    }
  }

  updatePickups(t) {
    for (const rid in this.pickupGroups) {
      const { inst, halo, arr } = this.pickupGroups[rid];
      for (let i = 0; i < arr.length; i++) {
        const st = this.pickupMeshes.get(arr[i].id);
        if (!st.visible) {
          TMP.scale.set(0, 0, 0);
          TMP.position.set(0, -999, 0);
          TMP.rotation.set(0, 0, 0);
          TMP.updateMatrix();
          inst.setMatrixAt(i, TMP.matrix);
          halo.setMatrixAt(i, TMP.matrix);
          continue;
        }
        const y = arr[i].y + 0.6 + Math.sin(t * 2 + arr[i].id) * 0.12;
        TMP.scale.set(1, 1, 1);
        TMP.position.set(arr[i].x, y, arr[i].z);
        TMP.rotation.set(0, t * 0.9, 0);
        TMP.updateMatrix();
        inst.setMatrixAt(i, TMP.matrix);
        TMP.position.set(arr[i].x, arr[i].y + 4.4, arr[i].z);
        TMP.rotation.set(0, 0, 0);
        TMP.updateMatrix();
        halo.setMatrixAt(i, TMP.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      halo.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- 충돌 ----------
  _buildGrid() {
    for (let i = 0; i < this.solidBoxes.length; i++) {
      const b = this.solidBoxes[i];
      const x0 = Math.floor((b.x - b.sx / 2) / this.cell);
      const x1 = Math.floor((b.x + b.sx / 2) / this.cell);
      const z0 = Math.floor((b.z - b.sz / 2) / this.cell);
      const z1 = Math.floor((b.z + b.sz / 2) / this.cell);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gz = z0; gz <= z1; gz++) {
          const k = gx + ',' + gz;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(i);
        }
      }
    }
  }

  nearbyBoxes(x, z, pad = 1) {
    const out = [];
    const gx = Math.floor(x / this.cell), gz = Math.floor(z / this.cell);
    for (let i = -pad; i <= pad; i++) {
      for (let j = -pad; j <= pad; j++) {
        const arr = this.grid.get((gx + i) + ',' + (gz + j));
        if (arr) for (const idx of arr) if (!out.includes(idx)) out.push(idx);
      }
    }
    return out;
  }

  // 원기둥(플레이어)을 박스 밖으로 밀어낸다. 반환: 서 있을 수 있는 바닥 높이
  //
  // ★ 2패스로 나눈 이유
  //   1패스에서 '올라설 수 있는 면'을 먼저 찾고, 2패스(수평 충돌)는 그 면을
  //   발밑으로 간주해서 계산한다. 한 프레임에 중력으로 몇 cm 가라앉았을 때
  //   플랫폼 옆면 충돌로 판정돼 옆으로 튕겨 나가는 것을 막는다.
  //   (프레임이 낮은 태블릿에서 컨테이너·창고 옥상 위에 있을 때 실제로 발생)
  resolve(pos, radius, height) {
    const near = this.nearbyBoxes(pos.x, pos.z);
    let groundY = terrainHeight(pos.x, pos.z);

    // --- 1패스 : 딛고 설 수 있는 윗면 찾기 ---
    for (const idx of near) {
      const b = this.solidBoxes[idx];
      const bx0 = b.x - b.sx / 2, bx1 = b.x + b.sx / 2;
      const by1 = b.y + b.sy / 2;
      const bz0 = b.z - b.sz / 2, bz1 = b.z + b.sz / 2;
      const insideXZ = pos.x > bx0 - radius && pos.x < bx1 + radius &&
                       pos.z > bz0 - radius && pos.z < bz1 + radius;
      if (!insideXZ) continue;
      // 계단 한 칸(0.8m)까지는 자동으로 올라서고, 살짝 가라앉은 경우(1.5m)도 그 면으로 본다
      if (by1 > groundY && by1 <= pos.y + STEP_UP && by1 >= pos.y - 1.5) groundY = by1;
    }

    // 발밑은 '실제 y' 와 '딛고 선 면' 중 높은 쪽
    const feet = Math.max(pos.y, groundY);
    const head = feet + height;

    // --- 2패스 : 수평 충돌 ---
    for (const idx of near) {
      const b = this.solidBoxes[idx];
      const bx0 = b.x - b.sx / 2, bx1 = b.x + b.sx / 2;
      const by0 = b.y - b.sy / 2, by1 = b.y + b.sy / 2;
      const bz0 = b.z - b.sz / 2, bz1 = b.z + b.sz / 2;

      if (head < by0 + 0.02 || feet > by1 - 0.06) continue;
      const cx = Math.max(bx0, Math.min(pos.x, bx1));
      const cz = Math.max(bz0, Math.min(pos.z, bz1));
      const dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;

      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * radius;
        pos.z = cz + (dz / d) * radius;
      } else {
        // 완전히 내부 → 가장 가까운 면으로 밀어낸다
        const px = Math.min(pos.x - bx0, bx1 - pos.x);
        const pz = Math.min(pos.z - bz0, bz1 - pos.z);
        if (px < pz) pos.x += (pos.x - b.x > 0 ? 1 : -1) * (px + radius);
        else pos.z += (pos.z - b.z > 0 ? 1 : -1) * (pz + radius);
      }
    }
    return groundY;
  }

  // 총알 레이캐스트: 박스와 만나는 가장 가까운 지점
  raycastSolids(origin, dir, maxDist) {
    let best = maxDist, hit = null;
    const steps = Math.ceil(maxDist / this.cell) + 1;
    const seen = new Set();
    for (let s = 0; s <= steps; s++) {
      const px = origin.x + dir.x * (s * this.cell);
      const pz = origin.z + dir.z * (s * this.cell);
      for (const idx of this.nearbyBoxes(px, pz, 1)) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const b = this.solidBoxes[idx];
        const t = rayBox(origin, dir,
          b.x - b.sx / 2, b.y - b.sy / 2, b.z - b.sz / 2,
          b.x + b.sx / 2, b.y + b.sy / 2, b.z + b.sz / 2);
        if (t !== null && t > 0.2 && t < best) { best = t; hit = b; }
      }
    }
    // 지면
    let g = null;
    for (let t = 1; t < Math.min(best, maxDist); t += 1.2) {
      const y = origin.y + dir.y * t;
      const h = terrainHeight(origin.x + dir.x * t, origin.z + dir.z * t);
      if (y <= h) { g = t; break; }
    }
    if (g !== null && g < best) { best = g; hit = { kind: 'ground' }; }
    return { dist: best, hit };
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

// 여러 지오메트리를 정점 색을 입혀 하나로 합친다 (드로우콜 절약)
function mergeColored(parts) {
  const geos = parts.map(p => {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    g.translate(p.p[0], p.p[1], p.p[2]);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    const col = new THREE.Color(p.c);
    for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  });
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// 표준 slab 방식 AABB 레이 교차
function rayBox(o, d, x0, y0, z0, x1, y1, z1) {
  let tmin = -Infinity, tmax = Infinity;
  const p = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  const lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-8) {
      if (p[i] < lo[i] || p[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - p[i]) / dd[i];
      let t2 = (hi[i] - p[i]) / dd[i];
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin > 0 ? tmin : (tmax > 0 ? tmax : null);
}

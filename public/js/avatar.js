// ============================================================
//  avatar.js — 저폴리 캐릭터 (배그 느낌의 3인칭 병사)
//  32명이 동시에 보이므로 드로우콜을 줄이는 게 핵심.
//  움직이지 않는 부위(몸통·머리·헬멧·배낭)는 하나의 지오메트리로 합친다.
//  → 한 사람당 7개 메쉬 (몸 1 + 팔 2 + 다리 2 + 총 1 + 시약탱크 1)
// ============================================================
import * as THREE from 'three';

// ---- 색이 입혀진 박스들을 하나의 지오메트리로 합치는 도우미 ----
function mergedBoxes(parts) {
  const geos = parts.map(p => {
    const g = new THREE.BoxGeometry(p.s[0], p.s[1], p.s[2]).toNonIndexed();
    g.translate(p.p[0], p.p[1], p.p[2]);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    const col = new THREE.Color(p.c);
    for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
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
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const C = {
  skin: '#d9a077', pants: '#3b4250', boot: '#22262e',
  gun: '#2c3138', metal: '#575e68', pack: '#4b5240',
};

// 팀 색마다 몸통 지오메트리를 한 번만 만들어 재사용
const bodyCache = new Map();
function bodyGeo(team) {
  if (!bodyCache.has(team)) {
    bodyCache.set(team, mergedBoxes([
      { s: [0.62, 0.72, 0.34], p: [0, 1.16, 0], c: team },        // 몸통
      { s: [0.44, 0.20, 0.44], p: [0, 1.90, 0], c: team },        // 헬멧
      { s: [0.36, 0.36, 0.36], p: [0, 1.70, 0], c: C.skin },      // 머리
      { s: [0.56, 0.24, 0.32], p: [0, 0.76, 0], c: C.pants },     // 골반
      { s: [0.46, 0.50, 0.22], p: [0, 1.18, -0.27], c: C.pack },  // 배낭
      { s: [0.20, 0.10, 0.06], p: [0, 1.72, 0.19], c: '#232a33' },// 고글
    ]));
  }
  return bodyCache.get(team);
}

// 팔 (팀 색) — 회전축이 어깨가 되도록 아래로 내려 만든다
const armCache = new Map();
function armGeo(team) {
  if (!armCache.has(team)) {
    armCache.set(team, mergedBoxes([
      { s: [0.17, 0.46, 0.17], p: [0, -0.23, 0], c: team },
      { s: [0.18, 0.16, 0.18], p: [0, -0.53, 0], c: C.skin },     // 손
    ]));
  }
  return armCache.get(team);
}

// 다리 + 군화 (모두 공용)
let legGeoCache = null;
function legGeo() {
  if (!legGeoCache) {
    legGeoCache = mergedBoxes([
      { s: [0.21, 0.72, 0.23], p: [0, -0.36, 0], c: C.pants },
      { s: [0.24, 0.16, 0.32], p: [0, -0.70, 0.03], c: C.boot },
    ]);
  }
  return legGeoCache;
}

// 시약총 본체
let gunGeoCache = null;
function gunGeo() {
  if (!gunGeoCache) {
    gunGeoCache = mergedBoxes([
      { s: [0.10, 0.14, 0.86], p: [0, 0, 0], c: C.gun },
      { s: [0.09, 0.26, 0.14], p: [0, -0.18, 0.02], c: C.metal },
      { s: [0.07, 0.09, 0.26], p: [0, 0.13, 0.06], c: C.metal },
      { s: [0.06, 0.06, 0.20], p: [0, 0, 0.52], c: C.metal },     // 총열
      { s: [0.09, 0.20, 0.22], p: [0, -0.06, -0.44], c: C.gun },  // 개머리판
    ]);
  }
  return gunGeoCache;
}

const vcMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const tankGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.34, 8);
const muzzleGeo = new THREE.SphereGeometry(0.17, 6, 5);

export function makeAvatar(teamColor, quality) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const cast = quality === 'high';

  const torso = new THREE.Mesh(bodyGeo(teamColor), vcMat);
  torso.castShadow = cast;
  body.add(torso);

  const ag = armGeo(teamColor);
  const armL = new THREE.Mesh(ag, vcMat); armL.position.set(-0.40, 1.44, 0);
  const armR = new THREE.Mesh(ag, vcMat); armR.position.set(0.40, 1.44, 0);
  const lg = legGeo();
  const legL = new THREE.Mesh(lg, vcMat); legL.position.set(-0.17, 0.72, 0);
  const legR = new THREE.Mesh(lg, vcMat); legR.position.set(0.17, 0.72, 0);
  for (const m of [armL, armR, legL, legR]) { m.castShadow = cast; body.add(m); }

  const gun = new THREE.Group();
  const gm = new THREE.Mesh(gunGeo(), vcMat);
  gm.castShadow = cast;
  gun.add(gm);

  const tankMat = new THREE.MeshPhongMaterial({ color: '#9aa7b4', shininess: 70 });
  const tank = new THREE.Mesh(tankGeo, tankMat);
  tank.rotation.z = Math.PI / 2;
  tank.position.set(0, 0.13, -0.20);
  gun.add(tank);

  const muzzle = new THREE.Mesh(muzzleGeo,
    new THREE.MeshBasicMaterial({ color: '#ffd77a', transparent: true, opacity: 1 }));
  muzzle.position.set(0, 0, 0.62);
  muzzle.visible = false;
  gun.add(muzzle);

  gun.position.set(0.34, 1.28, 0.42);
  body.add(gun);

  root.userData = { body, armL, armR, legL, legR, gun, muzzle, tank: tankMat };
  return root;
}

export function animateAvatar(av, dt, speed, isDown, t, isCrouch = false) {
  const u = av.userData;
  if (!u) return;
  const k = 1 - Math.pow(0.001, dt);
  const lerp = THREE.MathUtils.lerp;

  if (isDown) {
    av.scale.y = lerp(av.scale.y, 0.55, k);
    u.body.position.y = lerp(u.body.position.y, 0, k);
    u.armL.rotation.x = -0.2; u.armR.rotation.x = -0.2;
    u.legL.rotation.x = 0; u.legR.rotation.x = 0;
    u.gun.visible = false;
    return;
  }
  av.scale.y = lerp(av.scale.y, 1, k);
  u.gun.visible = true;

  if (isCrouch) {
    // 확실하게 '앉았다'가 보이도록 — 몸을 낮추고 무릎을 접는다
    u.body.position.y = lerp(u.body.position.y, -0.52, k);
    u.legL.rotation.x = lerp(u.legL.rotation.x, 1.15, k);
    u.legR.rotation.x = lerp(u.legR.rotation.x, 1.15, k);
    u.legL.rotation.z = lerp(u.legL.rotation.z, -0.20, k);
    u.legR.rotation.z = lerp(u.legR.rotation.z, 0.20, k);
    u.armL.rotation.x = lerp(u.armL.rotation.x, -0.95, k);
    u.armR.rotation.x = lerp(u.armR.rotation.x, -1.05, k);
    u.armL.rotation.z = 0.30; u.armR.rotation.z = -0.18;
    u.gun.position.y = lerp(u.gun.position.y, 1.10, k);
    return;
  }

  u.legL.rotation.z = lerp(u.legL.rotation.z, 0, k);
  u.legR.rotation.z = lerp(u.legR.rotation.z, 0, k);
  u.gun.position.y = lerp(u.gun.position.y, 1.28, k);

  const walk = Math.min(1, speed / 7);
  const phase = t * (6 + walk * 5);
  const sw = Math.sin(phase) * 0.7 * walk;
  u.legL.rotation.x = sw;
  u.legR.rotation.x = -sw;
  u.armL.rotation.x = -sw * 0.35 - 0.60;
  u.armL.rotation.z = 0.34;
  u.armR.rotation.x = -0.78;
  u.armR.rotation.z = -0.20;
  u.body.position.y = lerp(u.body.position.y, Math.abs(Math.sin(phase)) * 0.045 * walk, k);
}

export function flashMuzzle(av) {
  const u = av.userData;
  if (!u) return;
  u.muzzle.visible = true;
  u.muzzle.material.opacity = 1;
  u.muzzle.scale.setScalar(1);
  clearTimeout(u._mz);
  u._mz = setTimeout(() => { u.muzzle.visible = false; }, 70);
}

export function setGunTank(av, hex) {
  if (av.userData?.tank) av.userData.tank.color.set(hex);
}

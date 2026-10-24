// ============================================================
//  맵 레이아웃 — 서버와 클라이언트가 "똑같은 지도"를 갖도록
//  순수 함수로만 만든다. (난수 시드 고정 → 항상 동일한 섬)
//
//  구성
//   · 중앙 컨테이너 야드 (엄폐물 미로)
//   · 모둠별 창고 8동 = 리스폰 지점 = ★안전구역★ (계단으로 옥상까지)
//   · 미지의 음료 비커 6개 (A·B·C 두 세트)
//   · 대기 공간 — 바다 위 훈련장 (게임 시작 전 조작 연습)
// ============================================================
import { REAGENT_LIST, RULES, TEAM_COLORS, TEAM_NAMES } from './gamedata.js';

export const MAP = {
  ISLAND_R: 214,      // 섬 반지름 (이 밖은 바다)
  PLAY_R: 198,        // 플레이 가능 반지름
  YARD: 86,           // 중앙 컨테이너 야드 반경(정사각 기준)
  BASE_R: 172,        // 모둠 창고가 놓인 원의 반지름
  SAFE_R: 26,         // 안전구역 반지름 (창고 중심 기준)
};

// 대기 공간 — 바다 위 훈련장. 섬에서 130m 넘게 떨어져 있어 안개 너머로만 보인다.
export const TRAIN = {
  // 섬 바깥 바다 위. 하늘 돔(반지름 700) 안쪽이어야 배경이 검게 나오지 않는다.
  cx: 330, cz: 0,
  floorY: 6,          // 바닥 윗면 높이
  half: 34,           // 정사각형 반변
};

// ---- 고정 시드 난수 (mulberry32) --------------------------------
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 모둠 창고(=안전구역) 위치 : 지형 계산보다 먼저 정해져야 한다 ----
export const BASE_XZ = Array.from({ length: 8 }, (_, t) => {
  const a = (t / 8) * Math.PI * 2 + 0.39;
  return { x: Math.cos(a) * MAP.BASE_R, z: Math.sin(a) * MAP.BASE_R };
});

// ---- 지형 높이 --------------------------------------------------
function rawHeight(x, z) {
  const d = Math.hypot(x, z);
  let h = 0;
  const shore = MAP.ISLAND_R - 22;
  if (d > shore) {
    const t = (d - shore) / (MAP.ISLAND_R - shore + 14);
    h -= t * t * 18;
  }
  h += 3.6 * Math.sin(x * 0.0102 + 1.7) * Math.cos(z * 0.0089 - 0.4);
  h += 1.8 * Math.sin(x * 0.023 - 2.2) * Math.cos(z * 0.020 + 1.1);
  h += 0.7 * Math.sin((x + z) * 0.045 + 0.3);
  return h;
}
// 창고가 기울어진 땅에 서지 않도록 창고 주변은 평평하게 깎는다.
// ★ 바다(y = -2.2)보다 반드시 높게 — 안 그러면 창고 안 바닥에 바닷물이 비쳐 보인다.
export const SEA_Y = -2.2;
const BASE_H = BASE_XZ.map(b => Math.max(rawHeight(b.x, b.z), SEA_Y + 3.4));

export function terrainHeight(x, z) {
  let h = rawHeight(x, z);
  const yard = Math.max(Math.abs(x), Math.abs(z));
  if (yard < MAP.YARD) {
    const k = Math.min(1, Math.max(0, (MAP.YARD - yard) / 20));
    h = h * (1 - k);
  }
  for (let i = 0; i < BASE_XZ.length; i++) {
    const d = Math.hypot(x - BASE_XZ[i].x, z - BASE_XZ[i].z);
    if (d < 34) {
      const k = Math.min(1, Math.max(0, (34 - d) / 10));
      h = h * (1 - k) + BASE_H[i] * k;
    }
  }
  return h;
}

// 박스 하나 만들기 (충돌 + 렌더 공용)  ※ 모두 축 정렬. rot 은 쓰지 않는다.
function box(x, y, z, sx, sy, sz, kind, color) {
  return { x, y, z, sx, sy, sz, rot: 0, kind, color };
}
// (x0..x1, z0..z1) 사각형을 y0~y1 높이의 박스로
function slab(x0, x1, z0, z1, y0, y1, kind, color) {
  return box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
    Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), kind, color);
}

const CONTAINER_COLORS = [
  '#b8432f', '#2f6fb8', '#d9a520', '#3f8c58',
  '#8d8f92', '#a3552b', '#356b8a', '#c0563f',
];

export function buildLayout() {
  const rand = rngFrom(20250824);
  const solids = [];   // 충돌 박스
  const props = [];    // 충돌 없는 장식
  const bases = [];

  // ============================================================
  //  1. 모둠 창고 8동 — 리스폰 지점이자 안전구역
  //     들어갈 수 있고, 계단으로 옥상까지 올라갈 수 있다.
  // ============================================================
  function teamBase(team, cx, cz) {
    const y0 = terrainHeight(cx, cz);
    const W = 30, D = 24, H = 7.6, T = 0.7;   // 가로/세로/벽높이/벽두께
    const DOOR = 8;                            // 출입구 폭
    const col = TEAM_COLORS[team];
    const wallCol = '#8b97a4';

    const x0 = cx - W / 2, x1 = cx + W / 2;
    const z0 = cz - D / 2, z1 = cz + D / 2;

    // 출입구는 섬 중심을 향하게
    const inX = -cx, inZ = -cz;
    const door = Math.abs(inX) > Math.abs(inZ)
      ? (inX > 0 ? '+x' : '-x')
      : (inZ > 0 ? '+z' : '-z');

    // ---- 벽 (출입구 쪽은 가운데를 비운다) ----
    const seg = (side) => {
      const isDoor = (side === door);
      if (side === '-z' || side === '+z') {
        const zc = side === '-z' ? z0 : z1;
        if (!isDoor) { solids.push(slab(x0, x1, zc - T / 2, zc + T / 2, y0, y0 + H, 'wall', wallCol)); return; }
        const L = (W - DOOR) / 2;
        solids.push(slab(x0, x0 + L, zc - T / 2, zc + T / 2, y0, y0 + H, 'wall', wallCol));
        solids.push(slab(x1 - L, x1, zc - T / 2, zc + T / 2, y0, y0 + H, 'wall', wallCol));
      } else {
        const xc = side === '-x' ? x0 : x1;
        if (!isDoor) { solids.push(slab(xc - T / 2, xc + T / 2, z0, z1, y0, y0 + H, 'wall', wallCol)); return; }
        const L = (D - DOOR) / 2;
        solids.push(slab(xc - T / 2, xc + T / 2, z0, z0 + L, y0, y0 + H, 'wall', wallCol));
        solids.push(slab(xc - T / 2, xc + T / 2, z1 - L, z1, y0, y0 + H, 'wall', wallCol));
      }
    };
    ['-z', '+z', '-x', '+x'].forEach(seg);

    // ---- 계단 : 출입구 '반대편' 벽에 붙여서 옥상까지 ----
    const opposite = { '+z': '-z', '-z': '+z', '+x': '-x', '-x': '+x' }[door];
    const STEPS = 15, stepH = H / STEPS, SD = 3.4;   // 한 칸 약 0.5m — 걸어서 올라갈 수 있는 높이   // SD = 계단 폭(벽에서 안쪽으로)
    let hole;                                        // 옥상 뚫린 구멍
    const stepCol = '#6f7b88';

    // 머리가 옥상 슬래브에 부딪히기 시작하는 계단 번호 — 그 위부터는 지붕을 뚫는다
    const HEAD_ROOM = 2.15;                          // 서 있는 키(1.85) + 여유
    let iCut = STEPS - 1;
    for (let i = 0; i < STEPS; i++) {
      if ((i + 1) * stepH + HEAD_ROOM > H) { iCut = i; break; }
    }
    iCut = Math.max(1, iCut);

    if (opposite === '-z' || opposite === '+z') {
      // 계단이 x 축을 따라 올라간다
      const zA = opposite === '-z' ? z0 + T : z1 - T - SD;
      const zB = zA + SD;
      const run = (W - 3) / STEPS;
      for (let i = 0; i < STEPS; i++) {
        const sx0 = x0 + 1.5 + run * i;
        solids.push(slab(sx0, sx0 + run, zA, zB, y0, y0 + (i + 1) * stepH, 'stair', stepCol));
      }
      hole = { x0: x0 + 1.5 + run * iCut, x1: x1 - 1.4, z0: zA, z1: zB };
    } else {
      // 계단이 z 축을 따라 올라간다
      const xA = opposite === '-x' ? x0 + T : x1 - T - SD;
      const xB = xA + SD;
      const run = (D - 3) / STEPS;
      for (let i = 0; i < STEPS; i++) {
        const sz0 = z0 + 1.5 + run * i;
        solids.push(slab(xA, xB, sz0, sz0 + run, y0, y0 + (i + 1) * stepH, 'stair', stepCol));
      }
      hole = { x0: xA, x1: xB, z0: z0 + 1.5 + run * iCut, z1: z1 - 1.4 };
    }

    // ---- 옥상 (걸어 다닐 수 있다) : 구멍만 남기고 슬래브로 덮는다 ----
    const RY0 = y0 + H, RY1 = y0 + H + 0.5;
    const roofCol = '#5d6874';
    if (hole.z0 > z0) solids.push(slab(x0, x1, z0, hole.z0, RY0, RY1, 'roof', roofCol));
    if (hole.z1 < z1) solids.push(slab(x0, x1, hole.z1, z1, RY0, RY1, 'roof', roofCol));
    if (hole.x0 > x0) solids.push(slab(x0, hole.x0, hole.z0, hole.z1, RY0, RY1, 'roof', roofCol));
    if (hole.x1 < x1) solids.push(slab(hole.x1, x1, hole.z0, hole.z1, RY0, RY1, 'roof', roofCol));

    // ---- 옥상 난간 (모둠 색) ----
    const RH = 1.15, RT = 0.4;
    solids.push(slab(x0 - RT, x1 + RT, z0 - RT, z0, RY1, RY1 + RH, 'rail', col));
    solids.push(slab(x0 - RT, x1 + RT, z1, z1 + RT, RY1, RY1 + RH, 'rail', col));
    solids.push(slab(x0 - RT, x0, z0, z1, RY1, RY1 + RH, 'rail', col));
    solids.push(slab(x1, x1 + RT, z0, z1, RY1, RY1 + RH, 'rail', col));

    // ---- 외벽 모둠 색 띠 (멀리서도 우리 창고를 찾을 수 있게) ----
    const bandY = y0 + H * 0.8;
    props.push(slab(x0 - 0.3, x1 + 0.3, z0 - 0.35, z0 - 0.05, bandY, bandY + 0.9, 'band', col));
    props.push(slab(x0 - 0.3, x1 + 0.3, z1 + 0.05, z1 + 0.35, bandY, bandY + 0.9, 'band', col));
    props.push(slab(x0 - 0.35, x0 - 0.05, z0, z1, bandY, bandY + 0.9, 'band', col));
    props.push(slab(x1 + 0.05, x1 + 0.35, z0, z1, bandY, bandY + 0.9, 'band', col));

    // ---- 내부 실험대(엄폐물) 2개 ----
    solids.push(slab(cx - 5.5, cx - 1.5, cz - 1.6, cz + 1.6, y0, y0 + 1.1, 'crate', '#9a7b4f'));
    solids.push(slab(cx + 1.5, cx + 5.5, cz - 1.6, cz + 1.6, y0, y0 + 1.1, 'crate', '#9a7b4f'));

    bases.push({
      team, x: cx, z: cz, y: y0, r: MAP.SAFE_R,
      color: col, name: TEAM_NAMES[team] || `${team + 1}모둠`,
      door, W, D, H,
    });
  }
  BASE_XZ.forEach((b, t) => teamBase(t, b.x, b.z));

  // ============================================================
  //  2. 중앙 컨테이너 야드
  // ============================================================
  const CW = 12.2, CH = 2.9, CD = 5.2;
  for (let bx = -4; bx <= 4; bx++) {
    for (let bz = -4; bz <= 4; bz++) {
      const ox = bx * 18.5 + 9.25;
      const oz = bz * 17.0 + 8.5;
      if (Math.hypot(ox, oz) < 14) continue;
      if (Math.max(Math.abs(ox), Math.abs(oz)) > MAP.YARD - 8) continue;
      const stack = 1 + Math.floor(rand() * 3);
      const rotated = rand() < 0.25;
      const jx = (rand() - 0.5) * 2.4, jz = (rand() - 0.5) * 2.4;
      for (let s = 0; s < stack; s++) {
        const off = s > 0 ? (rand() - 0.5) * 1.6 : 0;
        const c = CONTAINER_COLORS[Math.floor(rand() * CONTAINER_COLORS.length)];
        const px = ox + jx + (rotated ? 0 : off);
        const pz = oz + jz + (rotated ? off : 0);
        const y = terrainHeight(px, pz) + CH / 2 + s * CH;
        solids.push(box(px, y, pz, rotated ? CD : CW, CH, rotated ? CW : CD, 'container', c));
      }
    }
  }

  // ============================================================
  //  3. 작은 건물 / 바위 / 나무
  // ============================================================
  const farFromBase = (x, z, m) => BASE_XZ.every(b => Math.hypot(b.x - x, b.z - z) > m);

  const HUTS = [
    [-132, 22], [-52, 128], [56, 130], [140, -10],
    [36, -130], [-58, -128], [-150, -14], [128, 106],
    [-90, -110], [92, -108], [-30, 152], [24, -156],
  ];
  for (const [cx, cz] of HUTS) {
    if (!farFromBase(cx, cz, 46)) continue;
    const y0 = terrainHeight(cx, cz);
    const w = 9 + rand() * 6, d = 8 + rand() * 6, h = 4.6, t = 0.6;
    solids.push(box(cx, y0 + h / 2, cz - d / 2, w, h, t, 'wall', '#a89c8a'));
    solids.push(box(cx, y0 + h / 2, cz + d / 2, w, h, t, 'wall', '#a89c8a'));
    solids.push(box(cx - w / 2, y0 + h / 2, cz, t, h, d, 'wall', '#a89c8a'));
    solids.push(box(cx + w / 2, y0 + h / 2, cz - d / 4, t, h, d / 2, 'wall', '#a89c8a'));
    props.push(box(cx, y0 + h + 0.4, cz, w + 1.2, 0.8, d + 1.2, 'roof', '#8a4b3a'));
  }

  for (let i = 0; i < 170; i++) {
    const a = rand() * Math.PI * 2;
    const r = 28 + rand() * (MAP.PLAY_R - 34);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.max(Math.abs(x), Math.abs(z)) < MAP.YARD) continue;
    if (!farFromBase(x, z, 40)) continue;
    const y0 = terrainHeight(x, z);
    if (rand() < 0.45) {
      const s = 1.6 + rand() * 2.8;
      solids.push(box(x, y0 + s * 0.4, z, s * 1.6, s * 0.9, s * 1.5, 'rock', '#787f86'));
    } else {
      const th = 6 + rand() * 5;
      solids.push(box(x, y0 + th / 2, z, 1.0, th, 1.0, 'trunk', '#6b4d33'));
      props.push(box(x, y0 + th + 1.8, z, 6 + rand() * 3, 4.6, 6 + rand() * 3, 'leaves', '#3f7a45'));
    }
  }

  // ============================================================
  //  4. 미지의 음료 비커 6개 (A·B·C 두 세트)
  // ============================================================
  const BEAKER_SPOTS = [
    { x: 0,    z: 0,    drink: 0, zone: 1 },
    { x: -112, z: -36,  drink: 1, zone: 1 },
    { x: 110,  z: 38,   drink: 2, zone: 1 },
    { x: -96,  z: 96,   drink: 0, zone: 2 },
    { x: 104,  z: -94,  drink: 1, zone: 2 },
    { x: 4,    z: 132,  drink: 2, zone: 2 },
  ];
  const beakers = BEAKER_SPOTS.map((s, i) => ({
    index: i, drink: s.drink, label: 'ABC'[s.drink], zone: s.zone,
    x: s.x, z: s.z, y: terrainHeight(s.x, s.z),
  }));

  // 비커 주변 12m 안의 구조물은 치워서 사격선을 확보
  for (let i = solids.length - 1; i >= 0; i--) {
    for (const b of beakers) {
      if (Math.hypot(solids[i].x - b.x, solids[i].z - b.z) < 12) { solids.splice(i, 1); break; }
    }
  }
  for (let i = props.length - 1; i >= 0; i--) {
    for (const b of beakers) {
      if (Math.hypot(props[i].x - b.x, props[i].z - b.z) < 12) { props.splice(i, 1); break; }
    }
  }

  // ============================================================
  //  4-b. ★ 가열대(불꽃) — 베네딕트 반응에 필요한 '불'
  //      비커마다 가까운 곳에 2개씩 두고, 야드에도 몇 개 흩어 놓는다.
  //      충돌은 없다(불 위로 그냥 지나갈 수 있음). 다가가면 몸에 불이 붙는다.
  // ============================================================
  const fires = [];
  const addFire = (x, z) => {
    if (Math.hypot(x, z) > MAP.PLAY_R - 6) return;
    if (!farFromBase(x, z, MAP.SAFE_R + 6)) return;          // 안전구역 안에는 두지 않는다
    for (const f of fires) if (Math.hypot(f.x - x, f.z - z) < 14) return;
    fires.push({ id: fires.length, x, z, y: terrainHeight(x, z) });
  };
  // 비커 둘레에 2개씩 (거리 19m — 불을 쬐고 뛰어와서 쏘는 동선)
  beakers.forEach((b, i) => {
    const base = i * 1.1 + 0.6;
    for (const off of [0, Math.PI]) {
      const a = base + off;
      addFire(b.x + Math.cos(a) * 19, b.z + Math.sin(a) * 19);
    }
  });
  // 컨테이너 야드와 벌판에 흩어진 불
  [[46, 46], [-46, 44], [44, -48], [-48, -44], [0, 74], [-74, 0], [74, 4], [0, -76],
   [128, 118], [-126, 120], [126, -120], [-124, -122]].forEach(([x, z]) => addFire(x, z));

  // 불 자리에 겹친 구조물은 치운다 (불이 상자 속에 박히지 않도록)
  for (let i = solids.length - 1; i >= 0; i--) {
    for (const f of fires) {
      if (Math.hypot(solids[i].x - f.x, solids[i].z - f.z) < 5) { solids.splice(i, 1); break; }
    }
  }

  // ============================================================
  //  5. 시약 스폰 지점
  // ============================================================
  const pickups = [];
  const spots = [];
  for (let i = 0; i < 300; i++) {
    const a = (i / 300) * Math.PI * 2 * 7 + rand() * 0.5;
    const r = 16 + rand() * (MAP.PLAY_R - 26);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let bad = false;
    for (const s of spots) if (Math.hypot(s.x - x, s.z - z) < 15) { bad = true; break; }
    if (!bad) for (const b of beakers) if (Math.hypot(b.x - x, b.z - z) < 15) { bad = true; break; }
    // 안전구역 안에는 시약을 두지 않는다 (거기 앉아서 모으면 안 되니까)
    if (!bad && !farFromBase(x, z, MAP.SAFE_R + 8)) bad = true;
    if (bad) continue;
    spots.push({ x, z });
  }
  spots.forEach((s, i) => {
    pickups.push({
      id: i, reagent: REAGENT_LIST[i % REAGENT_LIST.length],
      x: s.x, z: s.z, y: terrainHeight(s.x, s.z),
    });
  });

  // ============================================================
  //  6. 대기 공간 (바다 위 훈련장)
  // ============================================================
  const T = TRAIN, FY = T.floorY, H2 = T.half;
  const tx0 = T.cx - H2, tx1 = T.cx + H2, tz0 = T.cz - H2, tz1 = T.cz + H2;
  const training = { ...T, x0: tx0, x1: tx1, z0: tz0, z1: tz1, targets: [] };

  solids.push(slab(tx0, tx1, tz0, tz1, FY - 1.6, FY, 'trainFloor', '#93a0ab'));
  // 난간
  const RW = 1.4;
  solids.push(slab(tx0 - 0.6, tx1 + 0.6, tz0 - 0.6, tz0, FY, FY + RW, 'trainRail', '#7b8794'));
  solids.push(slab(tx0 - 0.6, tx1 + 0.6, tz1, tz1 + 0.6, FY, FY + RW, 'trainRail', '#7b8794'));
  solids.push(slab(tx0 - 0.6, tx0, tz0, tz1, FY, FY + RW, 'trainRail', '#7b8794'));
  solids.push(slab(tx1, tx1 + 0.6, tz0, tz1, FY, FY + RW, 'trainRail', '#7b8794'));

  // 점프 연습용 계단식 상자 (0.8 / 1.7 / 2.6 / 3.0m)
  [[-20, -14, 0.8], [-13, -14, 1.7], [-6, -14, 2.6], [2, -14, 3.0]].forEach(([ox, oz, h], i) => {
    solids.push(slab(T.cx + ox - 2.5, T.cx + ox + 2.5, T.cz + oz - 2.5, T.cz + oz + 2.5,
      FY, FY + h, 'trainBox', ['#b8563c', '#d9a520', '#3f8c58', '#3f6fa8'][i]));
  });
  // 앉아서 지나가는 낮은 통로
  solids.push(slab(T.cx + 10, T.cx + 22, T.cz - 16, T.cz - 15, FY, FY + 3.2, 'trainBox', '#8d8f92'));
  solids.push(slab(T.cx + 10, T.cx + 22, T.cz - 12, T.cz - 11, FY, FY + 3.2, 'trainBox', '#8d8f92'));
  solids.push(slab(T.cx + 10, T.cx + 22, T.cz - 15, T.cz - 12, FY + 1.35, FY + 3.2, 'trainBox', '#8d8f92'));

  // 사격 연습용 과녁 3개
  [[-16, 20], [0, 24], [16, 20]].forEach(([ox, oz]) => {
    const x = T.cx + ox, z = T.cz + oz;
    solids.push(slab(x - 2.2, x + 2.2, z - 0.4, z + 0.4, FY, FY + 5.2, 'target', '#e6e1d4'));
    training.targets.push({ x, y: FY + 3.2, z });
  });

  return { solids, props, beakers, fires, pickups, bases, training };
}

// 서버/클라 공용 싱글턴
export const LAYOUT = buildLayout();

// 모둠 창고 안에서 리스폰 — 같은 모둠은 같은 창고에서 함께 출발한다
export function spawnPointFor(teamIndex, slot) {
  const b = LAYOUT.bases[teamIndex % LAYOUT.bases.length];
  const a = (slot % RULES.TEAM_SIZE) * (Math.PI * 2 / RULES.TEAM_SIZE) + 0.7;
  const x = b.x + Math.cos(a) * 6.5;
  const z = b.z + Math.sin(a) * 6.5;
  return { x, y: b.y, z, yaw: Math.atan2(-b.x, -b.z) };   // 섬 중심을 바라보게
}

// 대기 공간 스폰
export function trainingSpawn(slot) {
  const a = (slot % 16) * (Math.PI * 2 / 16);
  const r = 8 + (slot % 3) * 4;
  return {
    x: TRAIN.cx + Math.cos(a) * r,
    y: TRAIN.floorY,
    z: TRAIN.cz + Math.sin(a) * r,
    yaw: Math.atan2(-Math.cos(a), -Math.sin(a)),
  };
}

// 어느 모둠 안전구역 안인가? (아무 모둠 창고든 정답 제출은 가능)
export function safeZoneAt(x, z) {
  for (const b of LAYOUT.bases) {
    if (Math.hypot(b.x - x, b.z - z) <= b.r) return b;
  }
  return null;
}

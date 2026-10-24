// ============================================================
//  battledata.js — ★ 슈팅 모드(남는 시간용) 설정
//
//  실험(영양소 검출) 모드와 완전히 분리된 규칙입니다.
//  수업 내용과는 상관없이 "남는 시간에 재밌게" 노는 용도라서,
//  선생님 화면에서 [슈팅 모드]를 눌렀을 때만 켜집니다.
//
//  선생님이 고치실 만한 값은 전부 이 파일 하나에 있습니다.
// ============================================================

export const BATTLE = {
  SECONDS: 300,             // 한 판 길이 (5분)
  START_COUNTDOWN: 5,       // 시작 카운트다운
  SQUAD_MAX: 3,             // 한 분대 최대 인원 (혼자 해도 됨)
  SQUAD_SLOTS: 32,          // 분대 칸 개수 (전원이 혼자 해도 자리가 있도록)

  MAX_HP: 100,
  RESPAWN_SECONDS: 10,      // 쓰러지면 10초 뒤 자동 부활

  HEAL: 45,                 // 구급품 1개 회복량
  MED_MAX: 3,               // 구급품 최대 보유
  MED_USE_MS: 1200,         // 사용에 걸리는 시간
  MED_COOLDOWN_MS: 2500,

  AMMO_MAX: 240,
  AMMO_PER_BOX: 50,
  START_AMMO: 80,           // 부활할 때 최소 보장 탄약 (빈손으로 부활하지 않게)
  BAG_SIZE: 4,              // 가방(장비창)에 넣어 둘 수 있는 총 개수

  LOOT_RESPAWN_SECONDS: 22, // 주운 자리가 다시 채워지는 시간
  LOOT_RADIUS: 3.0,         // 이 거리 안에 들어가면 자동 획득

  // 사람 이름표/피격 판정
  HIT_RANGE_SLACK: 12,      // 서버가 인정해 주는 여유 거리(지연 보정)

  // 킬 점수 (교사 화면 순위표용)
  SCORE_KILL: 10,
  SCORE_ASSIST: 0,

  // ★ 자기장 — at 초에 시작해서 dur 초 동안 반지름 to 까지 줄어든다
  //   밖에 있으면 1초에 dps 만큼 체력이 깎인다.
  ZONE: [
    { at: 45, dur: 35, to: 130, dps: 2 },
    { at: 120, dur: 30, to: 80, dps: 4 },
    { at: 185, dur: 25, to: 45, dps: 6 },
    { at: 240, dur: 25, to: 18, dps: 9 },
  ],
  ZONE_DPS_BEFORE: 1,       // 첫 축소 전에도 섬 밖으로 나가면 조금씩 깎임
};

// ------------------------------------------------------------
//  총기 — tier 가 높을수록 좋은 총.
//  ★ 땅에 있는 총은 '지금 든 총보다 tier 가 높을 때만' 자동으로 바뀝니다.
//    (달리다가 저격총이 권총으로 바뀌는 사고를 막기 위해서)
// ------------------------------------------------------------
//  recoil : 한 발 쏠 때 화면이 위로 튀는 양(라디안). 0.9rad/s 로 저절로 되돌아온다.
//           ★ 수업 피드백으로 전체적으로 낮췄고, 기관단총은 특히 많이 낮췄다.
//  zoom   : 두 손가락 확대(또는 마우스 휠)로 당길 수 있는 최대 배율.
export const GUNS = {
  pistol: {
    id: 'pistol', name: '권총', short: '권총', tier: 1,
    dmg: 24, cd: 330, mag: 12, reload: 1200, range: 60,
    spread: 0.010, color: '#cfd6de', auto: false,
    recoil: 0.011, zoom: 1.8,
  },
  smg: {
    id: 'smg', name: '기관단총', short: 'SMG', tier: 2,
    dmg: 15, cd: 105, mag: 30, reload: 1500, range: 48,
    spread: 0.020, color: '#8fd7ff', auto: true,
    recoil: 0.0035, zoom: 1.8,        // ★ 연사라 아주 작게 (예전 0.022 → 0.0035)
  },
  shotgun: {
    id: 'shotgun', name: '샷건', short: '샷건', tier: 3,
    dmg: 68, cd: 800, mag: 5, reload: 2000, range: 20,
    spread: 0.05, color: '#ffb35c', auto: false,
    recoil: 0.020, zoom: 1.5,
  },
  ar: {
    id: 'ar', name: '돌격소총', short: '소총', tier: 3,
    dmg: 26, cd: 150, mag: 30, reload: 1900, range: 88,
    spread: 0.014, color: '#7ee2a8', auto: true,
    recoil: 0.006, zoom: 2.4,
  },
  sniper: {
    id: 'sniper', name: '저격총', short: '저격', tier: 4,
    dmg: 92, cd: 1300, mag: 5, reload: 2400, range: 160,
    spread: 0.002, color: '#ff8fb0', auto: false,
    recoil: 0.028, zoom: 6,           // ★ 저격 스코프 — 6배까지 당겨 볼 수 있다
    scope: true,
  },
};

// 반동이 저절로 돌아오는 속도 (라디안/초). 클수록 빨리 제자리로 온다.
export const RECOIL_RECOVER = 0.55;
export const GUN_LIST = Object.keys(GUNS);

// 땅에 떨어지는 총의 비율 (좋은 총일수록 드물게)
export const GUN_DROP = [
  'pistol', 'pistol', 'pistol',
  'smg', 'smg', 'smg',
  'ar', 'ar',
  'shotgun', 'shotgun',
  'sniper',
];

// 보급 상자 종류 비율 — 총 40% · 탄약 40% · 구급품 20%
export const LOOT_KINDS = [
  'gun', 'gun', 'gun', 'gun',
  'ammo', 'ammo', 'ammo', 'ammo',
  'med', 'med',
];

export const LOOT_STYLE = {
  gun: { name: '총기 상자', color: '#ffd76a', icon: '🔫' },
  ammo: { name: '탄약 상자', color: '#9fd0ff', icon: '📦' },
  med: { name: '구급품', color: '#ff8a8a', icon: '🧰' },
};

// 분대 색 — 모자 색으로 아군/적을 구분한다 (이름표는 초록/빨강)
export const SQUAD_COLORS = [
  '#e5484d', '#3e7bfa', '#3fbf63', '#f5c518', '#a763f0', '#25c2c2',
  '#ff7ab6', '#9aa7b4', '#ff8c2e', '#5ad1ff', '#b0e04a', '#d17bff',
  '#00b8a3', '#ff5c8a', '#7a8cff', '#c9a227',
];
export const SQUAD_COLOR_NAMES = [
  '빨강', '파랑', '초록', '노랑', '보라', '민트',
  '분홍', '회색', '주황', '하늘', '연두', '자주',
  '청록', '진분홍', '남색', '금색',
];

// ------------------------------------------------------------
//  자기장 계산 — 서버와 클라이언트가 똑같은 결과를 내야 한다
//  elapsed(초)에서의 반지름 / 지금 몇 단계인지 / 데미지
// ------------------------------------------------------------
export function zoneAt(elapsed, startR) {
  let r = startR, from = startR, dps = BATTLE.ZONE_DPS_BEFORE, stage = 0, shrinking = false;
  let nextAt = null, nextTo = null;
  for (let i = 0; i < BATTLE.ZONE.length; i++) {
    const z = BATTLE.ZONE[i];
    if (elapsed < z.at) { nextAt = z.at; nextTo = z.to; break; }
    stage = i + 1;
    if (elapsed < z.at + z.dur) {
      const k = (elapsed - z.at) / z.dur;
      r = from + (z.to - from) * k;
      dps = z.dps;
      shrinking = true;
      nextAt = z.at + z.dur; nextTo = z.to;
      break;
    }
    r = z.to; from = z.to; dps = z.dps;
    nextAt = null; nextTo = null;
  }
  return { r, dps, stage, shrinking, nextAt, nextTo };
}

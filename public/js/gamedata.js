// ============================================================
//  Project_Godeok — 과학 데이터 정의
//  ※ 선생님이 직접 고치는 곳은 여기 한 파일뿐입니다.
//     (음료 구성 · 시약 색 · 점수 · 마취 규칙)
// ============================================================

// ---- 영양소 4종 ------------------------------------------------
export const NUTRIENTS = {
  starch:  { name: '녹말',   short: '녹말' },
  sugar:   { name: '당류',   short: '당류' },
  protein: { name: '단백질', short: '단백질' },
  fat:     { name: '지방',   short: '지방' },
};

// ---- 시약(= 탄알) 4종 ------------------------------------------
// color   : 탄알/UI 색
// reactTo : 이 시약이 검출하는 영양소
// posColor: 양성 반응이 났을 때 비커가 변하는 색
export const REAGENTS = {
  iodine: {
    id: 'iodine',
    name: '아이오딘 - 아이오딘화 칼륨 용액',
    shortName: '아이오딘',
    reactTo: 'starch',
    color: '#c9a227',
    posColor: '#1f2a86',      // 청람색
    posText: '청람색',
    negText: '변화 없음',
  },
  benedict: {
    id: 'benedict',
    name: '베네딕트 용액',
    shortName: '베네딕트',
    reactTo: 'sugar',
    color: '#4aa3df',
    posColor: '#d2451e',      // 황적색
    posText: '황적색',
    negText: '변화 없음(푸른색 그대로)',
    // ★ 베네딕트 반응은 '가열'이 있어야 일어난다.
    //   게임에서는 필드의 불꽃에 다가가 몸을 데운 상태에서 쏴야 반응합니다.
    //   (이 줄을 지우면 가열 없이도 반응하게 됩니다)
    needsHeat: true,
  },
  biuret: {
    id: 'biuret',
    name: '뷰렛 용액',
    shortName: '뷰렛',
    reactTo: 'protein',
    color: '#67c2a0',
    posColor: '#8e3fb0',      // 보라색
    posText: '보라색',
    negText: '변화 없음',
  },
  sudan: {
    id: 'sudan',
    name: '수단 Ⅲ 용액',
    shortName: '수단 Ⅲ',
    reactTo: 'fat',
    color: '#e07b39',
    posColor: '#e0245e',      // 선홍색
    posText: '선홍색',
    negText: '변화 없음',
  },
};
export const REAGENT_LIST = Object.keys(REAGENTS);

// ---- 음료·용액 24종 ---------------------------------------------
// has : 게임 안에서 '검출된다'고 판정할 영양소 목록
//
// ★ 왜 이렇게 많은가
//   한 시간에 3라운드를 돌면 음료가 겹쳐서 아이들이 답을 외워 버립니다.
//   그래서 종류를 크게 늘리고, **라운드마다 후보 8종을 새로 뽑습니다.**
//   같은 검출 패턴(예: 단백질+지방)을 가진 음료를 여러 개 넣어 두었기 때문에
//   "지난 판에 단백질+지방은 우유였으니까 이번에도 우유" 가 통하지 않습니다.
//   (그 패턴이 이번 판에는 두유·달걀 노른자·두부물일 수 있습니다)
//
// ※ 실제 실험과의 차이 (README 참고):
//   - 커피믹스의 단맛은 자당(설탕)이라 실제 베네딕트 반응은 음성일 수 있습니다.
//   - 우유는 교과서대로 '단백질 + 지방'으로 두었습니다(실제 유당은 환원당).
//   - 설탕물은 자당=비환원당이라 판정이 애매해서 일부러 넣지 않았습니다.
//     대신 꿀물(과당·포도당 = 환원당)을 넣었습니다.
export const DRINKS = [
  // ── 지방만
  { id: 'oil',      name: '식용유',          has: ['fat'],                liquid: '#f2e08a' },
  { id: 'sesame',   name: '참기름',          has: ['fat'],                liquid: '#d9a441' },
  { id: 'olive',    name: '올리브유',        has: ['fat'],                liquid: '#c9d17a' },
  // ── 4가지 모두 음성
  { id: 'water',    name: '물',              has: [],                     liquid: '#cfe9f5' },
  { id: 'zero',     name: '제로 사이다',      has: [],                     liquid: '#dff3ff' },
  { id: 'barley',   name: '보리차',          has: [],                     liquid: '#c8a06a' },
  { id: 'sparkle',  name: '탄산수',          has: [],                     liquid: '#e2f4ff' },
  // ── 단백질만
  { id: 'egg',      name: '난백(달걀 흰자)',  has: ['protein'],            liquid: '#f3f0e2' },
  // ── 단백질 + 지방
  { id: 'milk',     name: '우유',            has: ['protein', 'fat'],     liquid: '#fbfbf6' },
  { id: 'soymilk',  name: '두유',            has: ['protein', 'fat'],     liquid: '#f5efdc' },
  { id: 'yolk',     name: '달걀 노른자',      has: ['protein', 'fat'],     liquid: '#f5c33b' },
  { id: 'cream',    name: '생크림',          has: ['protein', 'fat'],     liquid: '#fdfbf2' },
  { id: 'tofu',     name: '두부 간 물',       has: ['protein', 'fat'],     liquid: '#f7f5ea' },
  // ── 녹말만
  { id: 'ricewash', name: '쌀뜨물',          has: ['starch'],             liquid: '#eef0e6' },
  { id: 'starch',   name: '녹말물',          has: ['starch'],             liquid: '#f0f2f0' },
  { id: 'potato',   name: '감자 간 물',       has: ['starch'],             liquid: '#ece7cf' },
  // ── 당류만
  { id: 'juice',    name: '오렌지 주스',      has: ['sugar'],              liquid: '#f2a03d' },
  { id: 'cider',    name: '사이다',          has: ['sugar'],              liquid: '#e8f6ff' },
  { id: 'sports',   name: '이온음료',        has: ['sugar'],              liquid: '#bfe7ff' },
  { id: 'honey',    name: '꿀물',            has: ['sugar'],              liquid: '#e6b83c' },
  // ── 녹말 + 당류
  { id: 'sikhye',   name: '식혜',            has: ['starch', 'sugar'],    liquid: '#e8c98f' },
  // ── 녹말 + 단백질
  { id: 'misu',     name: '미숫가루 물',      has: ['starch', 'protein'],  liquid: '#d8bb92' },
  // ── 당류 + 지방
  { id: 'coffee',   name: '커피믹스',        has: ['sugar', 'fat'],       liquid: '#8b6242' },
  // ── 당류 + 단백질
  { id: 'yogurt',   name: '마시는 요구르트',  has: ['sugar', 'protein'],   liquid: '#fdf4e3' },
];

// 검출 결과(4가지 시약의 ＋/－ 조합)가 같으면 게임으로는 구별할 수 없다.
export function signature(drink) {
  return REAGENT_LIST.map(r => (drink.has.includes(REAGENTS[r].reactTo) ? '1' : '0')).join('');
}

// 검출 패턴별로 묶어 둔다 (한 라운드 후보에는 패턴당 딱 하나만 넣기 위해)
export function drinksBySignature() {
  const g = new Map();
  for (const d of DRINKS) {
    const s = signature(d);
    if (!g.has(s)) g.set(s, []);
    g.get(s).push(d);
  }
  return g;
}

// ============================================================
//  라운드 후보 뽑기
//
//  ★ 핵심 규칙 : 한 라운드의 후보 안에는 **검출 패턴이 같은 음료가 둘 이상 들어가면 안 된다.**
//    (우유와 두유가 같이 후보에 있으면 시약만으로는 절대 구분할 수 없으니까)
//    그래서 패턴을 먼저 고르고, 각 패턴에서 음료를 하나씩 뽑는다.
//
//  avoid : 최근 라운드에 이미 나온 음료 id — 되도록 피한다.
// ============================================================
export function pickRoundDrinks(rand = Math.random, avoid = [], nCandidates = 8) {
  const avoidSet = new Set(avoid);
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const groups = shuffle([...drinksBySignature().values()]);
  // 아직 안 쓴 음료가 있는 패턴을 앞쪽으로
  groups.sort((a, b) => {
    const fa = a.some(d => !avoidSet.has(d.id)) ? 0 : 1;
    const fb = b.some(d => !avoidSet.has(d.id)) ? 0 : 1;
    return fa - fb;
  });

  const candidates = [];
  for (const g of groups) {
    if (candidates.length >= nCandidates) break;
    const fresh = shuffle(g.filter(d => !avoidSet.has(d.id)));
    const any = shuffle(g);
    candidates.push(fresh[0] || any[0]);       // 패턴당 딱 하나
  }

  // 후보 중 3개를 정답으로 — 아직 안 쓴 것 우선
  const pool = shuffle(candidates);
  pool.sort((a, b) => (avoidSet.has(a.id) ? 1 : 0) - (avoidSet.has(b.id) ? 1 : 0));
  const drinks = pool.slice(0, 3);

  return { drinks, candidates: shuffle(candidates) };
}

// ---- 게임 규칙 --------------------------------------------------
export const RULES = {
  TEAM_SIZE: 4,               // 4명 1팀
  ROUND_SECONDS: 15 * 60,     // 한 라운드 15분

  // ============================================================
  //  ★★ 마취총 = '개념을 아는 학생만 쓰는 무기' ★★
  //
  //  수업에서 가장 걱정되는 장면은
  //  "지시약을 못 외운 아이가 마취총만 들고 뛰어다니는 것" 입니다.
  //  그래서 마취총에는 세 겹의 장치를 걸어 두었습니다.
  //
  //   ① 자격시험  : 시약↔영양소 4문제를 다 맞혀야 마취총이 해금됩니다.
  //                 (틀리면 어디가 틀렸는지 안 알려주고 20초 뒤 재응시)
  //   ② 진도 상한 : 우리 모둠이 맞힌 비커 수에 따라 최대 보유량이 늘어납니다.
  //                 0개 8발 → 1개 14발 → 2개 22발 → 3개 30발
  //   ③ 남용 압수 : 비커 검사 없이 6발을 쏘면 45초간 총을 빼앗깁니다.
  //
  //  결과적으로 "외우고 → 실험하고 → 맞히는" 학생이 화력도 세집니다.
  // ============================================================
  TRANQ_HITS_TO_DOWN: 3,      // 3발 맞으면 마취
  TRANQ_DOWN_SECONDS: 30,     // 30초간 마취 (수업에서 60초는 너무 길었습니다)
  TRANQ_DECAY_SECONDS: 25,    // 25초 동안 안 맞으면 누적 1 감소

  TRANQ_REQUIRE_QUIZ: true,   // ① 자격시험을 통과해야 마취총 사용 가능
  QUIZ_RETRY_SECONDS: 20,     //    불합격 시 재응시 대기

  TRANQ_START_AMMO: 8,        // 자격시험 통과 시 지급
  TRANQ_CAP_BY_SOLVED: [8, 14, 22, 30],   // ② 모둠이 맞힌 비커 수별 보유 상한
  TRANQ_MAX_AMMO: 30,         // 절대 상한
  TRANQ_REGEN_SECONDS: 30,    // 30초마다 1발 (완전히 떨어진 학생 구제용, 8발까지만)
  TRANQ_REWARD_NEW_TEST: 3,   // 비커 × 시약 조합을 '처음' 검사하면 +3발
  TRANQ_REWARD_RETEST: 0,     // 같은 조합 재검사는 보상 없음 (대충 난사 방지)

  TRANQ_ABUSE_LIMIT: 6,       // ③ 비커 검사 없이 6발 쏘면
  TRANQ_ABUSE_LOCK_SECONDS: 45, //   45초 압수
  TRANQ_ABUSE_WARN_AT: 4,     //   4발째부터 경고

  // 시약 탄알
  REAGENT_AMMO_PER_PICKUP: 6,
  REAGENT_MAX_CARRY: 24,      // 종류별 최대 보유 — 상자 앞에 눌러앉아도 이 이상은 안 늘어남
  PICKUP_RESPAWN_SECONDS: 12,
  PICKUP_RADIUS: 3.6,         // 빨리 뛰어도 놓치지 않게 넉넉히

  // 사격
  FIRE_COOLDOWN_MS: 260,
  MAX_RANGE: 200,
  TRANQ_DAMAGE_RANGE: 130,

  // 이동 (클라이언트 값, 서버는 이 값으로 치트 검사)
  WALK_SPEED: 6.6,
  RUN_SPEED: 12.0,
  CROUCH_SPEED_MULT: 0.26,    // 앉으면 아주 느리게 (엄폐 이동용)
  JUMP_V: 12.0,               // 점프 최고 높이 ≈ 3.0m — 컨테이너 한 단 위로 올라갈 수 있음
  GRAVITY: 24,
  MAX_STEP_PER_MSG: 18,       // 서버 위치 검증: 한 번에 이보다 멀리 못 감

  // 점수
  SCORE_TEST: 5,              // 비커에 시약 한 종류 처음 명중
  SCORE_ALL_REAGENTS: 20,     // 시약 4종 모두 수집
  SCORE_CORRECT: 100,         // 음료 정답
  SCORE_WRONG: -20,
  SCORE_TRANQ: 10,            // 상대 마취시킴
  // ★ 오답 대기 — 수업에서 "채점이 너무 오래 걸린다"는 불만의 진짜 원인이었습니다.
  //   (채점 자체는 0.2초. 30초 동안 모둠 전체가 다시 못 내는 게 길게 느껴진 것)
  //   그래서 '처음 틀린 것'은 거의 벌이 없고, 계속 찍으면 점점 길어지게 바꿨습니다.
  //   → 실수는 봐주고, 8개를 순서대로 찍어보는 것만 막습니다.
  WRONG_COOLDOWN_STEPS: [4, 8, 15, 25],   // 연속 오답 1·2·3·4회째 대기 시간(초)
  WRONG_ANSWER_COOLDOWN: 4,   // (표시용 기본값 — 실제로는 위 단계표를 씁니다)

  // 한 라운드에 학생에게 보여줄 음료 후보 수.
  // 검출 패턴이 겹치는 음료는 절대 같이 안 들어가므로 시약만으로 반드시 구분됩니다.
  ROUND_CANDIDATES: 8,

  START_COUNTDOWN: 5,         // 선생님이 시작을 누른 뒤 카운트다운(초)
  WATCH_FPS: 2,               // 교사가 학생 화면을 볼 때 초당 프레임 수

  BEAKER_REACTION_SECONDS: 7, // 비커 색 반응 지속 시간
  BEAKER_HIT_RADIUS: 3.2,

  // ============================================================
  //  ★ 가열 — 베네딕트 반응은 불이 있어야 일어난다
  //
  //  필드 곳곳에 불꽃(가열대)이 놓여 있습니다. 가까이 가면 몸에 불이 붙고,
  //  그 상태에서 쏜 베네딕트만 반응합니다. 식은 뒤에 쏘면 아무 일도 없고
  //  "가열해야 합니다" 안내만 뜹니다 (검사 기록도 남지 않습니다).
  //  → 아이들이 '베네딕트 = 가열'을 몸으로 외우게 하는 장치입니다.
  // ============================================================
  HEAT_RADIUS: 4.6,           // 불꽃에서 이 거리 안에 들어가면 몸에 불이 붙는다
  HEAT_SECONDS: 25,           // 불이 붙어 있는 시간(초). 불 옆에 있으면 계속 갱신
  HEAT_WARN_SECONDS: 5,       // 남은 시간이 이보다 적으면 HUD가 빨갛게 깜빡인다

  // ============================================================
  //  ★ 순위 = '음료 3개를 먼저 다 맞춘 순서'
  //
  //  점수가 아니라 **완주 순서**가 등수입니다.
  //  3등이 나오는 순간 라운드가 자동으로 끝나고 정산됩니다.
  //  이미 등수를 확정한 모둠도 계속 뛰어놀 수 있고, 마취탄에 맞을 수 있습니다.
  //  ("1·2등 했으니 3등 나올 때까지 놀아라")
  // ============================================================
  PODIUM_SIZE: 3,                 // 이 수만큼 완주하면 라운드 자동 종료
  SCORE_FINISH: [150, 100, 60],   // 1·2·3등 확정 보너스 (모둠 점수)

  // ============================================================
  //  ★ 선두 모둠 공개 — 마취총에 '이유'를 만들어 주는 장치
  //
  //  아직 완주하지 못한 모둠 중 1위를 **모자 색과 닉네임**으로 전원에게 알려 줍니다.
  //  ("몇 모둠"은 서로 몰라도 모자 색은 눈에 보이니까요.)
  //  이미 등수를 확정한 모둠은 🥇🥈 표시가 붙고, 역시 마취탄 표적이 됩니다.
  //  → 앞서가는 모둠이 자동으로 견제받아 한 모둠이 독주하지 않습니다.
  // ============================================================
  LEADER_ANNOUNCE: true,          // 끄려면 false
  LEADER_FIRST_DELAY: 60,         // 라운드 시작 후 첫 발표까지(초) — 초반엔 다 0점이라 의미 없음
  LEADER_ANNOUNCE_SECONDS: 45,    // 이후 발표 주기(초)
  SCORE_TRANQ_LEADER: 25,         // 1위 모둠원을 마취시키면 (보통 +10 대신) 이 점수
};

// ============================================================
//  마취총 자격시험 — 시약 4종에 대해 한 문제씩, 순서와 보기를 섞는다.
//  정답은 서버만 알고 있고, 채점도 서버가 한다. (소스를 봐도 못 뚫는다)
// ============================================================
export function makeQuiz(rand = Math.random) {
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const nutrientNames = Object.values(NUTRIENTS).map(n => n.name);
  const colorPool = ['청람색', '황적색', '보라색', '선홍색'];

  return shuffle(REAGENT_LIST).map((rid, i) => {
    const rg = REAGENTS[rid];
    // 시약마다 '무엇을 검출?' 또는 '양성이면 무슨 색?' 중 하나를 낸다
    const askColor = rand() < 0.5;
    if (askColor) {
      return {
        q: `${rg.shortName} 용액이 <b>양성</b>이면 무슨 색으로 변할까요?`,
        choices: shuffle(colorPool),
        answer: rg.posText,
      };
    }
    return {
      q: `<b>${rg.shortName}</b> 용액은 어떤 영양소를 검출할까요?`,
      choices: shuffle(nutrientNames),
      answer: NUTRIENTS[rg.reactTo].name,
    };
  });
}

export const TEAM_COLORS = [
  '#e4572e', '#3aa3ff', '#41c464', '#f2c14e',
  '#b967ff', '#00d6c2', '#ff7bac', '#9aa7b4',
];
export const TEAM_NAMES = [
  '1모둠', '2모둠', '3모둠', '4모둠', '5모둠', '6모둠', '7모둠', '8모둠',
];

// ★ 모자(헬멧) 색 이름 — "몇 모둠"은 서로 몰라도 '색'은 눈에 보인다.
//   선두 모둠을 알릴 때 이 이름으로 부른다. 위 TEAM_COLORS 와 순서가 같아야 한다.
export const TEAM_COLOR_NAMES = [
  '빨강', '파랑', '초록', '노랑',
  '보라', '민트', '분홍', '회색',
];

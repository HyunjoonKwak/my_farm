# my_farm 재설계 플랜 (Asset Hub Integration §6 / §8-6)

> 원본 설계: `my_portal/docs/ASSET_HUB_INTEGRATION.md` §6.
> 이 문서는 retirefarm 쪽 실행 플랜과 진행 상태를 기록한다.

## 지배 원칙 (§1.5 요약)

자산 카테고리마다 원장 소유자는 정확히 하나(SSOT)이고 쓰기 경로도 소유자에게만
있다(single writer). retirefarm은 **읽기 전용 소비자** — 자산 수동 입력 필드를
만들지 않는다. 값이 틀렸으면 소유 서비스(portfolio_manager / asset_manager)에서
고치고, 고친 결과가 스냅샷으로 흘러온다.

## Phase 1 — 자산 허브 계약 정렬 ✅ 완료 2026-08-20

> ⚠️ 아래 두 항목(스냅샷 소비자·게이지 데이터 원천)은 **Phase 1.5(§8-8)에서 대체됐다.**
> 현재 구현은 my_portal 순자산 단일 소스다 — 아래는 당시 기록이므로 이걸 기준으로
> 구현하지 말 것. 나머지 항목(매도 시뮬·고아 모델 제거)은 그대로 유효하다.

- [x] ~~**스냅샷 소비자 (§2)**~~ (→ Phase 1.5로 대체): `asset-hub-snapshot.ts`가
  portfolio·asset **두 소스**를 §2.2 계약으로 받고, `external-snapshot.ts`가
  자체 합산 + 48h 스테일 판정, `ExternalAssetSnapshot` 캐시에 저장.
  API 경로 `GET/POST /api/assets/snapshot-summary`는 전환 후에도 유지(내용만 순자산으로).
- [x] ~~**자본 준비 게이지 (§6)** 스냅샷 합산 기준~~ (→ Phase 1.5로 대체):
  `/api/plan`의 `capitalReadiness` + `CapitalReadinessGauge`(plan 대시보드,
  목표 자본 = 순설립비 + 생활비 버퍼) **구조 자체는 유지**되고,
  합산 원천만 두 소스 직접 합산 → 허브 순자산으로 바뀌었다.
- [x] **매도 시뮬 이관 마무리 (§1.5.3-3)**: 로컬 `capital-gains-tax.ts`(asset 원본의
  단순화 복사본)·`sale-simulator.ts`(asset으로 이관 완료본)·양도세 계산기
  라우트/컴포넌트 삭제. `/api/assets/sale-simulator`는 asset_manager
  `POST /api/simulations/sale` 프록시로 대체 (스냅샷 토큰 인증, 원장 자동 로드).
  SaleSimulator UI는 원장 물건 선택+희망가 override 방식으로 재작성.
- [x] **RealEstateAsset 고아 모델 제거**: 프로덕션 0건 확인 후 드롭.
  `FundingSource.linkedAssetId`(FK) → `externalAssetId`(asset_manager Portfolio id,
  FK 없음). 연간 리포트 자산 섹션은 asset_manager 요약으로 교체.
  (기존 코드는 selectedAssetId를 API가 무시해 물건 연결이 저장된 적 없음 — 이제 저장됨)
- [x] 마이그레이션: `20260820004144_asset_hub_phase1_snapshot_consumer`

### 운영 설정 (현행 — Phase 1.5 반영, NAS 적용 완료 2026-08-20)

| 변수 | 값 | 용도 |
|---|---|---|
| `MY_PORTAL_URL` | `http://192.168.1.113:8100` | 자본 게이지 — 허브 순자산(§2.4) |
| `MY_PORTAL_SNAPSHOT_TOKEN` | (소비자 토큰) | 〃 |
| `ASSET_MANAGER_URL` | `http://192.168.1.113:3000` | 매도 시뮬·물건 목록 (별개 경로) |
| `ASSET_MANAGER_SNAPSHOT_TOKEN` | (서비스 토큰) | 〃 |
| `NEXT_PUBLIC_ASSET_MANAGER_URL` | `https://assets.specialrisk.me` | 브라우저 딥링크 |

- 토큰 발급: my_portal `backend/scripts/issue_snapshot_consumer_token.py issue`,
  asset_manager `docker exec naver-crawler-web node scripts/issue-snapshot-token.mjs issue`
  (**.mjs** — .ts 아님). 회전 = 신규 발급 후 구 토큰 revoke.
  ⚠️ 발급 출력에서 토큰만 뽑을 때 `grep '^token'`은 `token_id` 줄까지 잡는다 —
  `grep -E '^token[[:space:]]+:'`로 구분할 것.
- ~~`PORTFOLIO_MANAGER_URL`·`PORTFOLIO_MANAGER_SNAPSHOT_TOKEN`~~ — §8-8 전환으로 **불필요**
  (portfolio 값은 허브 순자산에 포함돼 들어온다). compose의 `portfolio-net` 외부 네트워크
  합류도 함께 제거됐다.
- 두 대상 모두 호스트 포트로 공개돼 있어 컨테이너에서 NAS IP로 직접 접근한다.

## Phase 1.5 — 허브 순자산 단일 소스 전환 ✅ 완료 2026-08-20 (§8-8)

**문제:** Phase 1의 자본 게이지가 portfolio·asset **부분 소스를 직접 합산**해
현금과 비부동산 부채가 빠졌다 (49.0억 표시 vs 실제 순자산 42.5억, 약 6.5억 과대).

**전환:** my_portal `GET /api/assets/net-worth`(§2.4) **단일 소스**로 교체.
- `asset-hub-snapshot.ts`: 2소스 후보 → my_portal 1소스. §2.4 계약 zod 검증
  (`source: literal("my_portal")`로 부분 소스 직접 소비를 타입 레벨에서 차단,
  부채 음수 거부, 자산 `origin` 필수). `checkNetWorthIdentity`는 Σassets−Σliabilities
  항등식을 **확인만** 하고 값은 고치지 않는다 (계약값 우선, 위반 시 warn 로그).
- `external-snapshot.ts`: **자체 합산 `summarizeSnapshotRows` 제거.**
  `net_worth_krw`를 그대로 사용. 스테일 판정도 삭제 — 허브의 `sources[].stale`을
  그대로 UI에 전달한다 (소비자 자체 판단 금지, §2.4).
- 캐시: `ExternalAssetSnapshot`(source×category 다중 행) → `HubNetWorthCache`
  (singleton 1행 + 응답 payload JSON). 재계산하지 않으니 항목을 쪼갤 이유가 없다.
- UI: 순자산 표시 + 자산 항목별 `origin` 뱃지(딥링크 근거) + 부채 내역 + 스테일 뱃지.
- compose: portfolio-net 외부 네트워크 합류 **제거** (portfolio-backend 직접 호출이
  사라짐). my_portal은 `0.0.0.0:8100`, asset은 `0.0.0.0:3000`으로 호스트 포트 접근.
- **매도 시뮬용 asset_manager 연결은 그대로 유지** — 게이지와 별개 경로다 (§1.5.3).
  물건 단위 원장 조회가 필요해 집계 API로 대체 불가.
- 마이그레이션: `20260820065859_hub_net_worth_single_source`

## Phase 2 — 작기(作期) 캘린더 + 온보딩 마법사 ✅ 완료 2026-08-20

- [x] **작기 캘린더**: ssampin의 학기+컬러 라벨 구조 패턴 차용 (코드 복사 없음).
  `lib/utils/crop-calendar.ts`(순수 로직: 월 행렬·색 배정·작기 판정·이벤트, 테스트 9건) +
  `CropCalendar`(월간 그리드에 작기 컬러 막대·범례 D-day·이번 달 파종/수확 일정).
  /farm/crops 페이지를 캘린더/목록 탭으로 재구성. 데이터는 기존 `/api/farm/crops` 재사용.
- [x] **온보딩 마법사**: `FarmProfile` 모델(지역·재배형태·면적·목표연도·plannedCrops JSON)
  + `/api/onboarding`(GET 프리필/POST 저장). 3단계 마법사(`OnboardingWizard`,
  /onboarding) — 완료 시 예정 작물 중 가락시장 수집 품목을 `ProductWatchlist`에
  자동 등록 (비수집 품목은 안내 후 제외). 대시보드에 프로필 미설정 시 유도 배너
  (강제 리다이렉트 없음 — 기존 사용자 흐름 보존).
  **Crop 행은 만들지 않는다** — 예정 단계엔 날짜가 없으므로 실제 파종 시 작물 관리에서 등록.
- 마이그레이션: `20260820012409_farm_profile_onboarding` (추가만, 파괴 없음)

## Phase 3 — 운영일지 BlockNote 전환 ✅ 완료 2026-08-20

- [x] `@blocknote/shadcn`(0.54, MPL-2.0 계열 의존성 — 사용 OK, 프로젝트 shadcn 스택과 일치) 도입.
- [x] `FarmingLog.content` 컬럼(BlockNote 문서 JSON) + 생성/수정 API zod 검증
  (`blockNoteContentSchema`: 최상위 배열 JSON·200KB 상한).
- [x] `FarmingLogEditor`(ko 로케일·다크모드 연동·SSR 제외 dynamic import),
  작성 다이얼로그 본문 에디터, 카드 평문 미리보기 + 읽기 전용 열람 다이얼로그.
- [x] `blockNoteToPlainText` 재귀 추출 유틸 (미리보기·HWPX 출력 공용).
- 기존 폼 기반 활동 기록(FarmActivity)은 구조화 데이터로 병행 유지 (HWPX·통계 원천).
- 마이그레이션: `20260820013243_farming_log_blocknote_content` (추가만)

## Phase 4 — 영농일지 HWP 출력 ✅ 완료 2026-08-20 (지원서류는 잔여)

- [x] `@ubermensch1218/hwpxcore`(MIT, 0.1.3) — Skeleton.hwpx 주입 방식.
  next.config `serverExternalPackages` 등록 필수 (번들 인라인 시 자산 경로 깨짐),
  스켈레톤은 `createRequire`로 패키지 엔트리를 해석해 직접 로드
  (라이브러리 `loadSkeletonHwpx`는 ESM 로더에서 Node 분기 미동작).
- [x] `GET /api/farm/logs/export?month=YYYY-MM` — 월간 일지·활동·본문(평문)을
  제목+농장 정보+작업 내역 표(일자/날씨/기온/구분/내용)로 생성. 일지 목록에 HWPX 버튼.
- [x] 테스트: 행 구성 순수 함수 + 실제 ZIP 바이너리 생성 스모크 (`@vitest-environment node`).
- [ ] **지원서류 서식** (농업경영체 등록·보조사업 신청 등): 실서식 확정을 사용자와
  협의 후 별도 작업 — 서식 원본 HWPX를 템플릿으로 넣고 필드 주입하는 구조 권장.

## Phase 5 — 작물 시세 KAMIS 검토 ✅ 검토 완료 2026-08-20 → **가락시장 유지, KAMIS 보류**

**커버리지 확인 결과 (MARKET_PRODUCTS 25품목 기준, KAMIS 조사 품목 대조):**
- 24/25 커버: 토마토·포도·딸기·수박·참외·오이·배추·상추·시금치·양배추·무·당근·
  감자(152)·고구마(151)·사과·배·감귤·복숭아·멜론·파프리카·브로콜리·호박·가지,
  고추는 풋고추/붉은고추/건고추로 세분 (매핑 필요)
- 미커버 추정 1: **자두** — KAMIS 상시 조사 품목 목록에서 확인 안 됨
  (가락시장 경락 데이터로는 커버됨)

**결정 근거:**
1. §6의 "KAMIS 우선 검토" 전제는 *크롤링 대비 정석 API*였는데, 현 구현은 이미
   크롤링이 아니라 **가락시장 공공데이터 API** (4622111에서 전환 완료) — 전제 해소.
2. 가락시장 경락가는 낙찰가+물량이라 생산자(출하 판단) 관점에 더 적합.
   KAMIS는 조사가(도매 중도매인가+소매가)로 성격이 보완적이지 대체제가 아님.
3. 유일한 미커버 후보(자두)조차 KAMIS도 미조사 추정이라 도입 실익 없음.

**향후 트리거:** "소매가 비교" 기능이 필요해지면 KAMIS 일별 소매(API #17)를
기존 node-cron 스케줄러 구조 재사용해 추가 (공공데이터포털 경유 시 즉시 키 발급).

## 이 세션에서 내린 결정

1. **레거시 per-item API(`/api/portfolio/service`) 유지**: 집계 API는 물건 단위를
   내려주지 않으므로 자금 유입 계획(물건별 매도 예정·순수익)에는 별도 조회가 필요하다.
   읽기 전용이므로 지배 원칙 위반 아님. **집계는 허브 순자산(§2.4), 물건 상세는
   레거시 API**로 역할 분리.
2. ~~**my_portal 현금은 게이지 합산에서 제외 (v1)**~~ — **무효 (2026-08-20, §8-8 전환).**
   당시 my_portal에 제공자 엔드포인트가 없어 내린 결정이었으나, §8-7로 허브가
   `GET /api/assets/net-worth`(§2.4)를 제공하면서 전제가 사라졌다. 지금은 **현금·부채를
   포함한 허브 순자산을 그대로 받는다** — 게이지에서 제외되는 자산은 없다.
   (이 제외가 순자산을 6.5억 과대 표시시킨 원인이었다: 49.0억 → 42.6억으로 정정)
3. **허브 순자산 캐시(`HubNetWorthCache`)는 전역(사용자 무관)**: 가족 단일 가구 사용 전제.
   소비자 토큰이 허브 쪽 특정 사용자에 귀속되므로 retirefarm 사용자별 분리는 무의미.
   재계산을 하지 않으니 항목을 쪼갤 이유도 없어 singleton 1행 + payload JSON으로 둔다.

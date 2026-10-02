# My Farm (my_farm)

> 2026-10-02 리브랜딩: 옛 이름 Retirefarm Manager · retirefarm_manager. NAS 폴더·이미지·컨테이너를 my_farm / my-farm으로 바꿨다. DB(retirefarm.db)·크롬 확장·작업자 토큰·도메인 이름은 그대로다.

> **목표 · 귀농·스마트팜 경영** — 평택 스마트팜(대추방울토마토)의 귀농 준비·자금·영농 기록과 주간 시장 브리핑(가락시장 도매가·경쟁점 판매가)을 관리한다.  
> **하지 않는 일** — 스마트스토어 주문·재고 운영(store_manager).

Next.js 16 · Prisma/SQLite · NextAuth/Kakao 기반 귀농 준비·자금·영농 관리 앱입니다.

## 생업·가족 앱의 목표와 경계

| 앱 | 어디서 | 목표 | 하지 않는 일 |
|---|---|---|---|
| **[store_manager](https://github.com/HyunjoonKwak/openstore_manager)** | NAS 웹 | **스마트스토어 운영** — 스마트스토어의 주문·재고를 관리하고 AI 상세페이지 생성과 경쟁사 벤치마킹을 한다 | 농장 영농·자금 관리(my_farm) |
| **my_farm** (이것) | NAS 웹 | **귀농·스마트팜 경영** — 평택 스마트팜(대추방울토마토)의 귀농 준비·자금·영농 기록과 주간 시장 브리핑(가락시장 도매가·경쟁점 판매가)을 관리한다 | 스마트스토어 주문·재고 운영(store_manager) |
| **[goe_recruit](https://github.com/HyunjoonKwak/goe_recruit)** | NAS 웹 | **가족 구직** — 아내의 학교 구인구직 검색 — 경기도교육청 채용공고를 모아 보여 주고 새 공고를 텔레그램으로 알린다 | 다른 지역·직군 채용, 지원서 작성 |

도매시장 시세 플랫폼 nongsise_platform은 쓰지 않아 2026-10-01에 보관했다(도매가는 my_farm가 직접 수집).

## 로컬 실행

Node.js 20 이상과 `sqlite3` CLI가 필요합니다. SQLite 도구 경로는 필요 시 `SQLITE_BIN`으로 지정합니다.

```sh
cp .env.example .env
npm ci
npm run db:generate
npm run db:migrate
npm run dev
```

`.env`에 Kakao OAuth 앱 설정과 `NEXTAUTH_SECRET`을 설정하세요. 로컬 기본 포트는 3000이므로 `NEXTAUTH_URL=http://localhost:3000`과 Kakao callback `http://localhost:3000/api/auth/callback/kakao`를 맞춥니다. Docker 외부 포트는 3024입니다.

Prisma의 상대 SQLite URL은 `prisma/` 기준입니다. `DATABASE_URL=file:./data/retirefarm.db`는 프로젝트의 `prisma/data/retirefarm.db`입니다. 운영 환경은 절대 경로를 권장합니다.

## 관리자 등록과 기존 계정 연결

- 신규 로그인은 기본 USER입니다. 첫 로그인이라고 ADMIN 권한을 부여하지 않습니다.
- 운영자가 본인 소유를 확인한 **카카오 사용자 ID**를 `KAKAO_ADMIN_ID`로 지정하면 해당 계정의 다음 로그인에서 관리자 등록/승격이 가능합니다. Kakao 앱의 client ID와는 다른 값입니다.
- 기존 카카오 미연결 ADMIN 계정을 유지해야 하면 위 값과 함께 그 DB 계정의 `id`를 `KAKAO_ADMIN_USER_ID`로 지정합니다. 오직 이 ADMIN 계정에만 연결하며, 이메일 일치만으로 계정을 연결하지 않습니다. 이미 다른 카카오 계정에 연결된 계정은 재연결하지 않습니다.
- 이미 연결된 관리자는 기존 로그인 그대로 사용합니다. 일회성 등록 후 환경 변수 두 개를 비우고 재시작하면 추후 의도치 않은 재승격을 막을 수 있습니다.
- 모든 백업 API는 DB의 현재 ADMIN 권한을 확인합니다. 권한 변경/계정 삭제는 기존 JWT에도 반영됩니다.

## Docker 배포

```sh
docker compose up -d --build
# 또는 GHCR 이미지
docker compose -f docker-compose.prod.yml up -d
```

`DATA_PATH`는 호스트 DB 디렉터리, `BACKUP_PATH`는 호스트 백업 디렉터리입니다. 컨테이너에서는 각각 `/app/prisma/data`, `/backups`로 연결합니다. 기존 설치의 `BACKUP_DIR` 호스트 볼륨 설정도 `BACKUP_PATH`가 비어 있으면 그대로 사용합니다. 두 값이 모두 있으면 `BACKUP_PATH`가 우선이므로 기존 폴더와 일치하는지 확인하세요. 두 폴더는 컨테이너 사용자 UID 1001/GID 1001이 쓸 수 있어야 합니다.

시작 순서는 예약 복원 적용 → `prisma migrate deploy` → Next.js 서버입니다. migration 파일 변경은 검토 후 배포하며, 로컬 운영 DB에 `db push`를 실행해 우회하지 않습니다. 기존 볼륨 데이터는 이미지에 포함되지 않습니다.

## 백업과 복원

- 설정의 백업 탭은 관리자만 사용합니다. 수동·자동 백업은 파일 복사 대신 [SQLite 온라인 백업](https://www.sqlite.org/backup.html)으로 일관된 snapshot을 만듭니다.
- 자동 백업 실행기는 앱 부팅 시 시작됩니다. 매분 `/backups/config/backup-schedule.json`(로컬은 `BACKUP_DIR/config`)을 읽고 **한국 시간**의 요일·시각·enabled·보관 기간을 적용합니다. `CONFIG_DIR`로 공통 설정 경로를 바꿀 수 있습니다. 앱이 꺼져 있던 시각의 백업은 소급하지 않습니다.
- 호스트 crontab은 필요 없습니다. 기존 `scripts/backup-cron.sh`는 같은 앱 내 코드를 호출하는 호환 진입점이며 기존 crontab은 제거하세요. 자동 정리는 `backup_*.db[.gz]`만 대상으로 하고 `pre_restore_*` 안전 백업은 보존합니다.
- `.db`와 `.db.gz`는 압축 해제·SQLite 무결성·앱 스키마/마이그레이션 확인 후 **복원 예약**합니다. HTTP 요청 중에는 사용 중인 DB를 덮어쓰지 않습니다. 예약은 UI에서 취소할 수 있습니다.
- 모든 DB 쓰기 프로세스가 종료된 상태에서 앱 컨테이너를 재시작하면 먼저 `pre_restore_*` 안전 백업을 생성한 뒤 SQLite restore로 적용합니다. 안전 백업이 실패하면 복원과 앱 시작을 중단합니다. 예약 후 추가한 데이터는 복원본에 없지만 안전 백업에 보존됩니다.
- 로컬에서는 dev/start 서버를 완전히 종료하고 `node scripts/sqlite-backup.mjs apply-pending` → `npx prisma migrate deploy` → 서버 실행 순서로 적용하세요.
- 중단된 복원의 `.restore-pending.applying` 파일이 있으면 자동 재적용하지 않고 시작을 중단합니다. 앱이 종료된 상태에서 `pre_restore_*`와 이 파일의 무결성을 확인해 복구 방향을 선택하세요. 적용이 이미 성공했다면 `.applying` 파일을 별도 보존 위치로 옮겨 재적용을 막고, 재시도가 필요하면 검증 후 `.restore-pending`으로 이름을 바꿉니다. 이전 상태 복구가 필요하면 검증한 안전 백업을 예약 파일로 사용합니다. 원본과 안전 백업은 확인이 끝날 때까지 삭제하지 마세요.

## 날짜·금액 모델 변경

`20260906090000_setup_cost_schedule_crop_completion` 마이그레이션을 적용한 뒤 새 코드를 실행하세요. 설립비에 지출 예정일·지출일, 작물에 완료일·추정 여부가 추가됩니다. 기존 날짜는 일괄 backfill하지 않습니다. 이미 지출한 설립비는 지출일을 입력하고, 기존 완료 작물의 추정 날짜는 필요하면 교정하세요. 기존 소수 금액은 집계에서 보존하고 신규 입력만 정수 원 단위로 제한합니다.

## 검증

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

백업 통합 테스트는 임시 SQLite 파일만 사용하며 `sqlite3` CLI가 필요합니다. 운영 계정/DB에 접근하지 않습니다. 프로젝트 리뷰와 후속 수정 기록은 `docs/reviews/`에 있습니다.

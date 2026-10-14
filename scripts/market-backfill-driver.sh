#!/bin/sh
# 과거 시세 백필 드라이버 — 컨테이너 안에서 실행한다.
#   docker exec -d my-farm sh /app/scripts/market-backfill-driver.sh
#
# market-backfill.cjs를 하루 단위로 반복 호출하며 과거로 내려간다. 저널에 완료 날짜가
# 남으므로 중단해도 이어서 재개된다. 세 가지 이유로 스스로 멈춘다.
#   1) 원천 API 일일 조회 한도 초과 — 같은 날 재시도해도 한도만 더 쓴다
#   2) MAX_DAYS 도달 — 정기 수집이 쓸 한도를 남겨 둔다
#   3) 연속 실패 — 원인을 모른 채 계속 두드리지 않는다
#
# 환경변수: FROM(기본: 보유 자료의 가장 오래된 날짜 하루 전), FLOOR, MAX_DAYS, GAP
#   PRODUCTS: 이 품목만 수집 (예: 오이 — 새로 추가한 품목만 과거를 채울 때)
#   JOURNAL: 완료 날짜 저널 경로 (품목별로 분리 권장)
#   DAILY_RESUME=1: 하루 상한·조회 한도에 걸리면 멈추지 않고 기다렸다 이어서 진행
#     (상한 도달 → 24시간 대기, 한도 초과 → RESUME_WAIT초 대기 후 같은 날짜 재시도)
set -u

DB=/app/prisma/data/retirefarm.db
JOURNAL=${JOURNAL:-/app/prisma/data/market-backfill.jsonl}
PRODUCTS=${PRODUCTS:-}
DAILY_RESUME=${DAILY_RESUME:-0}
RESUME_WAIT=${RESUME_WAIT:-21600}
export BACKFILL_LOG="$JOURNAL"
LOG=${BACKFILL_DRIVER_LOG:-/app/prisma/data/backfill-driver.log}
FLOOR=${FLOOR:-2021-09-07}
MAX_DAYS=${MAX_DAYS:-250}
GAP=${GAP:-8}

sq() { sqlite3 -cmd ".timeout 15000" "$DB" "$1" 2>/dev/null; }
day_before() {
  node -e "const d=new Date(process.argv[1]+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-1);console.log(d.toISOString().slice(0,10))" "$1"
}
stamp() { date "+%Y-%m-%d %H:%M:%S"; }

OLDEST=$(sq 'SELECT date(MIN(auctionDate)/1000,"unixepoch","+9 hours") FROM AuctionResult;')
CUR=${FROM:-$(day_before "${OLDEST:-2026-01-01}")}

echo "start $(stamp) from=$CUR floor=$FLOOR max=${MAX_DAYS}일 gap=${GAP}s products=${PRODUCTS:-설정 전체} resume=$DAILY_RESUME" >> "$LOG"

done_days=0
fails=0
while [ "$CUR" \> "$FLOOR" ] || [ "$CUR" = "$FLOOR" ]; do
  if [ "$done_days" -ge "$MAX_DAYS" ]; then
    if [ "$DAILY_RESUME" = "1" ]; then
      echo "pause $(stamp): 하루 처리량 상한 ${MAX_DAYS}일 도달. 24시간 뒤 $CUR부터 재개" >> "$LOG"
      sleep 86400
      done_days=0
      continue
    fi
    echo "stop $(stamp): 하루 처리량 상한 ${MAX_DAYS}일 도달. 다음 시작일=$CUR" >> "$LOG"
    break
  fi

  SINCE=$(( $(date +%s) * 1000 ))
  if [ -n "$PRODUCTS" ]; then
    node /app/scripts/market-backfill.cjs --from "$CUR" --to "$CUR" --products "$PRODUCTS" >> "$LOG" 2>&1
  else
    node /app/scripts/market-backfill.cjs --from "$CUR" --to "$CUR" >> "$LOG" 2>&1
  fi

  # 수집기가 남긴 사유로 한도 초과를 판정한다. 별도 조회로 한도를 더 쓰지 않는다.
  QUOTA=$(sq "SELECT COUNT(*) FROM DataCollectionLog WHERE startedAt >= $SINCE AND errorMessage LIKE '%quota_exceeded%';")
  [ -z "$QUOTA" ] && QUOTA=0
  if [ "$QUOTA" != "0" ]; then
    if [ "$DAILY_RESUME" = "1" ]; then
      echo "pause $(stamp): 원천 API 일일 조회 한도 초과. ${RESUME_WAIT}초 뒤 $CUR 재시도" >> "$LOG"
      sleep "$RESUME_WAIT"
      continue
    fi
    echo "stop $(stamp): 원천 API 일일 조회 한도 초과. 다음 시작일=$CUR (한도 회복 후 재실행)" >> "$LOG"
    break
  fi

  case "$(grep "\"date\":\"$CUR\"" "$JOURNAL" 2>/dev/null | tail -1)" in
    *'"complete":true'*)
      fails=0
      done_days=$((done_days + 1))
      ;;
    *)
      fails=$((fails + 1))
      echo "incomplete $CUR (연속 $fails)" >> "$LOG"
      ;;
  esac

  if [ "$fails" -ge 5 ]; then
    echo "stop $(stamp): 연속 5일 실패. 다음 시작일=$CUR" >> "$LOG"
    break
  fi

  CUR=$(day_before "$CUR")
  sleep "$GAP"
done

echo "end $(stamp) 완료=${done_days}일 다음시작일=$CUR" >> "$LOG"

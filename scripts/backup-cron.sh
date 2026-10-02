#!/bin/sh
set -eu
# 앱 내 스케줄러가 매분 같은 설정을 읽습니다. 별도 호스트 crontab은 필요 없습니다.
# 기존 crontab 호환용: 설정 경로·요일·시간·보관 기간 판단을 앱 코드에 위임합니다.
exec docker exec "${CONTAINER_NAME:-my-farm}" node scripts/sqlite-backup.mjs scheduled

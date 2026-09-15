#!/bin/bash

# RetireFarm Manager - NAS 배포 스크립트 (GHCR 이미지 기반)
# 사용법: ./deploy.sh [login|pull|deploy|update|start|stop|restart|status|logs|backup|clean]

set -e

# 설정
APP_NAME="retirefarm-manager"
GHCR_USERNAME="${GHCR_USERNAME:-hyunjoonkwak}"
IMAGE_NAME="ghcr.io/$GHCR_USERNAME/retirefarm-manager"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
BACKUP_DIR="$DEPLOY_DIR/backups"
DB_FILE="retirefarm.db"

# 색상
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 환경 변수 파일 확인
check_env() {
    if [ ! -f "$DEPLOY_DIR/.env" ]; then
        log_warning ".env 파일이 없습니다."
        echo ""
        echo "필수 환경 변수 (.env 파일에 설정):"
        echo "  NEXTAUTH_SECRET=<랜덤 시크릿>"
        echo "  NEXTAUTH_URL=http://your-nas-ip:3024"
        echo "  KAKAO_CLIENT_ID=<카카오 REST API 키>"
        echo "  KAKAO_CLIENT_SECRET=<카카오 Client Secret>"
        echo ""
        return 1
    fi
    source "$DEPLOY_DIR/.env"
}

# GHCR 로그인 상태 확인
check_ghcr_login() {
    # Docker config에서 ghcr.io 로그인 여부 확인
    if grep -q "ghcr.io" ~/.docker/config.json 2>/dev/null; then
        return 0
    fi
    return 1
}

# GHCR 로그인 (대화형)
ghcr_login() {
    # 이미 로그인 되어있으면 스킵
    if check_ghcr_login; then
        log_success "GHCR 이미 로그인됨 (스킵)"
        return 0
    fi

    log_info "GHCR 로그인"
    echo ""
    echo -e "${YELLOW}GitHub Personal Access Token이 필요합니다.${NC}"
    echo ""

    read -p "GitHub 사용자명 [$GHCR_USERNAME]: " input_username
    GHCR_USERNAME="${input_username:-$GHCR_USERNAME}"

    echo -e "${YELLOW}토큰을 입력하세요 (read:packages 권한 필요):${NC}"
    read -s token
    echo ""

    if [ -z "$token" ]; then
        log_error "토큰이 입력되지 않았습니다."
        exit 1
    fi

    echo "$token" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin

    if [ $? -eq 0 ]; then
        log_success "GHCR 로그인 성공"
    else
        log_error "GHCR 로그인 실패"
        exit 1
    fi
}

# 이미지 Pull
pull_image() {
    log_info "이미지 다운로드 중: $IMAGE_NAME:$IMAGE_TAG"

    docker pull "$IMAGE_NAME:$IMAGE_TAG"

    if [ $? -eq 0 ]; then
        log_success "이미지 다운로드 완료"
    else
        log_error "이미지 다운로드 실패. GHCR 로그인 상태를 확인하세요."
        exit 1
    fi
}

# 배포 (초기 설치)
deploy() {
    log_info "RetireFarm Manager 배포 중..."

    # 필수 디렉토리 생성
    mkdir -p "$BACKUP_DIR"

    # GHCR 로그인 (대화형)
    ghcr_login

    # 이미지 pull
    pull_image

    log_info "컨테이너 시작 중..."
    docker-compose -f "$COMPOSE_FILE" up -d

    if [ $? -eq 0 ]; then
        log_success "배포 완료"
        status
        healthcheck
    else
        log_error "배포 실패"
        exit 1
    fi
}

# 업데이트 (새 이미지로 교체)
# 배포 후 태그 없는(dangling) 이미지 정리 — 배포마다 이전 이미지가 남아 19GB까지 쌓인 사례(2026-09-15).
# 실행 중이거나 태그가 있는 이미지는 건드리지 않는다. 실패해도 배포 결과에는 영향 없음.
prune_dangling_images() {
    echo "🧹 태그 없는 이미지 정리 중..."
    docker image prune -f || true
}

update() {
    log_info "RetireFarm Manager 업데이트 중..."

    # 현재 상태 백업
    log_info "업데이트 전 백업 생성..."
    backup

    # 새 이미지 pull (로그인 상태 확인 후 필요시 로그인)
    pull_image

    # 컨테이너 재시작
    log_info "컨테이너 업데이트 중..."
    docker-compose -f "$COMPOSE_FILE" up -d

    if [ $? -eq 0 ]; then
        log_success "업데이트 완료"
        status
        healthcheck
    else
        log_error "업데이트 실패"
        exit 1
    fi
    prune_dangling_images
}

# 시작
start() {
    log_info "$APP_NAME 시작 중..."
    docker-compose -f "$COMPOSE_FILE" up -d

    if [ $? -eq 0 ]; then
        log_success "$APP_NAME 시작됨"
        status
        healthcheck
    else
        log_error "시작 실패"
        exit 1
    fi
}

# 중지
stop() {
    log_info "$APP_NAME 중지 중..."
    docker-compose -f "$COMPOSE_FILE" down

    if [ $? -eq 0 ]; then
        log_success "$APP_NAME 중지됨"
    else
        log_error "중지 실패"
        exit 1
    fi
}

# 재시작
restart() {
    log_info "$APP_NAME 재시작 중..."
    stop
    sleep 2
    start
}

# 상태 확인
status() {
    log_info "$APP_NAME 상태:"
    echo ""
    docker-compose -f "$COMPOSE_FILE" ps 2>/dev/null || echo "컨테이너가 실행 중이지 않습니다."
    echo ""

    # 현재 이미지 정보
    log_info "현재 이미지:"
    docker images "$IMAGE_NAME" --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}" 2>/dev/null || true
    echo ""
}

# 헬스체크
healthcheck() {
    local max_attempts=${1:-15}
    local wait_seconds=${2:-3}

    log_info "헬스체크 중... (최대 ${max_attempts}회 시도)"

    for i in $(seq 1 $max_attempts); do
        HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3024 2>/dev/null || echo "000")

        if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ] || [ "$HTTP_STATUS" = "307" ]; then
            log_success "애플리케이션 정상 응답 (HTTP $HTTP_STATUS)"
            log_info "접속 URL: http://localhost:3024"
            return 0
        fi

        if [ $i -lt $max_attempts ]; then
            echo -ne "\r  시도 $i/$max_attempts - 대기 중... (HTTP $HTTP_STATUS)"
            sleep $wait_seconds
        fi
    done

    echo ""
    log_warning "애플리케이션이 아직 준비되지 않았습니다."
    log_info "'$0 logs'로 로그를 확인하세요."
    return 1
}

# 로그 보기
logs() {
    docker-compose -f "$COMPOSE_FILE" logs -f --tail=100
}

# 백업 (SQLite 온라인 스냅샷)
backup() {
    log_info "SQLite 온라인 백업 생성 및 무결성 검증 중..."

    # 실행 중인 앱과 같은 DB/볼륨을 사용한다. WAL의 미체크포인트 커밋도 포함한다.
    # 백업 실패 시 update()의 set -e가 이미지 교체를 중단한다. 파일 복사로 우회하지 않는다.
    if docker exec retirefarm-app node scripts/sqlite-backup.mjs create; then
        log_success "온라인 백업 완료 (앱의 BACKUP_DIR에 저장)"
    else
        log_error "온라인 백업 실패: 컨테이너 상태와 백업 볼륨을 확인하세요."
        return 1
    fi
}

# 정리 (오래된 이미지 삭제)
clean() {
    log_info "오래된 이미지 정리 중..."

    # 현재 사용 중인 이미지 제외하고 삭제
    docker image prune -f

    # dangling 이미지 삭제
    docker images "$IMAGE_NAME" --filter "dangling=true" -q | xargs -r docker rmi 2>/dev/null || true

    log_success "정리 완료"
}

# 도움말
show_help() {
    echo ""
    echo "=========================================="
    echo "  RetireFarm Manager - NAS 배포 스크립트"
    echo "=========================================="
    echo ""
    echo "사용법: $0 [명령어]"
    echo ""
    echo "명령어:"
    echo "  login    - GHCR 로그인 (대화형, 최초 1회)"
    echo "  pull     - 최신 이미지 다운로드"
    echo "  deploy   - 초기 배포 (로그인 + pull + 시작)"
    echo "  update   - 업데이트 (백업 + pull + 재시작)"
    echo "  start    - 컨테이너 시작"
    echo "  stop     - 컨테이너 중지"
    echo "  restart  - 컨테이너 재시작"
    echo "  status   - 상태 확인"
    echo "  logs     - 로그 보기"
    echo "  backup   - 데이터베이스 백업"
    echo "  clean    - 오래된 이미지 정리"
    echo "  health   - 헬스체크"
    echo "  help     - 도움말"
    echo ""
    echo "환경 변수:"
    echo "  GHCR_USERNAME  - GitHub Username (기본: hyunjoonkwak)"
    echo "  IMAGE_TAG      - 이미지 태그 (기본: latest)"
    echo ""
    echo "예시:"
    echo "  $0 deploy        # 초기 배포"
    echo "  $0 update        # 업데이트"
    echo "  IMAGE_TAG=v1.0.0 $0 update  # 특정 버전으로 업데이트"
    echo ""
}

# 메인
case "$1" in
    login)
        ghcr_login
        ;;
    pull)
        ghcr_login
        pull_image
        ;;
    deploy)
        deploy
        ;;
    update)
        update
        ;;
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    backup)
        backup
        ;;
    clean)
        clean
        ;;
    health|healthcheck)
        healthcheck
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        log_error "알 수 없는 명령어: $1"
        show_help
        exit 1
        ;;
esac

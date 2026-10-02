#!/bin/bash

# RetireFarm Manager - 로컬 개발 및 GHCR 배포 관리 스크립트
# 사용법: ./manage.sh [명령어]

set -e

# 설정
APP_NAME="my-farm"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCKER_COMPOSE_FILE="$APP_DIR/docker-compose.yml"
BACKUP_DIR="$APP_DIR/backups"
DB_FILE="retirefarm.db"

# GHCR 설정
GHCR_USERNAME="${GHCR_USERNAME:-hyunjoonkwak}"
GHCR_USERNAME=$(echo "$GHCR_USERNAME" | tr '[:upper:]' '[:lower:]')
IMAGE_NAME="ghcr.io/$GHCR_USERNAME/my-farm"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# 색상
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 로그 함수
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Docker Compose 파일 존재 확인
check_docker_compose() {
    if [ ! -f "$DOCKER_COMPOSE_FILE" ]; then
        log_error "docker-compose.yml 파일이 없습니다. 먼저 생성해주세요."
        exit 1
    fi
}

# 환경 변수 파일 확인
check_env() {
    if [ ! -f "$APP_DIR/.env" ]; then
        log_warning ".env 파일이 없습니다. .env.example을 복사합니다."
        if [ -f "$APP_DIR/.env.example" ]; then
            cp "$APP_DIR/.env.example" "$APP_DIR/.env"
            log_info ".env 파일을 생성했습니다. 설정을 확인해주세요."
        else
            log_error ".env.example 파일도 없습니다. 환경 변수를 설정해주세요."
            exit 1
        fi
    fi
    source "$APP_DIR/.env"
}

# ==================== 로컬 개발 (Docker) ====================

# 배포 (처음 배포 또는 전체 재배포)
deploy() {
    local no_cache=$1
    log_info "$APP_NAME 배포 중..."

    check_docker_compose
    check_env

    # 필수 디렉토리 생성
    local data_dir="${DATA_PATH:-$APP_DIR/data}"
    mkdir -p "$BACKUP_DIR" "$data_dir"

    # 기존 컨테이너 중지
    log_info "기존 컨테이너 중지 중..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" down || true

    # 빌드
    log_info "Docker 이미지 빌드 중..."
    if [ "$no_cache" = "no-cache" ]; then
        log_warning "캐시 없이 빌드합니다..."
        docker-compose -f "$DOCKER_COMPOSE_FILE" build --no-cache
    else
        docker-compose -f "$DOCKER_COMPOSE_FILE" build
    fi

    # 시작
    log_info "컨테이너 실행 중..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" up -d

    if [ $? -eq 0 ]; then
        log_success "배포 완료!"
        echo ""
        status
        healthcheck 15 3
    else
        log_error "배포 실패"
        exit 1
    fi
}

# 시작
start() {
    log_info "$APP_NAME 시작 중..."
    check_docker_compose
    check_env

    local data_dir="${DATA_PATH:-$APP_DIR/data}"
    mkdir -p "$BACKUP_DIR" "$data_dir"

    docker-compose -f "$DOCKER_COMPOSE_FILE" up -d

    if [ $? -eq 0 ]; then
        log_success "$APP_NAME이(가) 시작되었습니다."
        status
        healthcheck 15 3
    else
        log_error "시작에 실패했습니다."
        exit 1
    fi
}

# 중지
stop() {
    log_info "$APP_NAME 중지 중..."
    check_docker_compose

    docker-compose -f "$DOCKER_COMPOSE_FILE" down

    if [ $? -eq 0 ]; then
        log_success "$APP_NAME이(가) 중지되었습니다."
    else
        log_error "중지에 실패했습니다."
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
    docker-compose -f "$DOCKER_COMPOSE_FILE" ps 2>/dev/null || echo "컨테이너가 실행 중이지 않습니다."
    echo ""
}

# 헬스체크 (재시도 포함)
healthcheck() {
    local max_attempts=${1:-10}
    local wait_seconds=${2:-3}

    if ! command -v curl &> /dev/null; then
        log_warning "curl이 설치되어 있지 않아 헬스체크를 건너뜁니다."
        return 0
    fi

    log_info "헬스체크 중... (최대 ${max_attempts}회 시도, ${wait_seconds}초 간격)"

    for i in $(seq 1 $max_attempts); do
        HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3024 2>/dev/null || echo "000")

        if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ] || [ "$HTTP_STATUS" = "307" ]; then
            log_success "애플리케이션이 정상 응답합니다. (HTTP $HTTP_STATUS)"
            log_info "접속 URL: http://localhost:3024"
            return 0
        fi

        if [ $i -lt $max_attempts ]; then
            echo -ne "\r  시도 $i/$max_attempts - 대기 중... (HTTP $HTTP_STATUS)"
            sleep $wait_seconds
        fi
    done

    echo ""
    log_warning "애플리케이션이 아직 준비되지 않았습니다. (HTTP $HTTP_STATUS)"
    log_info "잠시 후 다시 확인하거나 '$0 logs'로 로그를 확인하세요."
    return 1
}

# 로그 보기
logs() {
    local service=$1

    if [ -z "$service" ]; then
        log_info "$APP_NAME 전체 로그:"
        docker-compose -f "$DOCKER_COMPOSE_FILE" logs -f --tail=100
    else
        log_info "$APP_NAME $service 로그:"
        docker-compose -f "$DOCKER_COMPOSE_FILE" logs -f --tail=100 "$service"
    fi
}

# 빌드
build() {
    local no_cache=$1
    log_info "$APP_NAME 빌드 중..."
    check_docker_compose
    check_env

    if [ "$no_cache" = "no-cache" ]; then
        log_warning "캐시 없이 빌드합니다..."
        docker-compose -f "$DOCKER_COMPOSE_FILE" build --no-cache
    else
        docker-compose -f "$DOCKER_COMPOSE_FILE" build
    fi

    if [ $? -eq 0 ]; then
        log_success "빌드가 완료되었습니다."
    else
        log_error "빌드에 실패했습니다."
        exit 1
    fi
}

# 로컬 개발용 업데이트 (빌드 + 재시작)
dev_update() {
    local no_cache=$1
    log_info "$APP_NAME 로컬 개발 업데이트 중..."

    build "$no_cache"
    restart

    log_success "로컬 개발 업데이트가 완료되었습니다."
}

# 컨테이너 및 볼륨 정리
clean() {
    log_info "컨테이너 및 이미지 정리 중..."

    log_warning "컨테이너 삭제 중..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" down -v || true

    log_warning "사용하지 않는 이미지 삭제 중..."
    docker image prune -f

    log_success "정리 완료!"
}

# 클린업 (미사용 이미지/볼륨 정리, 볼륨 유지)
cleanup() {
    log_info "Docker 리소스 정리 중..."

    docker system prune -f
    docker volume prune -f

    log_success "정리가 완료되었습니다."
}

# 셸 접속
shell() {
    log_info "컨테이너 셸에 접속합니다..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" exec app /bin/sh
}

# ==================== 데이터베이스 ====================

# 데이터베이스 백업 (SQLite - 호스트 디렉토리에서 직접 복사)
backup() {
    log_info "SQLite 데이터베이스 백업 중..."
    check_env

    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="$BACKUP_DIR/backup_$TIMESTAMP.db"
    DATA_DIR="${DATA_PATH:-$APP_DIR/data}"
    SOURCE_DB="$DATA_DIR/$DB_FILE"

    # 호스트 디렉토리에서 직접 복사
    if [ -f "$SOURCE_DB" ]; then
        cp "$SOURCE_DB" "$BACKUP_FILE"
    else
        log_error "데이터베이스 파일을 찾을 수 없습니다: $SOURCE_DB"
        return 1
    fi

    if [ $? -eq 0 ] && [ -f "$BACKUP_FILE" ]; then
        gzip "$BACKUP_FILE"
        log_success "백업 완료: ${BACKUP_FILE}.gz"

        # 30일 이상 된 백업 삭제
        find "$BACKUP_DIR" -name "backup_*.db.gz" -mtime +30 -delete 2>/dev/null || true
        log_info "30일 이상 된 백업 파일을 삭제했습니다."
    else
        rm -f "$BACKUP_FILE"
        log_error "백업에 실패했습니다."
        return 1
    fi
}

# 데이터베이스 복원 (SQLite)
restore() {
    if [ -z "$2" ]; then
        log_error "복원할 백업 파일을 지정해주세요."
        echo "사용법: $0 restore <backup_file.db.gz>"
        echo ""
        echo "사용 가능한 백업 파일:"
        ls -la "$BACKUP_DIR"/*.db.gz 2>/dev/null || echo "백업 파일이 없습니다."
        exit 1
    fi

    RESTORE_FILE="$2"

    if [ ! -f "$RESTORE_FILE" ]; then
        log_error "백업 파일을 찾을 수 없습니다: $RESTORE_FILE"
        exit 1
    fi

    log_warning "이 작업은 현재 데이터베이스를 덮어씁니다!"
    read -p "계속하시겠습니까? (y/N): " confirm

    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        log_info "복원이 취소되었습니다."
        exit 0
    fi

    check_env
    log_info "데이터베이스 복원 중..."

    # 앱 중지
    log_info "앱을 중지합니다..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" stop app 2>/dev/null || true

    # 압축 해제 후 복원
    DATA_DIR="${DATA_PATH:-$APP_DIR/data}"
    TEMP_FILE="/tmp/restore_${DB_FILE}"
    gunzip -c "$RESTORE_FILE" > "$TEMP_FILE"

    # 호스트 디렉토리에 복원
    cp "$TEMP_FILE" "$DATA_DIR/$DB_FILE"
    rm -f "$TEMP_FILE"

    if [ $? -eq 0 ]; then
        log_success "복원이 완료되었습니다."

        # 앱 재시작
        log_info "앱을 재시작합니다..."
        docker-compose -f "$DOCKER_COMPOSE_FILE" start app
    else
        log_error "복원에 실패했습니다."
        exit 1
    fi
}

# Prisma 마이그레이션
migrate() {
    log_info "Prisma 마이그레이션 실행 중..."
    docker-compose -f "$DOCKER_COMPOSE_FILE" exec app npx prisma migrate deploy

    if [ $? -eq 0 ]; then
        log_success "마이그레이션이 완료되었습니다."
    else
        log_error "마이그레이션에 실패했습니다."
        exit 1
    fi
}

# ==================== GHCR 관련 함수 ====================

# GHCR 로그인 상태 확인
check_ghcr_login() {
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

    echo -e "${YELLOW}토큰을 입력하세요 (write:packages 권한 필요):${NC}"
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

# Docker Buildx 빌더 설정
setup_buildx() {
    BUILDER_NAME="multiarch-builder"

    # 빌더 존재 여부 확인
    if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
        log_info "멀티플랫폼 빌더 생성 중..."
        docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap
    fi

    docker buildx use "$BUILDER_NAME"
    log_success "Buildx 빌더 설정 완료: $BUILDER_NAME"
}

# GHCR 멀티플랫폼 빌드 및 푸시
ghcr_build() {
    local tag="${1:-$IMAGE_TAG}"
    local platforms="linux/amd64,linux/arm64"

    log_info "GHCR 멀티플랫폼 이미지 빌드 중..."
    log_info "태그: $tag"
    log_info "플랫폼: $platforms"
    check_env

    # 빌더 설정
    setup_buildx

    # 태그 설정
    local FULL_TAG="$IMAGE_NAME:$tag"
    local LATEST_TAG="$IMAGE_NAME:latest"

    log_info "빌드 태그: $FULL_TAG"

    # 멀티플랫폼 빌드 (linux/amd64 + linux/arm64)
    docker buildx build \
        --platform "$platforms" \
        -t "$FULL_TAG" \
        -t "$LATEST_TAG" \
        --push \
        "$APP_DIR"

    if [ $? -eq 0 ]; then
        log_success "빌드 및 푸시 완료"
        log_info "이미지: $FULL_TAG"
        log_info "이미지: $LATEST_TAG"
    else
        log_error "빌드 실패"
        exit 1
    fi
}

# GHCR 이미지 푸시 (로컬 빌드 후)
ghcr_push() {
    local tag="${1:-$IMAGE_TAG}"

    log_info "GHCR에 이미지 푸시 중..."
    log_info "태그: $tag"

    ghcr_login
    ghcr_build "$tag"

    echo ""
    log_info "NAS에서 배포하려면:"
    echo "  IMAGE_TAG=${tag} ./deploy.sh update"
}

# ==================== 도움말 ====================

show_help() {
    echo ""
    echo "=========================================="
    echo "  RetireFarm Manager 관리 스크립트"
    echo "=========================================="
    echo ""
    echo "사용법: $0 [명령어]"
    echo ""
    echo -e "${BLUE}=== 로컬 개발 (Docker) ===${NC}"
    echo "  deploy [no-cache]     - 전체 배포 (빌드 + 실행)"
    echo "  start                 - 애플리케이션 시작"
    echo "  stop                  - 애플리케이션 중지"
    echo "  restart               - 애플리케이션 재시작"
    echo "  status                - 상태 확인"
    echo "  logs [service]        - 로그 보기 (실시간)"
    echo "  build [no-cache]      - Docker 이미지 빌드"
    echo "  dev:update [no-cache] - 빌드 + 재시작 (로컬 수정 테스트용)"
    echo "  health                - 애플리케이션 헬스체크"
    echo ""
    echo -e "${BLUE}=== 데이터베이스 ===${NC}"
    echo "  backup                - 데이터베이스 백업 (SQLite)"
    echo "  restore <file>        - 데이터베이스 복원"
    echo "  migrate               - Prisma 마이그레이션 실행"
    echo ""
    echo -e "${BLUE}=== 유지보수 ===${NC}"
    echo "  shell                 - 컨테이너 셸 접속"
    echo "  cleanup               - Docker 리소스 정리 (볼륨 유지)"
    echo "  clean                 - 컨테이너 및 볼륨 정리"
    echo ""
    echo -e "${BLUE}=== GHCR 배포 (로컬 → NAS) ===${NC}"
    echo "  ghcr:login            - GHCR에 로그인"
    echo "  ghcr:push [tag]       - 멀티플랫폼 이미지 빌드 및 GHCR에 푸시"
    echo ""
    echo -e "${YELLOW}환경 변수:${NC}"
    echo "  GHCR_USERNAME  - GitHub Username (기본: hyunjoonkwak)"
    echo "  IMAGE_TAG      - 이미지 태그 (기본: latest)"
    echo "  DATA_PATH      - 데이터 디렉토리 경로 (기본: ./data)"
    echo ""
    echo -e "${YELLOW}예시 (로컬 개발):${NC}"
    echo "  $0 deploy               # 처음 배포"
    echo "  $0 dev:update           # 로컬 수정 후 빌드 + 재시작"
    echo "  $0 dev:update no-cache  # 캐시 없이 빌드 + 재시작"
    echo "  $0 logs                 # 전체 로그 확인"
    echo "  $0 logs app             # app 서비스 로그만 확인"
    echo ""
    echo -e "${YELLOW}예시 (GHCR 배포):${NC}"
    echo "  $0 ghcr:push            # GHCR에 이미지 푸시 (latest)"
    echo "  $0 ghcr:push v1.0.0     # 특정 태그로 푸시"
    echo ""
}

# ==================== 메인 ====================

case "$1" in
    # 로컬 개발 (Docker)
    deploy)
        deploy "$2"
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
        logs "$2"
        ;;
    build)
        build "$2"
        ;;
    dev:update)
        dev_update "$2"
        ;;
    healthcheck|health)
        healthcheck 10 3
        ;;
    # 데이터베이스
    backup)
        backup
        ;;
    restore)
        restore "$@"
        ;;
    migrate)
        migrate
        ;;
    # 유지보수
    shell)
        shell
        ;;
    cleanup)
        cleanup
        ;;
    clean)
        clean
        ;;
    # GHCR
    ghcr:login)
        ghcr_login
        ;;
    ghcr:push)
        ghcr_push "$2"
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

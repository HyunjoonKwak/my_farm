# GHCR 배포 가이드

RetireFarm Manager는 GitHub Container Registry (GHCR)를 사용하여 배포합니다.
로컬에서 빌드하고 GHCR에 푸시한 후, NAS에서는 이미지만 pull하여 실행합니다.

## 아키텍처

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────┐
│   로컬 Mac      │     │    GHCR     │     │    NAS      │
│   (빌드 머신)    │────▶│  (이미지)    │────▶│  (배포)     │
│                 │push │             │pull │             │
│  - 소스 코드     │     │  - 이미지    │     │  - 컨테이너  │
│  - Docker Buildx│     │  - 태그      │     │  - 볼륨      │
└─────────────────┘     └─────────────┘     └─────────────┘
```

## 사전 준비

### 1. GitHub Personal Access Token 생성

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token (classic) 클릭
3. 권한 선택:
   - `write:packages` - 패키지 업로드
   - `read:packages` - 패키지 다운로드
   - `delete:packages` - 패키지 삭제 (선택)
4. 토큰 복사하여 안전하게 보관

### 2. 환경 변수 설정

`.env` 파일에 추가:

```bash
# GHCR 설정
GHCR_TOKEN=ghp_xxxxxxxxxxxx  # GitHub Personal Access Token
GHCR_USERNAME=hyunjoonkwak   # GitHub 사용자명

# 앱 설정
NEXTAUTH_SECRET=your-secret-key
NEXTAUTH_URL=http://nas-ip:3024
KAMIS_API_KEY=your-kamis-key
KAMIS_API_ID=your-kamis-id
MY_PORTAL_API_URL=http://nas-ip:3022/api
NEXT_PUBLIC_MY_PORTAL_URL=http://nas-ip:3022
```

## 로컬에서 빌드 및 푸시

### 방법 1: manage.sh 사용 (권장)

```bash
# GHCR 로그인
./manage.sh ghcr:login

# 멀티플랫폼 이미지 빌드 및 푸시
./manage.sh ghcr:push

# 특정 태그로 푸시
IMAGE_TAG=v1.0.0 ./manage.sh ghcr:push
```

### 방법 2: 수동 명령어

```bash
# GHCR 로그인
echo $GHCR_TOKEN | docker login ghcr.io -u $GHCR_USERNAME --password-stdin

# Buildx 빌더 설정
docker buildx create --name multiarch-builder --driver docker-container --bootstrap
docker buildx use multiarch-builder

# 멀티플랫폼 빌드 및 푸시
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/hyunjoonkwak/my-farm:latest \
  -t ghcr.io/hyunjoonkwak/my-farm:v1.0.0 \
  --push \
  .
```

## NAS 배포

### 초기 설치

NAS에 필요한 파일만 복사:

```
/volume1/docker/my-farm/
├── docker-compose.prod.yml
├── deploy.sh
├── .env
└── backups/
```

```bash
# NAS에서 실행
cd /volume1/docker/my-farm

# 초기 배포 (로그인 + pull + 시작)
./deploy.sh deploy
```

### 업데이트

```bash
# 최신 이미지로 업데이트 (자동 백업 포함)
./deploy.sh update

# 특정 버전으로 업데이트
IMAGE_TAG=v1.0.0 ./deploy.sh update
```

### 기타 명령어

```bash
# 상태 확인
./deploy.sh status

# 로그 보기
./deploy.sh logs

# 재시작
./deploy.sh restart

# 백업
./deploy.sh backup

# 이미지 정리
./deploy.sh clean
```

## 파일 구조

### 로컬 (개발용)

```
my-farm/
├── src/                    # 소스 코드
├── prisma/                 # Prisma 스키마
├── Dockerfile              # 빌드 설정
├── docker-compose.yml      # 로컬 개발용
├── docker-compose.prod.yml # GHCR 이미지용
├── manage.sh              # 로컬 관리 스크립트
├── deploy.sh              # NAS 배포 스크립트
└── .env                   # 환경 변수
```

### NAS (배포용)

```
my-farm/
├── docker-compose.prod.yml  # GHCR 이미지 설정
├── deploy.sh               # 배포 스크립트
├── .env                    # 환경 변수
└── backups/                # 백업 파일
```

## 이미지 정보

- **이미지 이름**: `ghcr.io/hyunjoonkwak/my-farm`
- **플랫폼**: `linux/amd64`, `linux/arm64`
- **태그 규칙**:
  - `latest` - 최신 버전
  - `v1.0.0` - 특정 버전

## 트러블슈팅

### GHCR 로그인 실패

```bash
# 토큰 권한 확인 (write:packages 필수)
# 토큰 만료 확인

# 수동 로그인 테스트
echo $GHCR_TOKEN | docker login ghcr.io -u $GHCR_USERNAME --password-stdin
```

### 이미지 pull 실패

```bash
# NAS에서 GHCR 로그인 상태 확인
./deploy.sh login

# 이미지 존재 여부 확인
docker pull ghcr.io/hyunjoonkwak/my-farm:latest
```

### 빌드 실패

```bash
# Buildx 빌더 확인
docker buildx ls

# 빌더 재생성
docker buildx rm multiarch-builder
docker buildx create --name multiarch-builder --driver docker-container --bootstrap
```

## 권장 워크플로우

1. **개발**: 로컬에서 `docker-compose.yml`로 개발
2. **빌드**: `./manage.sh ghcr:push`로 GHCR에 푸시
3. **배포**: NAS에서 `./deploy.sh update`로 업데이트
4. **백업**: 정기적으로 `./deploy.sh backup` 실행

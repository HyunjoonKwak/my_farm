# 브리핑 워커 설치·운영 가이드 (Mac, Codex CLI)

`scripts/briefing-worker.mjs`는 앱 서버에서 브리핑 작업 하나를 받아, 이 Mac에 이미 로그인된 ChatGPT 계정의 Codex CLI로 초안 JSON을 만들고, 검증한 뒤 서버에 돌려주는 **일회 실행** 스크립트입니다. 서버 측 계약은 `docs/briefing-worker-contract.md`가 기준이며, 이 문서는 워커 쪽 설치·실행·한계만 다룹니다.

## 1. 전제 조건

| 항목 | 요구사항 | 확인 방법 |
| --- | --- | --- |
| Node.js | 20 이상 (개발·검증은 v22) | `node --version` |
| Codex CLI | `exec --strict-config --ignore-user-config --ignore-rules --ephemeral --output-schema --output-last-message` 지원 버전 (검증: codex-cli 0.154.0) | `codex --version`, `codex exec --help` |
| Codex 인증 | **ChatGPT 로그인**만 허용. API 키 로그인이면 워커가 작업을 받지 않고 종료 | `codex login status` 출력이 `Logged in using ChatGPT` |
| 저장소 의존성 | `zod` (프로젝트 `node_modules`) | 저장소 루트에서 `npm ci` 완료 |
| 서버 | HTTPS 주소. `http://`는 `localhost`·`127.0.0.1`·`[::1]`만 허용 | 앱 URL |

저장소에 의존성을 설치하고 스크립트와 `node_modules`의 상대 위치를 유지하세요. 아래 예시는 프로젝트 루트에서 실행합니다.

## 2. 워커 토큰 파일 설치

앱의 리포트 → 주간 브리핑 → Mac 워커 연결에서 본인 토큰을 발급·다운로드합니다. 토큰은 `rfw_` + 16진수 64자 한 줄이며, 워커는 이 형식만 받아들입니다.

```sh
mkdir -p ~/.config/retirefarm
mv ~/Downloads/retirefarm-worker-token.txt ~/.config/retirefarm/briefing-worker.token
chmod 600 ~/.config/retirefarm/briefing-worker.token
```

워커가 거부하는 경우:

- 파일 권한에 group/other 읽기 비트가 있으면 (예: 644) `chmod 600` 오류로 종료 코드 2
- 심볼릭 링크, 여러 줄, 형식 불일치, 4KiB 초과 파일
- 토큰을 환경변수로 직접 넘기는 방식은 지원하지 않습니다 (프로세스 목록·셸 이력 노출 방지)

토큰을 다시 발급했다면 파일 내용만 교체하면 됩니다. 이전 토큰 파일은 삭제하십시오.

## 3. 환경변수

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `BRIEFING_SERVER_URL` | 예 | 앱 기본 주소. 예: `https://farm.example.com`. 경로 `/api/briefing-worker`는 워커가 붙입니다. 사용자정보·쿼리·프래그먼트 포함 불가 |
| `BRIEFING_WORKER_TOKEN_FILE` | 예 | 위에서 만든 토큰 파일 경로 |
| `BRIEFING_CODEX_BIN` | 아니오 | `codex` 실행 파일 경로. 기본값 `codex` (PATH 탐색) |

`OPENAI_API_KEY` 등 다른 변수는 워커 동작에 쓰이지 않고, Codex 자식 프로세스에도 전달되지 않습니다.

## 4. 실행

```sh
cd /path/to/my_farm
BRIEFING_SERVER_URL=https://farm.example.com \
BRIEFING_WORKER_TOKEN_FILE=$HOME/.config/retirefarm/briefing-worker.token \
node scripts/briefing-worker.mjs --once
```

`--once`만 지원합니다. 반복 실행·예약(launchd, cron)은 이 저장소에 포함하지 않으며, 운영 주체가 확인한 뒤 별도로 설정합니다. 한 번 실행하면 작업 최대 1개를 처리하고 종료합니다.

### 종료 코드

| 코드 | 의미 | 조치 |
| --- | --- | --- |
| 0 | 작업 완료 또는 대기 작업 없음 | 없음 |
| 1 | 작업 실패(서버에 fail 보고됨) 또는 claim 실패·lease 상실 | stderr 로그의 `code`/`reason` 확인 |
| 2 | 인자·환경변수·토큰 파일 문제 | 설정 수정 |
| 3 | Codex 사전 점검 실패 (플래그 미지원, 기능 스위치 미확인, ChatGPT 로그인 아님) | Codex 업데이트 또는 `codex login` 재실행 |
| 4 | 전달 미확인 또는 로컬 복구 상태 점검 필요 | 아래 복구 안내 확인. 새 AI 호출은 하지 않음 |

### 로그

stderr에 JSON 한 줄씩 기록합니다. 워커 토큰, lease 토큰, 서버 URL, 요청·응답 본문, 모델 출력, Codex 오류 원문은 절대 기록하지 않습니다. 기록되는 값은 고정 문자열(`message`, `reason`), 서버 fail 코드, 작업 ID, HTTP 오류 종류(`kind`), 소요 시간뿐입니다.

## 5. 워커가 하는 일 (순서)

1. 환경변수·토큰 파일 검증. 토큰 파일 옆 `.state` 디렉터리에서 단독 실행 잠금을 획득하고 미전송 결과부터 확인한다. 결과가 있으면 CLI 사전 점검·claim 없이 같은 complete만 전달하고 종료한다. 서버·토큰 불일치, 손상 또는 작성 중단 기록은 종료 코드 4로 멈춘다.
2. Codex 사전 점검 (추론 호출 없음)
   - `codex exec --help`에 필수 플래그 9종이 모두 있는지
   - `codex features list --disable …`가 아래 기능을 전부 `false`로 보고하는지
   - `codex login status`가 ChatGPT 로그인인지
   하나라도 실패하면 서버에 접속하지 않고 종료 코드 3.
3. `claim` 요청. 작업이 없으면 종료 코드 0.
4. snapshot을 계약 스키마로 검증. 실패하면 Codex를 실행하지 않고 `fail(CODEX_FAILED)` 후 종료.
5. 전용 임시 디렉터리(0700)와 출력 스키마를 준비하고, 작성 중 표시를 디스크에 먼저 저장한 뒤 Codex 실행. 중간 강제 종료는 다음 실행에서 새 추론 대신 점검을 요구한다. 프롬프트는 stdin으로만 전달.
6. 실행 중 60초마다 `heartbeat`. 401/409를 받으면 Codex를 종료하고 결과를 버립니다 (complete·fail 모두 보내지 않음).
7. 종료 코드 0이고 `turn.completed` 이벤트가 있고 오류 이벤트가 없을 때만 최종 메시지를 읽어 JSON 파싱·검증.
8. 검증된 결과와 완료 요청 전체를 0600 파일에 원자적으로 저장·동기화한 후 `complete` 전송. 성공 응답(`ok:true`) 후에만 대기 파일을 지운다. 한 실행에서 최대 세 번 전송하며 401/409/400은 그 실행에서 재시도하지 않는다. 거절된 결과도 보관해 다음 실행의 새 추론을 차단한다.

### Codex 실행 격리 (실제로 적용되는 것)

```
codex exec --strict-config --ignore-user-config --ignore-rules --ephemeral --sandbox read-only --skip-git-repo-check --json \
  --output-schema <tmp>/output-schema.json --output-last-message <tmp>/last-message.json --color never -C <tmp> \
  -c web_search="disabled" -c forced_login_method="chatgpt" -c shell_environment_policy.inherit="none" \
  -c model_instructions_file='"<tmp>/report-instructions.txt"' -c project_doc_max_bytes=0 -c skills.max_context_tokens=1 \
  --disable shell_tool --disable unified_exec_tty --disable view_image --disable sleep_tool --disable tool_suggest \
  --disable goals --disable memories --disable skill_search --disable skill_mcp_dependency_install --disable workspace_dependencies \
  --disable apps --disable plugins --disable remote_plugin --disable hooks --disable browser_use --disable computer_use \
  --disable multi_agent --disable image_generation --disable in_app_browser --disable in_app_local_automation --disable code_mode_host -
```

- `--ignore-user-config`: `~/.codex/config.toml`을 읽지 않으므로 거기에 정의된 MCP 서버(예: `node_repl`, `computer-use`)·플러그인 설정이 로드되지 않습니다. 인증 정보는 그대로 `CODEX_HOME`에서 사용합니다.
- 작업 디렉터리는 빈 임시 폴더이므로 프로젝트 `.codex/` 설정·`AGENTS.md`·`.rules`가 없습니다.
- 자식 프로세스 환경변수는 `PATH HOME TMPDIR LANG LC_ALL LC_CTYPE TERM USER LOGNAME SHELL CODEX_HOME SSL_CERT_FILE SSL_CERT_DIR` allowlist + `NO_COLOR=1`뿐입니다. 워커 토큰, 서버 URL, `OPENAI_API_KEY`, 앱 `DATABASE_URL` 등은 전달되지 않습니다.
- 프롬프트에는 snapshot JSON과 작성 규칙만 들어갑니다. 운영 URL·토큰·DB 경로는 포함되지 않습니다.
- 보고서 전용 짧은 기본 지침을 사용하고 AGENTS 문서·스킬 카탈로그의 불필요한 문맥을 제한합니다. 개인 설정 파일을 수정하지 않고 실행별 옵션으로 적용합니다.
- CLI가 위 플래그나 기능 스위치를 지원하지 않으면 느슨한 명령으로 우회하지 않고 종료 코드 3으로 실패합니다.

## 6. 재전송과 중단 복구 (종료 코드 4)

기본 저장 위치는 `<BRIEFING_WORKER_TOKEN_FILE>.state/`(0700)이며 `pending.json`(0600)에 결과와 작업 식별 정보를 보관한다. 토큰 원문은 저장하지 않는다. 경로를 다른 곳으로 바꾸거나 토큰 파일을 복제하면 기존 상태를 자동으로 찾지 못하므로 한 Mac에서는 같은 토큰 파일 경로를 유지한다.

- **완료 응답 유실**: 같은 설정으로 `--once`를 실행하면 저장된 complete만 최대 세 번 전송한다. 성공해도 그 실행에서 다른 작업은 가져오지 않는다. Codex 로그인 점검·추론 호출도 없다.
- **lease 만료**: 서버에서 해당 작업이 아직 같은 워커/lease의 RUNNING이면 늦게 도착한 완료를 수락한다. 다른 워커가 새 lease를 점유했거나 토큰 회전·폐기·작업 재시도가 발생했으면 기존 완료는 거절한다. 이미 성공한 동일 결과는 멱등 응답한다.
- **401/409/400 또는 서버/토큰 변경**: 대기 파일을 보존한다. 앱의 작업 상태와 현재 연결을 확인하고 해당 결과를 사람이 처리하기 전까지 새 작업을 실행하지 않는다. 토큰 회전 전에 가능한 경우 먼저 대기 결과를 전달한다.
- **강제 종료·작성 중단·파일 손상**: 자동 재생성하지 않는다. `pending.json`의 phase, 앱 상태, 로그의 임시 `workDir`를 확인한다. `worker.lock`에 PID가 남으면 같은 Mac에서 그 프로세스가 실제 종료됐는지 확인한 뒤 잠금만 정리한다. 파일 나이만으로 살아 있는 워커의 잠금을 삭제하지 않는다.
- **수동 정리**: 해당 작업이 이미 완료됐거나 결과를 폐기하고 재시도하기로 확정한 경우에만 관련 `pending.json`/`pending.next`를 비공개 보관 위치로 이동한다. RUNNING 작업의 lease를 임의로 덮어쓰지 않는다. 정리 후 다음 실행에서 AI가 호출될 수 있음을 감안한다.

전달이 불명확하면 임시 디렉터리도 보존하고 `workDir` 경로를 로그에 남긴다. 복구 후 남은 임시 파일은 운영자가 확인해서 정리한다. 이전 버전이 남긴 `undelivered-result.json`은 작업·lease 정보가 없어 자동 가져오지 않는다.

## 7. 검증 방법 (실제 모델 호출 없음)

```sh
npx vitest run src/__tests__/briefing/worker.test.ts
```

테스트는 `fetch`와 `child_process.spawn`을 모두 mock으로 대체합니다. 실제 서버·Codex·ChatGPT 계정·네트워크를 사용하지 않고, 인증 파일을 읽거나 복사하지 않습니다. 다루는 시나리오: 설정 검증, API 키 로그인 거부, 격리 플래그·기능 스위치 미확인 거부, 정상 완료(usage 포함), 작업 없음, 결과 스키마 위반(숫자·섹션 수·ID 참조·추가 속성), 종료 코드 0이지만 `turn.failed`, 시간 초과, 출력 상한 초과, heartbeat 409 중단, complete 재전송·전달 불명확, fail 1회 전송, 401/409 비재전송, 리다이렉트 비추적, 과대 응답, 비밀 누출 없음.

## 8. 알려진 한계

- **도구 격리는 CLI가 보고하는 범위까지만 검증합니다.** `codex features list`가 각 기능을 `false`로 보고하는지와 read-only 샌드박스·`--ignore-user-config`까지가 워커가 확인하는 전부입니다. `unified_exec` 기능은 codex-cli 0.154.0에서 `--disable`로 꺼지지 않고(항상 `true` 보고) 워커도 이를 요구하지 않습니다. 실제 실행 시 모델에 어떤 도구가 노출되는지는 추론 없이 확인할 수 없으므로, 첫 운영 실행 후 Codex 세션 로그 없이(`--ephemeral`) 동작하는 점을 감안해 서버 결과만으로 판단해야 합니다.
- 설정 키 변경을 조용히 무시하지 않도록 `--strict-config`를 적용합니다. 웹 검색과 인증 고정은 공식 `web_search="disabled"`, `forced_login_method="chatgpt"` 설정을 사용합니다. [공식 설정 문서](https://learn.chatgpt.com/docs/config-file/config-reference)
- `codex login status`의 문구(`Logged in using ChatGPT`)에 의존합니다. 문구가 바뀌면 워커는 `UNKNOWN`으로 판정하고 종료 코드 3으로 멈춥니다(작업을 받지 않음).
- HTTPS 프록시 환경변수(`HTTPS_PROXY` 등)는 Codex 자식 프로세스에 전달하지 않습니다. 프록시가 필수인 네트워크에서는 Codex 자체 설정으로 처리해야 합니다.
- snapshot 검증 실패는 계약에 전용 fail 코드가 없어 `CODEX_FAILED`로 보고합니다. 로그의 `message`가 `snapshot rejected by worker schema`이면 서버 측 입력 문제입니다.
- 단위 테스트와 별도로 2026-09-14 실제 ChatGPT 로그인 CLI로 가상 자료 생성 두 회를 확인했습니다. 아래 검증 기록 참고. 운영 NAS 연결과 제한된 실자료 초안 한 건도 확인했습니다. 자세한 범위는 [배포 검증 기록](reviews/2026-09-14-briefing-deployment.md)을 참고하세요. 전체 보고서 품질 검증을 대신하지 않습니다.
- 예약 실행, 다중 작업 처리, AI 재실행 루프는 포함하지 않았습니다. 같은 토큰 파일을 사용하는 단일 Mac의 로컬 복구를 제공하며 여러 Mac의 동시 운영·자동 잠금 회수는 지원하지 않습니다.

## 9. 실제 로그인 CLI 연결 검증 (2026-09-14)

Codex 인증은 기존 ChatGPT 로그인을 사용했다. 서버 HTTP는 메모리 fixture로 대체하고, 네 영역·행동 세 개를 가진 실제 모델 응답이 워커 검증을 통과해 complete까지 도달하는지 확인했다. 운영 DB·실제 토큰·텔레그램은 사용하지 않았다.

| 실행 | 소요 | 입력 토큰 | 출력 토큰 | 결과 |
|---|---:|---:|---:|---|
| 기본 문맥 | 21.6초 | 21,127 | 449 | 성공 |
| 보고서 전용 지침·문맥 제한 | 21.4초 | 15,899 | 459 | 성공 |

동일한 작은 가상 자료에서 입력 토큰이 약 25% 줄었다. 이는 본 검증 결과이며 실제 큰 보고서의 사용량을 보장하는 수치는 아니다. CLI 자체 문맥 비용은 남으므로 주차별 입력 중복 방지·한 작업씩 실행·본문 길이 제한·완료 결과 재사용을 함께 사용한다. 이 표는 Codex가 보고한 토큰 수이며 별도 API 청구 금액이 아니다.

## 10. 운영 연결 검증

2026-09-14 NAS 배포 후 HTTPS 서버와 이 Mac을 연결했다. 토마토(적색)·전라북도 장수군의 지난 완결 주 자료로 한 번 생성해 SUCCEEDED/DRAFT를 확인했다. 소요 37.8초, 입력 17,163 / 출력 894 / 캐시 0 토큰이다. 동일 입력을 다시 요청해도 작업은 한 건·시도 한 번으로 유지됐으며 워커는 추가 AI 호출 없이 종료했다.

이 Mac에는 비공개 토큰 파일과 수동 실행기 `~/.config/retirefarm/run-briefing-worker.command`를 설치했다. 실행기는 현재 저장소와 Node/Codex 설치 경로를 참조하므로 경로 변경 시 갱신한다. 예약은 등록하지 않았다.

후속 보강으로 디스크 대기 결과의 재전송을 추가했다. 같은 설정으로 다음 실행 시 저장 결과를 먼저 전달하고 새 추론은 시작하지 않는다. 복구 불가능한 충돌·중단은 §6에 따라 점검한다.

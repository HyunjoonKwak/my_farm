/**
 * Next.js Instrumentation
 * 서버 시작 시 실행되는 초기화 코드 (시세 자동 수집 스케줄러 로드)
 *
 * 위치가 중요하다: 앱이 src/app에 있으면 Next는 src/ 에서만 이 파일을 찾는다
 * (next/dist/build/index.js의 rootDir = appDir/.. 스캔). 루트에 두면 hasInstrumentationHook이
 * false가 되어 standalone 출력에 server/instrumentation.js가 복사되지 않고, 운영 서버는
 * register()를 조용히 건너뛴다 (2026-07-22 이후 자동 수집 중단 원인). 회귀 테스트:
 * src/__tests__/instrumentation.test.ts
 */

export async function register() {
  // 빌드 시에는 실행하지 않음 (DB 연결 불가)
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  // 서버 환경에서만 실행
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMarketRecoveryScheduler } = await import("@/lib/market-recovery-scheduler");
    startMarketRecoveryScheduler();
    try {
      const { startBackupScheduler } = await import("@/lib/backup/scheduler");
      startBackupScheduler();
    } catch (error) {
      console.error("[Instrumentation] Failed to initialize backup scheduler:", error);
    }
    try {
      // 텔레그램 시세 봇 명령 수신 (TELEGRAM_TOKEN/CHAT_ID 없으면 시작하지 않음)
      const { startTelegramBot } = await import("@/lib/telegram-bot");
      startTelegramBot();
    } catch (error) {
      console.error("[Instrumentation] Failed to start Telegram bot:", error);
    }
    try {
      const { loadAllSchedules } = await import("@/lib/scheduler");
      const { logger } = await import("@/lib/logger");
      const count = await loadAllSchedules();
      logger.info(`[Instrumentation] Scheduler initialized: ${count} schedule(s)`);
    } catch (error) {
      console.error("[Instrumentation] Failed to initialize schedulers:", error);
    }
  }
}

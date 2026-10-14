/**
 * 시세 데이터 자동 수집 스케줄러
 * node-cron 기반 자동 수집 관리
 */

import cron, { ScheduledTask } from "node-cron";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  collectAndSaveAuctionData,
  cleanupOldAuctionData,
} from "@/lib/services/garak-market";
import { maybeSendDailyDigest } from "@/lib/services/market-digest";
import { marketDateKey } from "@/lib/market-date";

// instrumentation과 라우트가 별도 번들로 로드되어도 같은 프로세스 상태를 공유한다.
interface MarketSchedulerState {
  jobs: Map<string, ScheduledTask>;
  running: Set<string>;
  expected: Set<string>;
  expressions: Map<string, string>;
  /** loadAllSchedules가 한 번이라도 끝까지 실행됐는지 */
  initialized: boolean;
  /** 마지막 로드 시각 (ISO) */
  lastLoadAt: string | null;
  /** 마지막 로드가 설정 수만큼 모두 등록했는지 (실패·부분 등록이면 false) */
  lastLoadOk: boolean | null;
  lastError: string | null;
}
const shared = globalThis as typeof globalThis & { marketSchedulerState?: MarketSchedulerState };
const state = shared.marketSchedulerState ??= {
  jobs: new Map<string, ScheduledTask>(), running: new Set<string>(), expected: new Set<string>(), initialized: false,
  lastLoadAt: null, lastLoadOk: null, lastError: null,
  expressions: new Map<string, string>(),
};
// 핫 리로드로 이전 형태의 상태가 남아 있을 때 새 진단 필드를 채운다
state.lastLoadAt ??= null;
state.lastLoadOk ??= null;
state.lastError ??= null;
state.expressions ??= new Map<string, string>();
const activeCronJobs = state.jobs;
const runningSettings = state.running;

/**
 * 진단 상태. ID·설정 값은 포함하지 않는다 (health 등 공개 응답에서도 안전).
 * ready = 로드가 끝났고(initialized) 마지막 로드가 완전 성공했으며 등록 job 수가 기대 수와 같다.
 */
export function getSchedulerStatus() {
  const activeCount = activeCronJobs.size;
  const expectedCount = state.expected.size;
  return {
    initialized: state.initialized,
    activeCount,
    expectedCount,
    runningCount: runningSettings.size,
    lastLoadAt: state.lastLoadAt,
    lastLoadOk: state.lastLoadOk,
    lastError: state.lastError,
    ready: state.initialized && state.lastLoadOk === true && activeCount === expectedCount,
  };
}

export function isMarketSchedulerReady(): boolean {
  return getSchedulerStatus().ready;
}

export function isCollectionRunning(settingsId: string): boolean {
  return runningSettings.has(settingsId);
}

/**
 * 수집 시간(HH:mm)을 cron 표현식으로 변환
 * @param collectTime 수집 시간 (HH:mm 형식)
 * @param collectDays 수집 요일 문자열 (쉼표 구분, 0=일, 6=토)
 */
function toCronExpression(collectTime: string, collectDays: string): string {
  const [hour, minute] = collectTime.split(":").map(Number);
  const days = collectDays || "*";
  return `${minute} ${hour} * * ${days}`;
}

/**
 * 다음 실행 시간 계산 (서버 로컬 기준)
 */
export function getNextRunTime(
  collectTime: string,
  collectDays: string
): Date | null {
  try {
    const [hours, minutes] = collectTime.split(":").map(Number);
    const daysArray = collectDays.split(",").filter(Boolean).map(Number);

    if (daysArray.length === 0) return null;

    const now = new Date();

    for (let i = 0; i <= 7; i++) {
      const targetDate = new Date(now);
      targetDate.setDate(now.getDate() + i);
      targetDate.setHours(hours, minutes, 0, 0);

      if (daysArray.includes(targetDate.getDay()) && targetDate > now) {
        return targetDate;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 수집 실행 함수
 * 수집 자체의 성공/실패 로그는 collectAndSaveAuctionData가 법인별로 기록하므로
 * 여기서는 별도 SUCCESS 로그를 남기지 않는다 (이중 기록 방지).
 */
async function executeCollection(settingsId: string) {
  if (runningSettings.has(settingsId)) {
    logger.warn(`[Scheduler] 이전 수집이 아직 실행 중이라 건너뜁니다: ${settingsId}`);
    return;
  }
  runningSettings.add(settingsId);
  try {
    await executeCollectionInner(settingsId);
  } finally {
    runningSettings.delete(settingsId);
  }
}

async function executeCollectionInner(settingsId: string) {
  const settings = await prisma.marketCollectionSettings.findUnique({
    where: { id: settingsId },
  });

  if (!settings) {
    logger.error(`[Scheduler] Settings not found: ${settingsId}`);
    return;
  }

  if (!settings.autoCollectEnabled) {
    logger.info(`[Scheduler] Auto collection disabled: ${settingsId}`);
    return;
  }

  try {
    const startedAt = new Date();
    const targetDate = new Date(startedAt);
    targetDate.setDate(targetDate.getDate() - settings.collectDaysAgo);

    const corporationCodes = settings.corporationCodes
      .split(",")
      .filter(Boolean);

    // collectAndSaveAuctionData가 쉼표 구분 다품목을 내부에서 분리 처리함
    const result = await collectAndSaveAuctionData(
      targetDate,
      corporationCodes,
      settings.targetProducts || undefined
    );

    logger.info(
      `[Scheduler] Collection done (${settingsId}): status=${result.status}, total=${result.totalCount}, new=${result.newCount}`
    );

    if (!result.complete) {
      logger.warn(
        `[Scheduler] 수집이 완전하지 않아 정리(cleanup)를 건너뜁니다 (${settingsId}): ${result.issues.join(" | ") || result.status}`
      );
    } else {
      if (settings.autoCleanupEnabled) await cleanupOldAuctionData();
      // 수집이 자정을 넘겨도 수집 시작 시각 기준으로 대상 날짜를 판정한다
      await maybeSendDailyDigest(settings, marketDateKey(targetDate), startedAt);
    }
  } catch (error) {
    logger.error(`[Scheduler] Collection failed (${settingsId}):`, error);

    await prisma.dataCollectionLog.create({
      data: {
        targetDate: new Date(),
        corporation: settings.corporationCodes,
        targetProducts: settings.targetProducts || null,
        totalCount: 0,
        newCount: 0,
        duplicateCount: 0,
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
  }
}

/**
 * 스케줄 등록
 */
export function registerSchedule(
  settingsId: string,
  collectTime: string,
  collectDays: string
): boolean {
  state.expected.add(settingsId);
  try {
    const cronExpr = toCronExpression(collectTime, collectDays);
    const currentJob = activeCronJobs.get(settingsId);
    const currentStatus = currentJob?.getStatus?.();
    if (currentJob && state.expressions.get(settingsId) === cronExpr
      && (typeof currentStatus !== "string" || !["stopped", "destroyed"].includes(currentStatus))) return true;
    if (activeCronJobs.has(settingsId)) {
      const existingJob = activeCronJobs.get(settingsId);
      existingJob?.stop();
      activeCronJobs.delete(settingsId);
    }

    if (!cron.validate(cronExpr)) {
      logger.error(`[Scheduler] Invalid cron expression: ${cronExpr}`);
      return false;
    }

    const task = cron.schedule(
      cronExpr,
      async () => {
        try { await executeCollection(settingsId); }
        catch (error) { logger.error("[Scheduler] Scheduled execution failed:", error); }
      },
      {
        timezone: "Asia/Seoul",
      }
    );

    activeCronJobs.set(settingsId, task);
    state.expressions.set(settingsId, cronExpr);
    logger.info(
      `[Scheduler] Registered ${settingsId} (${cronExpr}, KST). Active: ${activeCronJobs.size}`
    );

    return true;
  } catch (error) {
    logger.error(`[Scheduler] Failed to register ${settingsId}:`, error);
    return false;
  }
}

/**
 * 스케줄 제거
 */
export function unregisterSchedule(settingsId: string): boolean {
  try {
    state.expected.delete(settingsId);
    state.expressions.delete(settingsId);
    const job = activeCronJobs.get(settingsId);
    if (job) {
      job.stop();
      activeCronJobs.delete(settingsId);
      logger.info(`[Scheduler] Unregistered: ${settingsId}`);
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`[Scheduler] Failed to unregister ${settingsId}:`, error);
    return false;
  }
}

/**
 * 모든 cron job 정리
 */
export function clearAllSchedules(): number {
  state.initialized = false;
  state.expected.clear();
  state.expressions.clear();
  const count = activeCronJobs.size;
  if (count === 0) return 0;

  activeCronJobs.forEach((job) => {
    job.stop();
  });
  activeCronJobs.clear();
  logger.info(`[Scheduler] Cleared ${count} cron job(s)`);
  return count;
}

/**
 * 모든 활성 스케줄 로드 (서버 시작 시)
 */
export async function loadAllSchedules(): Promise<number> {
  try {
    const settings = await prisma.marketCollectionSettings.findMany({
      where: { autoCollectEnabled: true },
    });
    // 정상 작업은 유지한다. 일부 설정 오류로 매 점검마다 전체 예약을 끊지 않는다.
    const enabledIds = new Set(settings.map(setting => setting.id));
    for (const id of activeCronJobs.keys()) if (!enabledIds.has(id)) unregisterSchedule(id);
    state.expected.clear();

    let loadedCount = 0;
    for (const setting of settings) {
      const success = registerSchedule(
        setting.id,
        setting.collectTime,
        setting.collectDays
      );
      if (success) loadedCount++;
    }

    state.initialized = true;
    state.lastLoadAt = new Date().toISOString();
    state.lastLoadOk = loadedCount === settings.length;
    state.lastError = state.lastLoadOk ? null : `${settings.length - loadedCount}개 설정의 cron 등록 실패`;
    // 부팅 진단은 운영 환경에서도 한 줄 남긴다. 사용자/설정 ID는 포함하지 않는다.
    console.info(`[Scheduler] Loaded ${loadedCount}/${settings.length} schedule(s), ready=${getSchedulerStatus().ready}`);
    return loadedCount;
  } catch (error) {
    state.initialized = false;
    state.lastLoadAt = new Date().toISOString();
    state.lastLoadOk = false;
    state.lastError = error instanceof Error ? error.message : String(error);
    logger.error("[Scheduler] Failed to load schedules:", error);
    return 0;
  }
}

/**
 * 스케줄 즉시 실행 (수동 테스트용)
 */
export async function runScheduleNow(settingsId: string): Promise<boolean> {
  try {
    await executeCollection(settingsId);
    return true;
  } catch (error) {
    logger.error(`[Scheduler] Failed to run ${settingsId}:`, error);
    return false;
  }
}

/**
 * 활성 스케줄 목록 조회
 */
export function getActiveSchedules(): string[] {
  return Array.from(activeCronJobs.keys());
}

/**
 * 스케줄 설정 변경 시 재등록
 */
export async function updateSchedule(settingsId: string): Promise<boolean> {
  try {
    const setting = await prisma.marketCollectionSettings.findUnique({
      where: { id: settingsId },
    });

    if (!setting) {
      unregisterSchedule(settingsId);
      return false;
    }

    if (!setting.autoCollectEnabled) {
      unregisterSchedule(settingsId);
      return true;
    }

    return registerSchedule(settingsId, setting.collectTime, setting.collectDays);
  } catch (error) {
    logger.error(`[Scheduler] Failed to update ${settingsId}:`, error);
    return false;
  }
}

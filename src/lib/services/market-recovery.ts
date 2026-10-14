import { randomUUID } from "node:crypto";
import type { MarketCollectionSettings, MarketRecoveryJob } from "@prisma/client";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { collectAndSaveAuctionData } from "./garak-market";
import { maybeSendDailyDigest } from "./market-digest";
import { getSchedulerStatus, isCollectionRunning, loadAllSchedules } from "@/lib/scheduler";
import { canonicalList, completedDateStatus, dueRecoveryDates, kstDateStart, recoveryScope, RECOVERY_MAX_ATTEMPTS } from "@/lib/market-recovery-policy";

const LEASE_MS = 5 * 60000;
const MAX_JOBS_PER_PASS = 3;
const shared = globalThis as typeof globalThis & { marketRecoveryState?: { checking: boolean; lastCheckedAt: string | null; lastCheckOk: boolean | null; lastHeartbeatAt: string | null } };
const state = shared.marketRecoveryState ??= { checking: false, lastCheckedAt: null, lastCheckOk: null, lastHeartbeatAt: null };
export function getRecoveryState() { return { ...state }; }

async function notifyFailure(job: MarketRecoveryJob, setting: MarketCollectionSettings) {
  // 알림과 알림 완료 표시는 같은 트랜잭션으로 저장한다. 다시 점검해도 한 번만 생성된다.
  await prisma.$transaction(async tx => {
    const claimed = await tx.marketRecoveryJob.updateMany({
      where: { id: job.id, notifiedAt: null, status: { in: ["FAILED", "PARTIAL"] }, attempts: { gte: RECOVERY_MAX_ATTEMPTS } },
      data: { notifiedAt: new Date() },
    });
    if (!claimed.count) return;
    await tx.notification.create({ data: {
      userId: setting.userId, type: "ERROR", title: `시세 자동 보충 확인 필요 (${job.targetDate})`,
      message: `${setting.targetProducts || "전체 품목"}의 ${job.targetDate} 자료를 3회 보충했지만 완료하지 못했습니다. 수집 탭에서 결과를 확인해 주세요.`,
      link: "/market/collect",
    } });
  });
}

/** 각 실행의 임대 갱신과 완료 기록은 토큰 소유자만 수행한다. API 호출 동안 DB 트랜잭션을 열지 않는다. */
async function executeJob(job: MarketRecoveryJob, setting: MarketCollectionSettings): Promise<boolean> {
  if (isCollectionRunning(setting.id)) return false;
  const now = new Date();
  const token = randomUUID();
  const claimed = await prisma.marketRecoveryJob.updateMany({
    where: { id: job.id, attempts: { lt: RECOVERY_MAX_ATTEMPTS }, nextAttemptAt: { lte: now },
      OR: [{ status: { in: ["PENDING", "PARTIAL", "FAILED", "CANCELLED"] } }, { status: "RUNNING", leaseUntil: { lt: now } }] },
    data: { status: "RUNNING", attempts: { increment: 1 }, leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (!claimed.count) return false;
  const heartbeat = setInterval(() => {
    void prisma.marketRecoveryJob.updateMany({ where: { id: job.id, leaseToken: token, status: "RUNNING" },
      data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => logger.error("[Market recovery] Lease renewal failed"));
  }, 30000);
  heartbeat.unref();
  try {
    // 설정을 끈 직후나 조건을 바꾼 직후에는 이전 조건으로 새 수집을 시작하지 않는다.
    const current = await prisma.marketCollectionSettings.findUnique({ where: { id: setting.id } });
    if (!current?.autoCollectEnabled || recoveryScope(current) !== job.scope) {
      await prisma.marketRecoveryJob.updateMany({ where: { id: job.id, leaseToken: token }, data: { status: "CANCELLED", attempts: { decrement: 1 }, leaseToken: null, leaseUntil: null } });
      return true;
    }
    const startedAt = new Date();
    const result = await collectAndSaveAuctionData(kstDateStart(job.targetDate), canonicalList(current.corporationCodes).split(","), current.targetProducts || undefined);
    await prisma.marketRecoveryJob.updateMany({ where: { id: job.id, leaseToken: token }, data: {
      status: result.status, leaseToken: null, leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + 60 * 60000),
      lastError: result.complete ? null : result.status === "PARTIAL"
        ? "일부 자료가 누락되었습니다. 수집 로그에서 원인과 조치를 확인해 주세요."
        : "수집에 실패했습니다. 연결 및 인증 설정과 수집 로그를 확인해 주세요.",
    } });
    // 정기 수집을 놓친 날은 보충이 끝난 뒤 요약을 보낸다 (과거 날짜는 내부에서 거른다).
    if (result.complete) await maybeSendDailyDigest(current, job.targetDate, startedAt);
  } catch {
    await prisma.marketRecoveryJob.updateMany({ where: { id: job.id, leaseToken: token }, data: {
      status: "FAILED", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + 60 * 60000),
      lastError: "자동 보충 중 오류가 발생했습니다. 수집 로그를 확인해 주세요.",
    } });
  } finally { clearInterval(heartbeat); }
  const final = await prisma.marketRecoveryJob.findUnique({ where: { id: job.id } });
  if (final && final.attempts >= RECOVERY_MAX_ATTEMPTS) await notifyFailure(final, setting);
  return true;
}

export async function checkMarketRecovery(now = new Date()): Promise<void> {
  if (state.checking) return;
  state.checking = true;
  state.lastHeartbeatAt = new Date().toISOString();
  const heartbeat = setInterval(() => { state.lastHeartbeatAt = new Date().toISOString(); }, 30000);
  heartbeat.unref();
  try {
    // 부팅 시 DB 준비 실패도 다음 점검에서 재등록한다 (무한한 즉시 재시도 없음).
    if (!getSchedulerStatus().ready) await loadAllSchedules();
    const settings = await prisma.marketCollectionSettings.findMany({ where: { autoCollectEnabled: true } });
    let executed = 0;
    for (const setting of settings) {
      const scope = recoveryScope(setting);
      const dates = dueRecoveryDates(setting, now);
      if (!dates.length) continue;
      const logs = await prisma.dataCollectionLog.findMany({
        where: { targetDate: { gte: kstDateStart(dates[dates.length - 1]) }, corporation: { in: canonicalList(setting.corporationCodes).split(",") } },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: { targetDate: true, corporation: true, targetProducts: true, status: true, startedAt: true },
      });
      for (const date of dates) {
        const key = { settingsId: setting.id, scope, targetDate: date };
        const completed = completedDateStatus(setting, date, logs);
        if (completed) {
          await prisma.marketRecoveryJob.updateMany({ where: { ...key, status: { in: ["PENDING", "PARTIAL", "FAILED", "CANCELLED"] } },
            data: { status: completed, lastError: null } });
          continue;
        }
        const job = await prisma.marketRecoveryJob.upsert({ where: { settingsId_scope_targetDate: key }, create: { ...key, nextAttemptAt: new Date() }, update: {} });
        // 프로세스 중단으로 마지막 시도가 RUNNING에 남아도 재시도 상한 뒤 영원히 묶이지 않는다.
        if (job.status === "RUNNING" && job.leaseUntil && job.leaseUntil < now && job.attempts >= RECOVERY_MAX_ATTEMPTS) {
          await prisma.marketRecoveryJob.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, leaseUntil: { lt: now } },
            data: { status: "FAILED", leaseToken: null, leaseUntil: null, lastError: "보충 작업이 중단되었습니다. 수집 상태를 확인해 주세요." } });
        }
        if (job.attempts >= RECOVERY_MAX_ATTEMPTS && !job.notifiedAt) await notifyFailure(job, setting);
        else if (executed < MAX_JOBS_PER_PASS && await executeJob(job, setting)) executed++;
      }
    }
    state.lastCheckOk = true;
  } catch {
    state.lastCheckOk = false;
    logger.error("[Market recovery] Check failed; next scheduled check will retry");
  } finally {
    clearInterval(heartbeat);
    state.lastCheckedAt = new Date().toISOString();
    state.lastHeartbeatAt = state.lastCheckedAt;
    state.checking = false;
  }
}

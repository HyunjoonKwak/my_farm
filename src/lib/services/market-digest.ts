/**
 * 가락시장 시세 브리핑 → 텔레그램 발송 (일일 브리핑 + 월요일 주간 리포트).
 *
 * - 수집이 완결(SUCCESS/EMPTY)된 직후 호출된다 (정기 수집·자동 보충·외부 크론).
 * - "오늘의 수집 대상 날짜"일 때만 보낸다. 자동 보충이 과거 날짜를 채워도 과거 브리핑은 보내지 않는다.
 * - 주간 리포트는 월~수 중 처음 완결된 수집 뒤에 지난주(월~일)분을 한 번 보낸다
 *   (월요일 수집이 끝내 완결되지 않아도 화·수에 이어서 보내기 위함).
 * - 발송 이력(MarketDigestDelivery: 채널·날짜)을 발송 전에 점유해 중복 발송을 막는다.
 *   확실히 실패한 건(FAILED)만 재시도하고, 전송 여부가 모호한 UNKNOWN은 재전송하지 않는다.
 * - 0건 브리핑(EMPTY_SENT)은 휴장 확정이 아니므로 같은 날 거래가 수집되면 실제 브리핑으로 다시 보낸다.
 * - 지표 계산·본문 형식은 market-insight/에 있다. 이 모듈은 절대 throw하지 않는다.
 */

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { marketDateKey } from "@/lib/market-date";
import { getDigestItems } from "./market-digest-data";
import { buildDailyBriefing, buildWeeklyReport, type BuiltMessage } from "./market-insight/build";
import { shiftDateKey, weekday } from "./market-insight/stats";
import { sendTelegramMessage, getTelegramConfig, type TelegramSendResult } from "./telegram";

const DAY_MS = 86_400_000;

export type DigestKind = "daily" | "weekly";
const CHANNELS: Record<DigestKind, string> = { daily: "telegram", weekly: "telegram-weekly" };

export type DigestOutcome = "SENT" | "FAILED" | "UNKNOWN" | "SKIPPED" | "NOT_CURRENT" | "DUPLICATE" | "ERROR";

/** collectDaysAgo를 반영한 "오늘의 수집 대상 날짜" (KST 달력 기준, 서버 TZ 무관). */
export function expectedDigestDateKey(collectDaysAgo: number, now = new Date()): string {
  return marketDateKey(new Date(now.getTime() - collectDaysAgo * DAY_MS));
}

/** dateKey가 속한 주의 지난주 월요일 (주간 리포트 대상 주) */
export function reportMonday(dateKey: string): string {
  const thisMonday = shiftDateKey(dateKey, -((weekday(dateKey) + 6) % 7));
  return shiftDateKey(thisMonday, -7);
}

/** 주간 리포트를 보낼 수 있는 요일 (월~수) */
export function isWeeklyWindow(dateKey: string): boolean {
  return [1, 2, 3].includes(weekday(dateKey));
}

/** 이력 키: 일일은 경매일, 주간은 대상 주의 월요일 */
function deliveryKey(kind: DigestKind, dateKey: string): string {
  return kind === "weekly" ? reportMonday(dateKey) : dateKey;
}

/** 활성 알림 항목으로 본문을 만든다. 요약이 꺼져 있거나 항목이 없으면 null. */
export async function buildDigest(kind: DigestKind, dateKey: string): Promise<BuiltMessage | null> {
  const items = await getDigestItems();
  if (items.length === 0) return null;
  const appUrl = process.env.NEXTAUTH_URL?.trim() || null;
  return kind === "weekly"
    ? buildWeeklyReport(reportMonday(dateKey), items, appUrl)
    : buildDailyBriefing(dateKey, items, appUrl);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * 날짜 발송 권한 점유. 새로 만들었거나 재발송 가능한 상태를 되살렸으면 delivery id, 아니면 null.
 * FAILED는 항상, EMPTY_SENT(0건 요약)는 이번에 실제 거래가 있을 때만 되살린다.
 */
async function claimDelivery(channel: string, dateKey: string, hasTrades: boolean): Promise<string | null> {
  try {
    const created = await prisma.marketDigestDelivery.create({
      data: { channel, dateKey, status: "SENDING" },
    });
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const revived = await prisma.marketDigestDelivery.updateMany({
    where: { channel, dateKey, status: { in: hasTrades ? ["FAILED", "EMPTY_SENT"] : ["FAILED"] } },
    data: { status: "SENDING", error: null },
  });
  if (revived.count === 0) return null;
  const existing = await prisma.marketDigestDelivery.findUnique({
    where: { channel_dateKey: { channel, dateKey } },
  });
  return existing?.id ?? null;
}

async function alreadyHandled(channel: string, dateKey: string): Promise<boolean> {
  const existing = await prisma.marketDigestDelivery.findUnique({
    where: { channel_dateKey: { channel, dateKey } },
    select: { status: true },
  });
  return existing !== null && existing.status !== "FAILED";
}

function deliveryStatus(sent: TelegramSendResult, hasTrades: boolean): string {
  return sent.status === "SENT" && !hasTrades ? "EMPTY_SENT" : sent.status;
}

/** 발송 이력을 점유한 뒤 보낸다. 중복·미설정·오류를 결과 코드로 돌려준다. */
export async function sendDigest(kind: DigestKind, dateKey: string): Promise<DigestOutcome> {
  if (!getTelegramConfig()) return "SKIPPED";
  const label = `[Market digest] ${kind} ${dateKey}`;
  let deliveryId: string | null = null;
  try {
    const key = deliveryKey(kind, dateKey);
    // 주간은 월~수 수집마다 호출되므로, 이미 처리한 주면 무거운 계산 전에 끝낸다
    if (kind === "weekly" && (await alreadyHandled(CHANNELS.weekly, key))) return "DUPLICATE";
    const digest = await buildDigest(kind, dateKey);
    if (!digest) {
      logger.info(`${label} 요약이 꺼져 있거나 알림 항목이 없어 발송하지 않습니다`);
      return "SKIPPED";
    }
    // 주간 리포트는 0건 재발송 개념이 없으므로 FAILED만 되살린다
    const revivable = kind === "daily" && digest.hasTrades;
    deliveryId = await claimDelivery(CHANNELS[kind], key, revivable);
    if (!deliveryId) return "DUPLICATE";
    const sent = await sendTelegramMessage(digest.text);
    await prisma.marketDigestDelivery.update({
      where: { id: deliveryId },
      data: { status: deliveryStatus(sent, kind === "weekly" || digest.hasTrades), messageId: sent.messageId, error: sent.error },
    });
    logger.info(`${label} → ${sent.status}`);
    return sent.status;
  } catch (error) {
    logger.error(`${label} 발송 처리 실패:`, error);
    // 점유한 채 SENDING으로 남으면 그 날짜가 영구히 막히므로 재시도 가능한 FAILED로 돌린다.
    if (deliveryId) {
      await prisma.marketDigestDelivery
        .updateMany({ where: { id: deliveryId, status: "SENDING" }, data: { status: "FAILED", error: "내부 처리 오류" } })
        .catch(() => logger.error(`${label} 발송 이력 복구 실패`));
    }
    return "ERROR";
  }
}

export function sendDailyDigest(dateKey: string): Promise<DigestOutcome> {
  return sendDigest("daily", dateKey);
}

/** 테스트 발송: 발송 이력을 남기지 않고 보낸다 (정기 발송의 중복 방지에 영향 없음). */
export async function sendTestDigest(dateKey: string, kind: DigestKind = "daily"): Promise<DigestOutcome> {
  if (!getTelegramConfig()) return "SKIPPED";
  try {
    const digest = await buildDigest(kind, dateKey);
    if (!digest) return "SKIPPED";
    return (await sendTelegramMessage(`[테스트] ${digest.text}`)).status;
  } catch (error) {
    logger.error(`[Market digest] ${kind} ${dateKey} 테스트 발송 실패:`, error);
    return "ERROR";
  }
}

/** 수동 발송 기본 날짜: 자동 수집 설정의 수집 대상 날짜 (설정이 없으면 오늘). */
export async function defaultDigestDateKey(now = new Date()): Promise<string> {
  const setting = await prisma.marketCollectionSettings.findFirst({
    where: { autoCollectEnabled: true },
    select: { collectDaysAgo: true },
    orderBy: { createdAt: "asc" },
  });
  return expectedDigestDateKey(setting?.collectDaysAgo ?? 0, now);
}

/** 수집 완결 직후 호출: 오늘의 수집 대상 날짜일 때만 일일(월~수는 주간도) 발송한다. */
export async function maybeSendDailyDigest(
  setting: { collectDaysAgo: number },
  dateKey: string,
  now = new Date()
): Promise<DigestOutcome> {
  if (!getTelegramConfig()) return "SKIPPED";
  if (dateKey !== expectedDigestDateKey(setting.collectDaysAgo, now)) return "NOT_CURRENT";
  const daily = await sendDigest("daily", dateKey);
  if (isWeeklyWindow(dateKey)) await sendDigest("weekly", dateKey);
  return daily;
}

/**
 * 가락시장 일일 경매 요약 → 텔레그램 발송.
 *
 * - 수집이 완결(SUCCESS/EMPTY)된 직후 호출된다 (정기 수집·자동 보충·외부 크론).
 * - "오늘의 수집 대상 날짜"일 때만 보낸다. 자동 보충이 과거 날짜를 채워도 과거 요약은 보내지 않는다.
 * - 날짜별 발송 이력(MarketDigestDelivery)을 발송 전에 점유해 재시작·재수집 중복 발송을 막는다.
 *   확실히 실패한 날짜(FAILED)만 재시도하고, 전송 여부가 모호한 UNKNOWN은 재전송하지 않는다.
 * - 0건 요약(EMPTY_SENT)은 휴장 확정이 아니므로, 같은 날짜에 거래가 나중에 수집되면 실제 요약으로 다시 보낸다.
 * - 요약 항목·대표 가격 계산은 market-digest-data, 본문 형식은 market-digest-format에 있다.
 * - 이 함수는 수집 흐름을 깨지 않도록 절대 throw하지 않는다.
 */

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { marketDateKey } from "@/lib/market-date";
import { buildItemRow, getDigestItems } from "./market-digest-data";
import { buildDigestText } from "./market-digest-format";
import { sendTelegramMessage, getTelegramConfig, type TelegramSendResult } from "./telegram";

const DAY_MS = 86_400_000;
const CHANNEL = "telegram";

export type DigestOutcome = "SENT" | "FAILED" | "UNKNOWN" | "SKIPPED" | "NOT_CURRENT" | "DUPLICATE" | "ERROR";

/** collectDaysAgo를 반영한 "오늘의 수집 대상 날짜" (KST 달력 기준, 서버 TZ 무관). */
export function expectedDigestDateKey(collectDaysAgo: number, now = new Date()): string {
  return marketDateKey(new Date(now.getTime() - collectDaysAgo * DAY_MS));
}

export interface DailyDigest {
  text: string;
  hasTrades: boolean;
}

/** 활성 알림 항목으로 요약을 만든다. 요약이 꺼져 있거나 항목이 없으면 null. */
export async function buildDailyDigest(dateKey: string): Promise<DailyDigest | null> {
  const items = await getDigestItems();
  if (items.length === 0) return null;
  const rows = await Promise.all(items.map((item) => buildItemRow(item, dateKey)));
  return {
    text: buildDigestText(dateKey, rows, process.env.NEXTAUTH_URL?.trim() || null),
    hasTrades: rows.some((row) => row.tradeCount > 0),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * 날짜 발송 권한 점유. 새로 만들었거나 재발송 가능한 상태를 되살렸으면 delivery id, 아니면 null.
 * FAILED는 항상, EMPTY_SENT(0건 요약)는 이번에 실제 거래가 있을 때만 되살린다.
 */
async function claimDelivery(dateKey: string, hasTrades: boolean): Promise<string | null> {
  try {
    const created = await prisma.marketDigestDelivery.create({
      data: { channel: CHANNEL, dateKey, status: "SENDING" },
    });
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const revived = await prisma.marketDigestDelivery.updateMany({
    where: { channel: CHANNEL, dateKey, status: { in: hasTrades ? ["FAILED", "EMPTY_SENT"] : ["FAILED"] } },
    data: { status: "SENDING", error: null },
  });
  if (revived.count === 0) return null;
  const existing = await prisma.marketDigestDelivery.findUnique({
    where: { channel_dateKey: { channel: CHANNEL, dateKey } },
  });
  return existing?.id ?? null;
}

function deliveryStatus(sent: TelegramSendResult, hasTrades: boolean): string {
  return sent.status === "SENT" && !hasTrades ? "EMPTY_SENT" : sent.status;
}

/** 발송 이력을 점유한 뒤 요약을 보낸다. 중복·미설정·오류를 결과 코드로 돌려준다. */
export async function sendDailyDigest(dateKey: string): Promise<DigestOutcome> {
  if (!getTelegramConfig()) return "SKIPPED";
  let deliveryId: string | null = null;
  try {
    const digest = await buildDailyDigest(dateKey);
    if (!digest) {
      logger.info(`[Market digest] ${dateKey} 요약이 꺼져 있거나 알림 항목이 없어 발송하지 않습니다`);
      return "SKIPPED";
    }
    deliveryId = await claimDelivery(dateKey, digest.hasTrades);
    if (!deliveryId) return "DUPLICATE";
    const sent = await sendTelegramMessage(digest.text);
    await prisma.marketDigestDelivery.update({
      where: { id: deliveryId },
      data: { status: deliveryStatus(sent, digest.hasTrades), messageId: sent.messageId, error: sent.error },
    });
    logger.info(`[Market digest] ${dateKey} → ${sent.status}`);
    return sent.status;
  } catch (error) {
    logger.error(`[Market digest] ${dateKey} 발송 처리 실패:`, error);
    // 점유한 채 SENDING으로 남으면 그 날짜가 영구히 막히므로 재시도 가능한 FAILED로 돌린다.
    if (deliveryId) {
      await prisma.marketDigestDelivery
        .updateMany({ where: { id: deliveryId, status: "SENDING" }, data: { status: "FAILED", error: "내부 처리 오류" } })
        .catch(() => logger.error(`[Market digest] ${dateKey} 발송 이력 복구 실패`));
    }
    return "ERROR";
  }
}

/** 테스트 발송: 발송 이력을 남기지 않고 보낸다 (정기 발송의 중복 방지에 영향 없음). */
export async function sendTestDigest(dateKey: string): Promise<DigestOutcome> {
  if (!getTelegramConfig()) return "SKIPPED";
  try {
    const digest = await buildDailyDigest(dateKey);
    if (!digest) return "SKIPPED";
    return (await sendTelegramMessage(`[테스트] ${digest.text}`)).status;
  } catch (error) {
    logger.error(`[Market digest] ${dateKey} 테스트 발송 실패:`, error);
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

/** 수집 완결 직후 호출: 오늘의 수집 대상 날짜일 때만 발송한다. */
export async function maybeSendDailyDigest(
  setting: { collectDaysAgo: number },
  dateKey: string,
  now = new Date()
): Promise<DigestOutcome> {
  if (!getTelegramConfig()) return "SKIPPED";
  if (dateKey !== expectedDigestDateKey(setting.collectDaysAgo, now)) return "NOT_CURRENT";
  return sendDailyDigest(dateKey);
}

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { prismaMock, sendMock, configMock, itemsMock, dailyMock, weeklyMock } = vi.hoisted(() => ({
  prismaMock: {
    marketDigestDelivery: { create: vi.fn(), updateMany: vi.fn(), update: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    marketCollectionSettings: { findFirst: vi.fn() },
  },
  sendMock: vi.fn(),
  configMock: vi.fn(),
  itemsMock: vi.fn(),
  dailyMock: vi.fn(),
  weeklyMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ default: prismaMock }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/services/telegram", () => ({ sendTelegramMessage: sendMock, getTelegramConfig: configMock }));
vi.mock("@/lib/services/market-digest-data", () => ({ getDigestItems: itemsMock }));
vi.mock("@/lib/services/market-insight/build", () => ({ buildDailyBriefing: dailyMock, buildWeeklyReport: weeklyMock }));

import {
  expectedDigestDateKey,
  isWeeklyWindow,
  maybeSendDailyDigest,
  reportMonday,
  sendTestDigest,
} from "@/lib/services/market-digest";

const ITEM = { productName: "토마토", label: "대추방울토마토", varieties: ["대추빨강"], origin: "경기도 평택시" };

const message = (hasTrades: boolean, text = hasTrades ? "📊 가락시장 브리핑 · 10/13(화)" : "📊 가락시장 브리핑 · 10/13(화)\n대추방울토마토 수집된 거래 없음 · 휴장 추정") =>
  ({ text, hasTrades });

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
}

beforeEach(() => {
  vi.clearAllMocks();
  configMock.mockReturnValue({ token: "t", chatId: "c" });
  itemsMock.mockResolvedValue([ITEM]);
  dailyMock.mockResolvedValue(message(false));
  weeklyMock.mockResolvedValue({ text: "📅 주간 시세 리포트", hasTrades: true });
  prismaMock.marketDigestDelivery.create.mockResolvedValue({ id: "d1" });
  prismaMock.marketDigestDelivery.update.mockResolvedValue({});
  prismaMock.marketDigestDelivery.findUnique.mockResolvedValue(null);
  sendMock.mockResolvedValue({ status: "SENT", messageId: "9", error: null });
});

describe("expectedDigestDateKey", () => {
  it("uses KST calendar days regardless of server timezone", () => {
    const now = new Date("2026-10-13T00:30:00Z"); // 09:30 KST
    expect(expectedDigestDateKey(0, now)).toBe("2026-10-13");
    expect(expectedDigestDateKey(1, now)).toBe("2026-10-12");
  });
});

describe("maybeSendDailyDigest", () => {
  const NOW = new Date("2026-10-13T00:31:00Z");
  const SETTING = { collectDaysAgo: 0 };

  it("skips without Telegram configuration and touches nothing", async () => {
    configMock.mockReturnValue(null);
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("SKIPPED");
    expect(prismaMock.marketDigestDelivery.create).not.toHaveBeenCalled();
  });

  it("ignores past dates such as recovery backfills", async () => {
    expect(await maybeSendDailyDigest(SETTING, "2026-10-09", NOW)).toBe("NOT_CURRENT");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("claims the date before sending and records the message id", async () => {
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("SENT");
    expect(prismaMock.marketDigestDelivery.create).toHaveBeenCalledWith({
      data: { channel: "telegram", dateKey: "2026-10-13", status: "SENDING" },
    });
    // 0건 요약은 휴장 확정이 아니므로 재발송 가능한 EMPTY_SENT로 남긴다
    expect(prismaMock.marketDigestDelivery.update).toHaveBeenCalledWith({
      where: { id: "d1" }, data: { status: "EMPTY_SENT", messageId: "9", error: null },
    });
    expect(sendMock.mock.calls[0][0]).toContain("대추방울토마토 수집된 거래 없음");
  });

  it("does not send twice for the same date", async () => {
    prismaMock.marketDigestDelivery.create.mockRejectedValue(uniqueViolation());
    prismaMock.marketDigestDelivery.updateMany.mockResolvedValue({ count: 0 });
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("DUPLICATE");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("retries a date whose previous attempt definitely failed", async () => {
    prismaMock.marketDigestDelivery.create.mockRejectedValue(uniqueViolation());
    prismaMock.marketDigestDelivery.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.marketDigestDelivery.findUnique.mockResolvedValue({ id: "d0" });
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("SENT");
    expect(prismaMock.marketDigestDelivery.updateMany).toHaveBeenCalledWith({
      where: { channel: "telegram", dateKey: "2026-10-13", status: { in: ["FAILED"] } },
      data: { status: "SENDING", error: null },
    });
  });

  it("replaces an earlier empty digest once trades are collected", async () => {
    dailyMock.mockResolvedValue(message(true));
    prismaMock.marketDigestDelivery.create.mockRejectedValue(uniqueViolation());
    prismaMock.marketDigestDelivery.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.marketDigestDelivery.findUnique.mockResolvedValue({ id: "d0" });
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("SENT");
    expect(prismaMock.marketDigestDelivery.updateMany).toHaveBeenCalledWith({
      where: { channel: "telegram", dateKey: "2026-10-13", status: { in: ["FAILED", "EMPTY_SENT"] } },
      data: { status: "SENDING", error: null },
    });
    expect(prismaMock.marketDigestDelivery.update).toHaveBeenCalledWith({
      where: { id: "d0" }, data: { status: "SENT", messageId: "9", error: null },
    });
  });

  it("releases the claim as FAILED when sending throws after claiming", async () => {
    sendMock.mockRejectedValue(new Error("boom"));
    prismaMock.marketDigestDelivery.updateMany.mockResolvedValue({ count: 1 });
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("ERROR");
    expect(prismaMock.marketDigestDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "d1", status: "SENDING" }, data: { status: "FAILED", error: "내부 처리 오류" },
    });
  });

  it("skips without claiming when the digest is off or has no items", async () => {
    itemsMock.mockResolvedValue([]);
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("SKIPPED");
    expect(prismaMock.marketDigestDelivery.create).not.toHaveBeenCalled();
  });

  it("never throws when the database fails", async () => {
    prismaMock.marketDigestDelivery.create.mockRejectedValue(new Error("db down"));
    expect(await maybeSendDailyDigest(SETTING, "2026-10-13", NOW)).toBe("ERROR");
  });
});

describe("sendTestDigest", () => {
  it("sends with a test prefix and leaves no delivery record", async () => {
    dailyMock.mockResolvedValue(message(true));
    expect(await sendTestDigest("2026-10-13")).toBe("SENT");
    expect(sendMock.mock.calls[0][0]).toMatch(/^\[테스트\] 📊 가락시장 브리핑/);
    expect(prismaMock.marketDigestDelivery.create).not.toHaveBeenCalled();
  });
});

describe("weekly report", () => {
  it("reports on the previous Monday–Sunday week", () => {
    expect(reportMonday("2026-10-12")).toBe("2026-10-05"); // 월
    expect(reportMonday("2026-10-14")).toBe("2026-10-05"); // 수
    expect(reportMonday("2026-10-18")).toBe("2026-10-05"); // 일
    expect(isWeeklyWindow("2026-10-12")).toBe(true);
    expect(isWeeklyWindow("2026-10-14")).toBe(true);
    expect(isWeeklyWindow("2026-10-15")).toBe(false);
  });

  it("sends the weekly once alongside the first completed daily of Mon–Wed", async () => {
    dailyMock.mockResolvedValue(message(true));
    await maybeSendDailyDigest({ collectDaysAgo: 0 }, "2026-10-12", new Date("2026-10-12T00:31:00Z"));
    expect(prismaMock.marketDigestDelivery.create).toHaveBeenCalledWith({
      data: { channel: "telegram-weekly", dateKey: "2026-10-05", status: "SENDING" },
    });
    expect(weeklyMock.mock.calls[0].slice(0, 2)).toEqual(["2026-10-05", [ITEM]]);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("does not send a weekly on Thursday", async () => {
    await maybeSendDailyDigest({ collectDaysAgo: 0 }, "2026-10-15", new Date("2026-10-15T00:31:00Z"));
    expect(weeklyMock).not.toHaveBeenCalled();
  });

  it("test-sends a weekly with the test prefix", async () => {
    await sendTestDigest("2026-10-12", "weekly");
    expect(sendMock.mock.calls[0][0]).toBe("[테스트] 📅 주간 시세 리포트");
  });
});

describe("weekly short-circuit", () => {
  it("skips rebuilding a weekly that was already handled", async () => {
    prismaMock.marketDigestDelivery.findUnique.mockResolvedValueOnce({ status: "SENT" });
    await maybeSendDailyDigest({ collectDaysAgo: 0 }, "2026-10-13", new Date("2026-10-13T00:31:00Z"));
    expect(weeklyMock).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  sessionUser: vi.fn(),
  cron: vi.fn(),
  findSettings: vi.fn(),
  updateSettings: vi.fn(),
  deleteItems: vi.fn(),
  createItems: vi.fn(),
  deliveries: vi.fn(),
  transaction: vi.fn(),
  sendDaily: vi.fn(),
  sendTest: vi.fn(),
  defaultDate: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireAdminUser: m.requireAdmin,
  getSessionUser: m.sessionUser,
  isValidCronRequest: m.cron,
}));
vi.mock("@/lib/prisma", () => ({
  default: {
    marketCollectionSettings: { findUnique: m.findSettings, update: m.updateSettings },
    marketDigestItem: { deleteMany: m.deleteItems, createMany: m.createItems },
    marketDigestDelivery: { findMany: m.deliveries },
    $transaction: m.transaction,
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/services/telegram", () => ({ getTelegramConfig: () => ({ token: "t", chatId: "c" }) }));
vi.mock("@/lib/services/market-digest", () => ({
  buildDailyDigest: vi.fn(),
  sendDailyDigest: m.sendDaily,
  sendTestDigest: m.sendTest,
  defaultDigestDateKey: m.defaultDate,
}));

import { PUT } from "@/app/api/market/garak/digest/items/route";
import { POST } from "@/app/api/market/garak/digest/route";

const put = (body: unknown) =>
  PUT(new NextRequest("http://localhost/api/market/garak/digest/items", { method: "PUT", body: JSON.stringify(body) }));
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/market/garak/digest", { method: "POST", body: JSON.stringify(body) }));

const ITEM = { productName: "토마토", label: "대추방울토마토", varieties: ["대추빨강", "대추빨강"], origin: "경기도 평택시", enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAdmin.mockResolvedValue(null);
  m.sessionUser.mockResolvedValue({ id: "owner" });
  m.cron.mockReturnValue(false);
  m.findSettings.mockResolvedValue({ id: "s1", digestEnabled: true, targetProducts: "토마토", digestItems: [] });
  m.deliveries.mockResolvedValue([]);
  m.transaction.mockResolvedValue([]);
  m.defaultDate.mockResolvedValue("2026-10-14");
  m.sendDaily.mockResolvedValue("SENT");
  m.sendTest.mockResolvedValue("SENT");
});

describe("PUT /api/market/garak/digest/items", () => {
  it("requires an admin", async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 }));
    expect((await put({ digestEnabled: true, items: [ITEM] })).status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { digestEnabled: true, items: [{ ...ITEM, productName: "망고" }] },
    { digestEnabled: "yes", items: [] },
    { digestEnabled: true, items: Array.from({ length: 21 }, () => ITEM) },
    { digestEnabled: true, items: [{ ...ITEM, label: "가".repeat(31) }] },
  ])("rejects invalid input before storage: %#", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("replaces items in order with de-duplicated varieties", async () => {
    expect((await put({ digestEnabled: true, items: [ITEM, { ...ITEM, productName: "오이", label: "", varieties: [] }] })).status).toBe(200);
    expect(m.createItems).toHaveBeenCalledWith({
      data: [
        { settingsId: "s1", productName: "토마토", label: "대추방울토마토", varieties: '["대추빨강"]', origin: "경기도 평택시", enabled: true, sortOrder: 0 },
        { settingsId: "s1", productName: "오이", label: "", varieties: "[]", origin: "경기도 평택시", enabled: true, sortOrder: 1 },
      ],
    });
    expect(m.updateSettings).toHaveBeenCalledWith({ where: { id: "s1" }, data: { digestEnabled: true } });
  });
});

describe("POST /api/market/garak/digest", () => {
  it.each([{ date: "2026-13-45" }, { date: "2026-02-30" }, { date: "2099-01-01" }])("rejects bad dates: %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(m.sendDaily).not.toHaveBeenCalled();
  });

  it("defaults to the collection target date and routes test sends separately", async () => {
    expect(await (await post({})).json()).toEqual({ dateKey: "2026-10-14", outcome: "SENT" });
    expect(m.sendDaily).toHaveBeenCalledWith("2026-10-14");
    await post({ test: true, date: "2026-10-13" });
    expect(m.sendTest).toHaveBeenCalledWith("2026-10-13");
  });
});

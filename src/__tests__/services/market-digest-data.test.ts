import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    auctionResult: { findMany: vi.fn(), findFirst: vi.fn() },
    marketCollectionSettings: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ default: prismaMock }));

import { buildItemRow, getDigestItems, parseVarieties } from "@/lib/services/market-digest-data";

type Where = { origin?: string; variety?: { in: string[] }; grade?: string; auctionDate?: { lt?: Date } };

const trade = (variety: string, grade: string, unit: string, price: number, quantity: number, origin = "경기도 평택시") =>
  ({ variety, grade, unit, price, quantity, origin });

/** 조건(산지·품종·등급)으로 거르는 가짜 findMany — 날짜는 조회 순서로 구분한다. */
function serve(today: ReturnType<typeof trade>[], previous: ReturnType<typeof trade>[] = []) {
  prismaMock.auctionResult.findMany.mockImplementation(async ({ where }: { where: Where }) => {
    const source = where.grade !== undefined ? previous : today;
    return source.filter((row) =>
      (!where.origin || row.origin === where.origin)
      && (!where.variety || where.variety.in.includes(row.variety))
      && (where.grade === undefined || row.grade === where.grade));
  });
  prismaMock.auctionResult.findFirst.mockResolvedValue(
    previous.length ? { auctionDate: new Date("2026-10-12T00:00:00+09:00") } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildItemRow", () => {
  const CHERRY = { productName: "토마토", label: "대추방울토마토", varieties: ["대추빨강", "대추빨강(방울토마토)"], origin: "경기도 평택시" };

  it("treats variety spellings as one and picks the heaviest grade·unit group", async () => {
    serve(
      [
        trade("대추빨강", "특", "3kg", 9000, 10),
        trade("대추빨강(방울토마토)", "특", "3kg", 12000, 10),
        trade("대추빨강", "상", "5kg", 20000, 5),
        trade("대추빨강", "특", "3kg", 1000, 99, "강원특별자치도 인제군"),
      ],
      [trade("대추빨강", "특", "3kg", 10000, 4)]
    );
    const row = await buildItemRow(CHERRY, "2026-10-13");
    expect(row).toMatchObject({
      title: "대추방울토마토", autoVariety: null, originFallback: false,
      tradeCount: 3, totalQuantity: 25,
      representative: { grade: "특", unit: "3kg", avgPrice: 10500, kgPrice: 3500 },
      change: { prevDateKey: "2026-10-12", pct: 5 },
    });
  });

  it("falls back to all origins when the chosen origin has no trades that day", async () => {
    serve([trade("대추빨강", "특", "3kg", 8000, 2, "충남 부여군")]);
    const row = await buildItemRow(CHERRY, "2026-10-13");
    expect(row.originFallback).toBe(true);
    expect(row.representative?.avgPrice).toBe(8000);
    expect(row.change).toBeNull();
  });

  it("picks the highest-volume variety when none is specified", async () => {
    serve([
      trade("백다다기", "특", "10kg", 9000, 30, ""),
      trade("취청", "특", "10kg", 15000, 5, ""),
    ]);
    const row = await buildItemRow({ productName: "오이", label: "", varieties: [], origin: "" }, "2026-10-13");
    expect(row).toMatchObject({ title: "오이", autoVariety: "백다다기", tradeCount: 1, totalQuantity: 30 });
    expect(row.representative?.avgPrice).toBe(9000);
  });

  it("reports no trades without fallback noise", async () => {
    serve([]);
    const row = await buildItemRow(CHERRY, "2026-10-11");
    expect(row).toMatchObject({ tradeCount: 0, representative: null, originFallback: false });
  });
});

describe("parseVarieties", () => {
  it("returns a clean list and tolerates broken values", () => {
    expect(parseVarieties('["샤인머스켓", " ", "샤인머스캣"]')).toEqual(["샤인머스켓", "샤인머스캣"]);
    expect(parseVarieties("not json")).toEqual([]);
    expect(parseVarieties('{"a":1}')).toEqual([]);
  });
});

describe("getDigestItems", () => {
  it("flattens enabled items of settings with the digest on", async () => {
    prismaMock.marketCollectionSettings.findMany.mockResolvedValue([
      { digestItems: [{ productName: "포도", label: "샤인머스캣", varieties: '["샤인머스켓"]', origin: "" }] },
    ]);
    expect(await getDigestItems()).toEqual([
      { productName: "포도", label: "샤인머스캣", varieties: ["샤인머스켓"], origin: "" },
    ]);
    expect(prismaMock.marketCollectionSettings.findMany.mock.calls[0][0].where).toEqual({ digestEnabled: true });
  });
});

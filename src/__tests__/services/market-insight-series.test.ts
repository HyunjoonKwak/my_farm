import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: { $queryRaw: queryRaw } }));

import { dailySeries, kstStartMs, pickSpec } from "@/lib/services/market-insight/series";

const row = (variety: string, grade: string, unit: string, qty: number) => ({ variety, grade, unit, qty: BigInt(qty) });

beforeEach(() => vi.clearAllMocks());

describe("pickSpec", () => {
  it("pools variety spellings and keeps the heaviest grade·unit", async () => {
    queryRaw.mockResolvedValue([
      row("샤인머스켓", "특(1등)", "2kg", 400),
      row("샤인머스캣", "특(1등)", "2kg", 300),
      row("샤인머스켓", "특(1등)", "4kg", 600),
    ]);
    const spec = await pickSpec({ productName: "포도", label: "", varieties: ["샤인머스켓", "샤인머스캣"], origin: "" }, "2026-10-14");
    expect(spec).toEqual({ varieties: ["샤인머스켓", "샤인머스캣"], autoVariety: null, grade: "특(1등)", unit: "2kg" });
  });

  it("picks the top variety first when none is configured", async () => {
    queryRaw.mockResolvedValue([
      row("백다다기", "특(1등)", "10kg", 500),
      row("취청", "특(1등)", "10kg", 300),
      row("취청", "특(1등)", "18kg", 250),
      row("백다다기", "상(2등)", "10kg", 100),
    ]);
    const spec = await pickSpec({ productName: "오이", label: "", varieties: [], origin: "" }, "2026-10-14");
    expect(spec).toEqual({ varieties: ["백다다기"], autoVariety: "백다다기", grade: "특(1등)", unit: "10kg" });
  });

  it("returns null without recent trades", async () => {
    queryRaw.mockResolvedValue([]);
    expect(await pickSpec({ productName: "오이", label: "", varieties: [], origin: "" }, "2026-10-14")).toBeNull();
  });
});

describe("dailySeries", () => {
  it("converts SQLite bigint sums into numbers", async () => {
    queryRaw.mockResolvedValue([{ d: "2026-10-14", amount: BigInt(1650000), qty: BigInt(100), n: BigInt(7) }]);
    const spec = { varieties: ["대추빨강"], autoVariety: null, grade: "특(1등)", unit: "3kg" };
    expect(await dailySeries("토마토", spec, "2026-10-01", "2026-10-14")).toEqual([
      { dateKey: "2026-10-14", amount: 1650000, qty: 100, n: 7 },
    ]);
  });

  it("anchors date ranges to KST midnight", () => {
    expect(new Date(kstStartMs("2026-10-14")).toISOString()).toBe("2026-10-13T15:00:00.000Z");
  });
});

import { describe, it, expect } from "vitest";
import { computeCorpInsight, computeWeeklyItem } from "@/lib/services/market-insight/weekly-metrics";
import { buildWeeklyText } from "@/lib/services/market-insight/format-weekly";
import { buildDailyText } from "@/lib/services/market-insight/format-daily";
import { shiftDateKey } from "@/lib/services/market-insight/stats";
import type { DailyInsight, DailyPoint, ItemSpec } from "@/lib/services/market-insight/types";

const SPEC: ItemSpec = { varieties: ["대추빨강"], autoVariety: null, grade: "특(1등)", unit: "3kg" };
const MONDAY = "2026-10-05";

/** MONDAY+6(일)까지 days일치, priceOf(일 오프셋)로 가격 지정 */
function series(days: number, priceOf: (offset: number) => number, qty = 100): DailyPoint[] {
  const end = shiftDateKey(MONDAY, 6);
  return Array.from({ length: days }, (_, i) => {
    const offset = i - (days - 1);
    const dateKey = shiftDateKey(end, offset);
    return { dateKey, amount: priceOf(offset) * qty, qty, n: 20 };
  });
}

describe("computeWeeklyItem", () => {
  it("compares the week with last week, 4 weeks, and the same week last year", () => {
    // 이번 주 12,000 / 그 전 10,000 / 1년 전 같은 주 8,000
    const s = series(400, (o) => (o >= -6 ? 12000 : o <= -364 && o >= -370 ? 8000 : 10000));
    const w = computeWeeklyItem("대추방울토마토", SPEC, MONDAY, s, null, null);
    expect(w.weekAvg).toBe(12000);
    expect(w.vsPrevWeek).toBeCloseTo(0.2);
    expect(w.vs4w).toBeCloseTo(0.2);
    expect(w.lastYearWeekAvg).toBe(8000);
    expect(w.yoy).toBeCloseTo(0.5);
    expect(w.rankTop).toBe(0); // 52주 중 가장 비쌈
    expect(w.lastYearNext4w).toBeCloseTo(0.25); // 작년엔 8,000 → 이후 10,000
  });

  it("omits year-ago comparisons without enough history", () => {
    const w = computeWeeklyItem("오이", SPEC, MONDAY, series(30, () => 9000), null, null);
    expect(w).toMatchObject({ lastYearWeekAvg: null, yoy: null, rankTop: null, lastYearNext4w: null });
  });

  it("reports the origin week against the national week", () => {
    const s = series(14, () => 10000);
    const origin = series(14, () => 9000);
    const w = computeWeeklyItem("대추방울토마토", SPEC, MONDAY, s, "평택시", origin);
    expect(w.origin).toMatchObject({ name: "평택시", weekAvg: 9000 });
    expect(w.origin?.gap).toBeCloseTo(-0.1);
  });
});

describe("computeCorpInsight", () => {
  const national = [
    { corp: "11000101", name: "서울청과", amount: 18000 * 300, qty: 300, days: 24 },
    { corp: "11000103", name: "중앙청과", amount: 20000 * 500, qty: 500, days: 24 },
    { corp: "11000105", name: "한국청과", amount: 19000 * 20, qty: 20, days: 6 },
  ];
  const months = ["2026-08", "2026-09", "2026-10"].flatMap((month, i) => [
    { month, corp: "11000101", amount: 100 * (i === 2 ? 21000 : 18000), qty: 100 },
    { month, corp: "11000103", amount: 100 * 20000, qty: 100 },
  ]);

  it("ranks corporations by price with share and small-sample flags", () => {
    const insight = computeCorpInsight(national, [], months);
    expect(insight.national.map((l) => l.name)).toEqual(["중앙청과", "한국청과", "서울청과"]);
    expect(insight.national[0].share).toBeCloseTo(500 / 820);
    expect(insight.national[1].smallSample).toBe(true);
    expect(insight.headToHead).toEqual({ leader: "중앙청과", other: "서울청과", months: 3, wins: 2 });
  });
});

describe("buildWeeklyText", () => {
  it("renders item and corporation sections with the caveat", () => {
    const s = series(400, (o) => (o >= -6 ? 12000 : 10000));
    const item = computeWeeklyItem("대추방울토마토", SPEC, MONDAY, s, "평택시", series(14, () => 11000));
    const corp = computeCorpInsight(
      [{ corp: "11000103", name: "중앙청과", amount: 2e6, qty: 100, days: 24 }],
      [{ corp: "11000101", name: "서울청과", amount: 1e5, qty: 10, days: 6 }],
      []
    );
    const text = buildWeeklyText(MONDAY, [item], [{ title: "대추방울토마토", originName: "평택시", corp }], null);
    expect(text).toContain("📅 주간 시세 리포트 · 10/5(월)~10/11(일)");
    expect(text).toContain("[대추방울토마토] 특·3kg · 전국");
    expect(text).toContain("주간 평균 12,000원 · 전주 대비 +20% · 4주 대비 +20%");
    expect(text).toContain("평택시 11,000원 · 전국 대비 -8%");
    expect(text).toContain("전국: 중앙청과 20,000(100%)");
    expect(text).toContain("평택시산: 서울청과 10,000(100%, 6일·표본 적음)");
    expect(text).toContain("※ 법인 간 차이는 물건 품질·산지 구성 차이일 수 있음");
  });
});

describe("buildDailyText", () => {
  const base: DailyInsight = {
    title: "대추방울토마토", spec: SPEC, status: "watch", statusReason: null,
    today: { price: 16511, qty: 9621, n: 400 }, avg5: 16904, avg24: 18275, vs4w: -0.0965, yoy: 0.09,
    topQuartile: 17000, supplyDev: -0.12,
    origin: { name: "평택시", price: 16350, gap: -0.0098, band: [-0.1, 0.06] }, signals: [],
  };

  it("renders headline, no-signal line, and detail", () => {
    const text = buildDailyText("2026-10-14", [base], "https://farm.example.com");
    expect(text).toContain("🟡 대추방울토마토 16,511원 (특·3kg)\n   4주 평균 대비 -10% (평소보다 큰 움직임) · 전년 동기 +9%");
    expect(text).toContain("✅ 특이 신호 없음");
    expect(text).toContain(" 오늘 16,511 │ 5일 16,904 │ 4주 18,275");
    expect(text).toContain(" 상위 25% 17,000원 (좋은 물건 기준선)");
    expect(text).toContain(" 물량 9,621개 · 400건 · 평소 같은 요일 대비 -12%");
    expect(text).toContain(" 평택시 16,350원 · 전국 대비 -1% (평소 -10%~+6%)");
    expect(text).toContain("앱에서 보기: https://farm.example.com/market");
  });

  it("puts origin gaps first and caps alerts at three", () => {
    const signals = [
      { kind: "supply" as const, title: "오이", message: "반입량" },
      { kind: "spike" as const, title: "오이", message: "급락" },
      { kind: "trend" as const, title: "오이", message: "흐름" },
      { kind: "originGap" as const, title: "대추방울토마토", message: "평택 괴리" },
    ];
    const text = buildDailyText("2026-10-14", [{ ...base, status: "alert", signals }], null);
    const alertLines = text.split("\n").filter((l) => l.startsWith("• "));
    expect(alertLines).toEqual(["• [대추방울토마토] 평택 괴리", "• [오이] 급락", "• [오이] 흐름"]);
  });

  it("shows the reason for insufficient items and collapses closed days", () => {
    const thin = { ...base, title: "오이", status: "insufficient" as const, statusReason: "자료 6일 — 흐름 판단 보류" };
    expect(buildDailyText("2026-10-14", [thin], null)).toContain("⚪ 오이 16,511원 (특·3kg)\n   자료 6일 — 흐름 판단 보류");
    const closed = { ...base, today: null, statusReason: "오늘 거래 없음" };
    expect(buildDailyText("2026-10-11", [closed], null)).toBe("📊 가락시장 브리핑 · 10/11(일)\n대추방울토마토 수집된 거래 없음 · 휴장 추정");
  });
});

describe("josa", async () => {
  const { josa } = await import("@/lib/services/market-insight/format");
  it("picks the particle from the last Hangul syllable", () => {
    expect(josa("중앙청과", "이", "가")).toBe("가");
    expect(josa("농협(공)", "이", "가")).toBe("이");
    expect(josa("서울청과", "이", "가")).toBe("가");
  });
});

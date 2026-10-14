import { describe, it, expect } from "vitest";
import {
  computeDailyInsight,
  originBand,
  spikeThreshold,
  supplyDeviation,
  trendSwitch,
  yearOverYear,
  FALLBACK,
} from "@/lib/services/market-insight/daily-metrics";
import { shiftDateKey } from "@/lib/services/market-insight/stats";
import type { DailyPoint, ItemSpec } from "@/lib/services/market-insight/types";

const END = "2026-10-14";
const SPEC: ItemSpec = { varieties: ["대추빨강"], autoVariety: null, grade: "특(1등)", unit: "3kg" };

/** prices[i]는 END에서 (len-1-i)일 전 */
function series(prices: number[], qty = 100, n = 30, end = END): DailyPoint[] {
  return prices.map((p, i) => ({
    dateKey: shiftDateKey(end, i - (prices.length - 1)),
    amount: p * qty,
    qty,
    n,
  }));
}

/** 잔잔한 ±2% 물결 */
const wobble = (len: number, base = 10000) =>
  Array.from({ length: len }, (_, i) => base * (1 + 0.02 * Math.sin(i)));

const input = (s: DailyPoint[], extra: Partial<Parameters<typeof computeDailyInsight>[0]> = {}) => ({
  title: "대추방울토마토", spec: SPEC, dateKey: END, series: s,
  originName: null, originSeries: null, topQuartile: 17000, ...extra,
});

describe("computeDailyInsight", () => {
  it("is insufficient with fewer than 20 trading days and raises no signals", () => {
    const result = computeDailyInsight(input(series([...wobble(14), 20000])));
    expect(result.status).toBe("insufficient");
    expect(result.statusReason).toBe("최근 5주 거래 15일 — 흐름 판단 보류");
    expect(result.signals).toEqual([]);
    expect(result.today?.price).toBe(20000);
  });

  it("is insufficient when the item did not trade today", () => {
    const s = series(wobble(40)).slice(0, -1);
    expect(computeDailyInsight(input(s)).statusReason).toBe("오늘 거래 없음");
  });

  it("fires a spike on a +20% day without a trend switch", () => {
    const result = computeDailyInsight(input(series([...wobble(80), 12000])));
    expect(result.signals.map((s) => s.kind)).toEqual(["spike"]);
    expect(result.status).toBe("alert");
    expect(result.signals[0].message).toContain("급등");
  });

  it("stays calm inside normal noise", () => {
    const result = computeDailyInsight(input(series(wobble(80))));
    expect(result).toMatchObject({ status: "calm", signals: [] });
    expect(result.vs4w).not.toBeNull();
  });

  it("flags a two-day origin gap outside its band but not a single day", () => {
    const s = series(wobble(80));
    const origin = (gaps: number[]) => s.map((p, i) => {
      const gap = gaps[i - (s.length - gaps.length)] ?? 0;
      return { ...p, amount: p.amount * (1 + gap), n: 30 };
    });
    const twoDays = computeDailyInsight(input(s, { originName: "평택시", originSeries: origin([-0.2, -0.22]) }));
    expect(twoDays.signals.map((x) => x.kind)).toContain("originGap");
    expect(twoDays.origin?.gap).toBeCloseTo(-0.22);

    const oneDay = computeDailyInsight(input(s, { originName: "평택시", originSeries: origin([0, -0.22]) }));
    expect(oneDay.signals.map((x) => x.kind)).not.toContain("originGap");
  });

  it("ignores origin gaps on thin origin days", () => {
    const s = series(wobble(80));
    const originSeries = s.map((p, i) => (i >= s.length - 2 ? { ...p, amount: p.amount * 0.7, n: 3 } : p));
    const result = computeDailyInsight(input(s, { originName: "평택시", originSeries }));
    expect(result.signals.map((x) => x.kind)).not.toContain("originGap");
  });
});

describe("trendSwitch", () => {
  const flatThen = (tail: number[]) => series([...Array(40).fill(10000), ...tail]);

  it("detects a cross held for three days", () => {
    expect(trendSwitch(flatThen([12000, 12000, 12000]))).toBe("up");
    expect(trendSwitch(flatThen([8000, 8000, 8000]))).toBe("down");
  });

  it("ignores a cross that reverts", () => {
    expect(trendSwitch(flatThen([12000, 12000, 7000]))).toBeNull();
    // 4일째부터는 "전환"이 아니라 이미 이어진 흐름
    expect(trendSwitch(flatThen([12000, 12000, 12000, 12000]))).toBeNull();
  });
});

describe("thresholds and baselines", () => {
  it("falls back to fixed thresholds with short history", () => {
    expect(spikeThreshold(series(wobble(30)))).toBe(FALLBACK.spike);
    expect(originBand([0.01, -0.02])).toEqual(FALLBACK.originBand);
  });

  it("adapts the spike threshold to a noisy history", () => {
    const noisy = Array.from({ length: 120 }, (_, i) => 10000 * (i % 2 ? 1.25 : 0.8));
    expect(spikeThreshold(series(noisy))).toBeGreaterThan(FALLBACK.spike);
  });

  it("compares supply with the same weekday when available", () => {
    const s = series(Array(30).fill(10000));
    const bumped = s.map((p, i) => (i === s.length - 1 ? { ...p, qty: 150, amount: 150 * 10000 } : p));
    expect(supplyDeviation(bumped, END)).toBeCloseTo(0.5);
  });

  it("needs at least three trading days a year ago for year-over-year", () => {
    const year = Array.from({ length: 380 }, (_, i) => (i < 30 ? 8000 : 10000));
    expect(yearOverYear(series(year), END)).toBeCloseTo(0.25);
    expect(yearOverYear(series(wobble(200)), END)).toBeNull();
  });
});

describe("review regressions", () => {
  it("does not spike or trend across a seasonal gap", () => {
    // 지난 시즌 60일(10,000원) → 4개월 공백 → 이번 시즌 25일(20,000원)
    const lastSeason = series(Array(60).fill(10000), 100, 30, shiftDateKey(END, -150));
    const thisSeason = series(Array(25).fill(20000));
    const result = computeDailyInsight(input([...lastSeason, ...thisSeason.slice(-1)]));
    expect(result.signals).toEqual([]);
    expect(result.statusReason).toBe("최근 5주 거래 1일 — 흐름 판단 보류");
  });

  it("requires the origin gap on two consecutive national trading days", () => {
    const s = series(wobble(80));
    // 평택은 오늘과 1주 전에만 거래 — 둘 다 밴드 밖이어도 "이틀 연속"이 아니다
    const originSeries = [s[s.length - 7], s[s.length - 1]].map((p) => ({ ...p, amount: p.amount * 0.7, n: 30 }));
    const result = computeDailyInsight(input(s, { originName: "평택시", originSeries }));
    expect(result.signals.map((x) => x.kind)).not.toContain("originGap");
  });

  it("names the spec in the supply signal", () => {
    const s = series(wobble(80));
    const bumped = s.map((p, i) => (i === s.length - 1 ? { ...p, qty: 200, amount: p.amount * 2 } : p));
    const supply = computeDailyInsight(input(bumped)).signals.find((x) => x.kind === "supply");
    expect(supply?.message).toContain("이 규격(특·3kg) 물량이 평소 같은 요일보다 +100%");
  });

  it("never alerts on moves below the minimum floor", () => {
    const flat = Array.from({ length: 120 }, (_, i) => 10000 * (1 + 0.002 * Math.sin(i)));
    expect(spikeThreshold(series(flat))).toBe(0.05);
  });
});

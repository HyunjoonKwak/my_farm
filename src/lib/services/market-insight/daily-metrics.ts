/**
 * 일일 브리핑 지표·신호 (순수 함수).
 *
 * 하루 등락은 잡음이 커서(대추방울토마토 중앙값 ±5%, 상위 10% ±15%) 전일 대비 대신
 * 5일·4주 평균을 비교한다. 기준값은 품목 자신의 과거 분포에서 정하고, 자료가 적으면
 * 고정값으로 대체하거나 판단을 보류한다 (알림 피로 방지).
 */

import { between, dayNumber, mean, price, quantile, ratio, shiftDateKey, weekday, windowAvg } from "./stats";
import type { DailyInsight, DailyPoint, ItemSpec, Signal, Status } from "./types";

export const SHORT_WINDOW = 5;
export const LONG_WINDOW = 24; // 약 4주 (주 6일 거래)
export const MIN_POINTS = 20;
// 창이 이 기간을 넘게 퍼져 있으면(휴지기 포함) 평균을 내지 않는다
const SHORT_SPAN_DAYS = 10;
const LONG_SPAN_DAYS = 35;
// 품목 자신의 분포가 아무리 잔잔해도 이보다 작은 움직임은 알리지 않는다
const MIN_SPIKE = 0.05;
const MIN_TREND_WATCH = 0.03;
export const MIN_HISTORY = 60;
export const FALLBACK = {
  spike: 0.15,
  trendWatch: 0.08,
  supply: 0.4,
  originBand: [-0.1, 0.06] as [number, number],
};
const MIN_ORIGIN_TRADES = 5;
const YOY_DAYS = 364;
const YOY_HALF_WINDOW = 7;
const MIN_YOY_POINTS = 3;

interface DailyInput {
  title: string;
  spec: ItemSpec | null;
  dateKey: string;
  /** 전국 기준 규격 일별 집계 (오름차순, dateKey까지) */
  series: DailyPoint[];
  /** 비교 산지 일별 집계 (없으면 null) */
  originName: string | null;
  originSeries: DailyPoint[] | null;
  topQuartile: number | null;
}

const shortAvg = (points: DailyPoint[], i: number) => windowAvg(points, i, SHORT_WINDOW, SHORT_SPAN_DAYS);
const longAvg = (points: DailyPoint[], i: number) => windowAvg(points, i, LONG_WINDOW, LONG_SPAN_DAYS);

/** i번째 날의 직전 5일 평균 대비 변동 (직전 5일이 i번째 날과 이어져 있을 때만) */
function spikeAt(points: DailyPoint[], i: number): number | null {
  if (i < SHORT_WINDOW || dayNumber(points[i].dateKey) - dayNumber(points[i - SHORT_WINDOW].dateKey) > SHORT_SPAN_DAYS + 1) {
    return null;
  }
  return ratio(price(points[i]), shortAvg(points, i - 1));
}

/** i번째 날의 5일 평균 / 4주 평균 - 1 */
function trendAt(points: DailyPoint[], i: number): number | null {
  return ratio(shortAvg(points, i), longAvg(points, i));
}

function historyQuantile(values: (number | null)[], q: number, fallback: number): number {
  const valid = values.filter((v): v is number => v !== null).map(Math.abs);
  return valid.length >= MIN_HISTORY ? (quantile(valid, q) ?? fallback) : fallback;
}

export function spikeThreshold(points: DailyPoint[]): number {
  return Math.max(MIN_SPIKE, historyQuantile(points.slice(0, -1).map((_, i) => spikeAt(points, i)), 0.9, FALLBACK.spike));
}

export function trendWatchThreshold(points: DailyPoint[]): number {
  return Math.max(MIN_TREND_WATCH, historyQuantile(points.slice(0, -1).map((_, i) => trendAt(points, i)), 0.75, FALLBACK.trendWatch));
}

/** 5일선이 4주선보다 이 이상 벌어져야 "흐름"으로 본다 (잔물결에 반응하지 않게) */
export const TREND_DEAD_BAND = 0.03;

function trendState(points: DailyPoint[], i: number): number | null {
  const value = i >= 0 ? trendAt(points, i) : null;
  if (value === null) return null;
  return value >= TREND_DEAD_BAND ? 1 : value <= -TREND_DEAD_BAND ? -1 : 0;
}

/** 5일선이 4주선보다 3% 이상 높은(낮은) 상태가 오늘로 3일째이고 그 전날은 아니었으면 전환 */
export function trendSwitch(points: DailyPoint[]): "up" | "down" | null {
  const t = points.length - 1;
  const states = [t - 3, t - 2, t - 1, t].map((i) => trendState(points, i));
  if (states.some((s) => s === null)) return null;
  const [before, a, b, c] = states as number[];
  if (c !== 0 && a === c && b === c && before !== c) return c > 0 ? "up" : "down";
  return null;
}

/** 오늘 물량 / 평소(최근 4주 같은 요일, 2회 미만이면 최근 24일) - 1 */
export function supplyDeviation(points: DailyPoint[], dateKey: string): number | null {
  const today = points[points.length - 1];
  if (!today || today.dateKey !== dateKey) return null;
  const past = between(points.slice(0, -1), shiftDateKey(dateKey, -28), shiftDateKey(dateKey, -1));
  const sameDay = past.filter((p) => weekday(p.dateKey) === weekday(dateKey));
  const base = sameDay.length >= 2 ? sameDay : points.slice(-LONG_WINDOW - 1, -1);
  return ratio(today.qty, mean(base.map((p) => p.qty)));
}

/** 최근 5일 평균 / 전년 같은 시기(±7일) 평균 - 1 */
export function yearOverYear(points: DailyPoint[], dateKey: string): number | null {
  const center = shiftDateKey(dateKey, -YOY_DAYS);
  const lastYear = between(points, shiftDateKey(center, -YOY_HALF_WINDOW), shiftDateKey(center, YOY_HALF_WINDOW));
  if (lastYear.length < MIN_YOY_POINTS) return null;
  return ratio(shortAvg(points, points.length - 1), mean(lastYear.map(price)));
}

interface OriginGap {
  dateKey: string;
  gap: number;
  n: number;
}

function originGaps(series: DailyPoint[], originSeries: DailyPoint[]): OriginGap[] {
  const national = new Map(series.map((p) => [p.dateKey, price(p)]));
  return originSeries.flatMap((p) => {
    const base = national.get(p.dateKey);
    return base && base > 0 && p.qty > 0 ? [{ dateKey: p.dateKey, gap: price(p) / base - 1, n: p.n }] : [];
  });
}

export function originBand(gaps: number[]): [number, number] {
  if (gaps.length < MIN_HISTORY) return FALLBACK.originBand;
  return [quantile(gaps, 0.1) ?? FALLBACK.originBand[0], quantile(gaps, 0.9) ?? FALLBACK.originBand[1]];
}

const pct = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 100)}%`;
const shortGradeOf = (grade: string) => grade.replace(/\(.*\)/, "").trim() || grade;

function originSignal(
  title: string, name: string, gaps: OriginGap[], band: [number, number], dateKey: string, previousTradingDay: string | null
): Signal | null {
  const recent = gaps.slice(-2);
  // 전국 기준 바로 앞 거래일과 오늘, 이어진 이틀이어야 "연속"이다 (드문드문 출하하는 산지 오탐 방지)
  if (recent.length < 2 || recent[1].dateKey !== dateKey || recent[0].dateKey !== previousTradingDay) return null;
  if (recent.some((g) => g.n < MIN_ORIGIN_TRADES)) return null;
  const sides = recent.map((g) => (g.gap < band[0] ? -1 : g.gap > band[1] ? 1 : 0));
  if (sides[0] === 0 || sides[0] !== sides[1]) return null;
  const direction = sides[0] < 0 ? "낮게" : "높게";
  return {
    kind: "originGap",
    title,
    message: `${name}산이 이틀 연속 전국보다 ${direction} 낙찰 (${recent.map((g) => pct(g.gap)).join(", ")} · 평소 ${pct(band[0])}~${pct(band[1])})`,
  };
}

function statusOf(signals: Signal[], trend: number | null, watch: number): Status {
  if (signals.length) return "alert";
  return trend !== null && Math.abs(trend) >= watch ? "watch" : "calm";
}

export function computeDailyInsight(input: DailyInput): DailyInsight {
  const { title, spec, dateKey, series, originName, originSeries, topQuartile } = input;
  const today = series[series.length - 1];
  const base: DailyInsight = {
    title, spec, status: "insufficient", statusReason: null, today: null,
    avg5: null, avg24: null, vs4w: null, yoy: null, topQuartile: null, supplyDev: null, origin: null, signals: [],
  };
  if (!spec) return { ...base, statusReason: "최근 4주 거래 없음" };
  if (!today || today.dateKey !== dateKey) return { ...base, statusReason: "오늘 거래 없음" };

  const t = series.length - 1;
  const todayInfo = { price: price(today), qty: today.qty, n: today.n };
  const filled = { ...base, today: todayInfo, topQuartile, avg5: shortAvg(series, t) };
  const recentDays = series.filter((p) => dayNumber(p.dateKey) > dayNumber(dateKey) - LONG_SPAN_DAYS).length;
  if (recentDays < MIN_POINTS) {
    return { ...filled, statusReason: `최근 5주 거래 ${recentDays}일 — 흐름 판단 보류` };
  }

  const avg24 = longAvg(series, t);
  const supplyDev = supplyDeviation(series, dateKey);
  const signals: Signal[] = [];

  const spike = spikeAt(series, t);
  const spikeLimit = spikeThreshold(series);
  if (spike !== null && Math.abs(spike) > spikeLimit) {
    signals.push({ kind: "spike", title, message: `직전 5일 평균 대비 ${pct(spike)} ${spike > 0 ? "급등" : "급락"} (평소 변동 ±${Math.round(spikeLimit * 100)}% 이내)` });
  }
  const turn = trendSwitch(series);
  if (turn) signals.push({ kind: "trend", title, message: `5일 평균이 4주 평균을 ${turn === "up" ? "넘어선 상승" : "밑도는 하락"} 흐름이 3일째` });
  if (supplyDev !== null && Math.abs(supplyDev) >= FALLBACK.supply) {
    const specName = [shortGradeOf(spec.grade), spec.unit].filter(Boolean).join("·");
    signals.push({ kind: "supply", title, message: `이 규격(${specName}) 물량이 평소 같은 요일보다 ${pct(supplyDev)} → 가격 ${supplyDev > 0 ? "약세" : "강세"} 요인` });
  }

  let origin: DailyInsight["origin"] = null;
  if (originName && originSeries) {
    const gaps = originGaps(series, originSeries);
    const history = gaps.filter((g) => dayNumber(g.dateKey) < dayNumber(dateKey)).map((g) => g.gap);
    const band = originBand(history);
    const todayGap = gaps.find((g) => g.dateKey === dateKey);
    const originToday = originSeries.find((p) => p.dateKey === dateKey);
    origin = { name: originName, price: originToday ? price(originToday) : null, gap: todayGap?.gap ?? null, band };
    const signal = originSignal(title, originName, gaps, band, dateKey, series[t - 1]?.dateKey ?? null);
    if (signal) signals.push(signal);
  }

  const trend = trendAt(series, t);
  return {
    ...filled,
    status: statusOf(signals, trend, trendWatchThreshold(series)),
    avg24,
    vs4w: ratio(todayInfo.price, avg24),
    yoy: yearOverYear(series, dateKey),
    supplyDev,
    origin,
    signals,
  };
}

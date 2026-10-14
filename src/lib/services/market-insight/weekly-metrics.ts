/**
 * 주간 리포트 지표 (순수 함수). 대상 주는 월~일 7일이며 평균은 수량 가중으로 합친다.
 */

import { between, pooledPrice, ratio, shiftDateKey } from "./stats";
import type { DailyPoint, ItemSpec } from "./types";

const YEAR_DAYS = 364;
const MIN_WEEKS_FOR_RANK = 12;
const SMALL_SAMPLE_DAYS = 10;

export interface WeeklyItemInsight {
  title: string;
  spec: ItemSpec | null;
  weekAvg: number | null;
  weekQty: number;
  vsPrevWeek: number | null;
  vs4w: number | null;
  qtyVsPrevWeek: number | null;
  lastYearWeekAvg: number | null;
  yoy: number | null;
  /** 최근 52주 주간 평균 중 이번 주보다 비싼 주의 비율 (0=가장 비쌈) */
  rankTop: number | null;
  /** 작년 같은 주 이후 4주간 가격 변화 (계절 참고) */
  lastYearNext4w: number | null;
  origin: { name: string; weekAvg: number | null; gap: number | null } | null;
}

export interface CorpRow {
  corp: string;
  name: string;
  amount: number;
  qty: number;
  days: number;
}

export interface CorpMonthRow {
  month: string;
  corp: string;
  amount: number;
  qty: number;
}

export interface CorpLine {
  name: string;
  avg: number;
  share: number;
  days: number;
  smallSample: boolean;
}

export interface CorpInsight {
  national: CorpLine[];
  origin: CorpLine[];
  /** 물량 상위 두 법인의 월별 가격 비교 */
  headToHead: { leader: string; other: string; months: number; wins: number } | null;
}

function weekPoints(series: DailyPoint[], monday: string, offsetDays = 0): DailyPoint[] {
  const start = shiftDateKey(monday, offsetDays);
  return between(series, start, shiftDateKey(start, 6));
}

const sumQty = (points: DailyPoint[]) => points.reduce((sum, p) => sum + p.qty, 0);

/** 최근 52주 주간 평균 중 이번 주 순위 (상위 비율) */
function rankTop(series: DailyPoint[], monday: string, weekAvg: number | null): number | null {
  if (weekAvg === null) return null;
  const weeks = Array.from({ length: 52 }, (_, i) => pooledPrice(weekPoints(series, monday, -7 * i)))
    .filter((v): v is number => v !== null);
  if (weeks.length < MIN_WEEKS_FOR_RANK) return null;
  return weeks.filter((v) => v > weekAvg).length / weeks.length;
}

export function computeWeeklyItem(
  title: string,
  spec: ItemSpec | null,
  monday: string,
  series: DailyPoint[],
  originName: string | null,
  originSeries: DailyPoint[] | null
): WeeklyItemInsight {
  const week = weekPoints(series, monday);
  const prev = weekPoints(series, monday, -7);
  const weekAvg = pooledPrice(week);
  const last4w = between(series, shiftDateKey(monday, -28), shiftDateKey(monday, -1));
  const lastYear = weekPoints(series, monday, -YEAR_DAYS);
  const lastYearAvg = lastYear.length >= 2 ? pooledPrice(lastYear) : null;
  const lastYearNext = between(series, shiftDateKey(monday, -YEAR_DAYS + 7), shiftDateKey(monday, -YEAR_DAYS + 34));

  let origin: WeeklyItemInsight["origin"] = null;
  if (originName && originSeries) {
    const originAvg = pooledPrice(weekPoints(originSeries, monday));
    origin = { name: originName, weekAvg: originAvg, gap: ratio(originAvg, weekAvg) };
  }

  return {
    title,
    spec,
    weekAvg,
    weekQty: sumQty(week),
    vsPrevWeek: ratio(weekAvg, pooledPrice(prev)),
    vs4w: ratio(weekAvg, pooledPrice(last4w)),
    qtyVsPrevWeek: prev.length ? ratio(sumQty(week), sumQty(prev)) : null,
    lastYearWeekAvg: lastYearAvg,
    yoy: ratio(weekAvg, lastYearAvg),
    rankTop: rankTop(series, monday, weekAvg),
    lastYearNext4w: lastYearAvg !== null && lastYearNext.length >= 5 ? ratio(pooledPrice(lastYearNext), lastYearAvg) : null,
    origin,
  };
}

function corpLines(rows: CorpRow[]): CorpLine[] {
  const total = rows.reduce((sum, r) => sum + r.qty, 0);
  return rows
    .filter((r) => r.qty > 0)
    .map((r) => ({
      name: r.name,
      avg: r.amount / r.qty,
      share: total > 0 ? r.qty / total : 0,
      days: r.days,
      smallSample: r.days < SMALL_SAMPLE_DAYS,
    }))
    .sort((a, b) => b.avg - a.avg);
}

/** 물량 상위 두 법인이 월별로 몇 번 더 높게 받았는지 (둘 다 거래한 달만) */
function headToHead(national: CorpRow[], months: CorpMonthRow[], names: Map<string, string>): CorpInsight["headToHead"] {
  const top = [...national].sort((a, b) => b.qty - a.qty).slice(0, 2);
  if (top.length < 2) return null;
  const monthly = new Map<string, Map<string, number>>();
  for (const row of months) {
    if (row.qty <= 0) continue;
    const byCorp = monthly.get(row.month) ?? new Map<string, number>();
    monthly.set(row.month, new Map([...byCorp, [row.corp, row.amount / row.qty]]));
  }
  const both = [...monthly.values()].filter((m) => m.has(top[0].corp) && m.has(top[1].corp));
  if (both.length === 0) return null;
  const winsA = both.filter((m) => (m.get(top[0].corp) ?? 0) > (m.get(top[1].corp) ?? 0)).length;
  const [leader, other, wins] = winsA >= both.length - winsA
    ? [top[0].corp, top[1].corp, winsA]
    : [top[1].corp, top[0].corp, both.length - winsA];
  return { leader: names.get(leader) ?? leader, other: names.get(other) ?? other, months: both.length, wins };
}

export function computeCorpInsight(national: CorpRow[], origin: CorpRow[], months: CorpMonthRow[]): CorpInsight {
  const names = new Map(national.map((r) => [r.corp, r.name]));
  return { national: corpLines(national), origin: corpLines(origin), headToHead: headToHead(national, months, names) };
}

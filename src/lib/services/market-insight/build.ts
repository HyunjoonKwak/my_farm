/** 알림 항목 설정 → DB 집계 → 지표 → 텔레그램 본문. */

import { computeDailyInsight } from "./daily-metrics";
import { shortOrigin } from "./format";
import { buildDailyText } from "./format-daily";
import { buildWeeklyText, type WeeklyCorpSection } from "./format-weekly";
import { corpMonths, corpRows, dailySeries, pickSpec, topQuartile } from "./series";
import { shiftDateKey } from "./stats";
import type { DailyInsight, ItemConfig } from "./types";
import { computeCorpInsight, computeWeeklyItem, type WeeklyItemInsight } from "./weekly-metrics";

// 전년 동기(364일 전 ±7일)와 52주 순위·작년 이후 4주까지 보려면 약 400일이 필요하다
const HISTORY_DAYS = 400;
const CORP_DAYS = 28;
// 양 끝 달이 일부만 걸리지 않게 12개월 안쪽으로 (월별 비교는 둘 다 거래한 달만 센다)
const CORP_MONTH_DAYS = 334;

const titleOf = (item: ItemConfig) => item.label.trim() || item.productName;

async function dailyItem(item: ItemConfig, dateKey: string): Promise<DailyInsight> {
  const spec = await pickSpec(item, dateKey);
  const originName = item.origin ? shortOrigin(item.origin) : null;
  const base = { title: titleOf(item), spec, dateKey, originName, topQuartile: null };
  if (!spec) return computeDailyInsight({ ...base, series: [], originSeries: null });
  const from = shiftDateKey(dateKey, -HISTORY_DAYS);
  const [series, originSeries, quartile] = await Promise.all([
    dailySeries(item.productName, spec, from, dateKey),
    item.origin ? dailySeries(item.productName, spec, from, dateKey, item.origin) : Promise.resolve(null),
    topQuartile(item.productName, spec, dateKey),
  ]);
  return computeDailyInsight({ ...base, series, originSeries, topQuartile: quartile });
}

export interface BuiltMessage {
  text: string;
  hasTrades: boolean;
}

export async function buildDailyBriefing(dateKey: string, items: ItemConfig[], appUrl: string | null): Promise<BuiltMessage> {
  const insights = await Promise.all(items.map((item) => dailyItem(item, dateKey)));
  return { text: buildDailyText(dateKey, insights, appUrl), hasTrades: insights.some((i) => i.today !== null) };
}

async function weeklyItem(item: ItemConfig, monday: string): Promise<{ insight: WeeklyItemInsight; corp: WeeklyCorpSection | null }> {
  const sunday = shiftDateKey(monday, 6);
  const spec = await pickSpec(item, sunday);
  const originName = item.origin ? shortOrigin(item.origin) : null;
  if (!spec) return { insight: computeWeeklyItem(titleOf(item), null, monday, [], null, null), corp: null };

  const corpFrom = shiftDateKey(sunday, -(CORP_DAYS - 1));
  const [series, originSeries, national, origin, months] = await Promise.all([
    dailySeries(item.productName, spec, shiftDateKey(monday, -HISTORY_DAYS), sunday),
    item.origin ? dailySeries(item.productName, spec, shiftDateKey(monday, -HISTORY_DAYS), sunday, item.origin) : Promise.resolve(null),
    corpRows(item.productName, spec, corpFrom, sunday),
    item.origin ? corpRows(item.productName, spec, corpFrom, sunday, item.origin) : Promise.resolve([]),
    corpMonths(item.productName, spec, shiftDateKey(sunday, -CORP_MONTH_DAYS), sunday),
  ]);
  return {
    insight: computeWeeklyItem(titleOf(item), spec, monday, series, originName, originSeries),
    corp: { title: titleOf(item), originName, corp: computeCorpInsight(national, origin, months) },
  };
}

export async function buildWeeklyReport(monday: string, items: ItemConfig[], appUrl: string | null): Promise<BuiltMessage> {
  const results = await Promise.all(items.map((item) => weeklyItem(item, monday)));
  const insights = results.map((r) => r.insight);
  return {
    text: buildWeeklyText(monday, insights, results.flatMap((r) => (r.corp ? [r.corp] : [])), appUrl),
    hasTrades: insights.some((i) => i.weekAvg !== null),
  };
}

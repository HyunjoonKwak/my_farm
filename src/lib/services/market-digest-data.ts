/**
 * 일일 경매 요약 데이터 조회 — 알림 항목(MarketDigestItem)별 대표 가격 계산.
 *
 * 항목 범위 = 품목 + (지정 품종 목록 | 그날 물량 최다 품종) + (지정 산지 | 전체 산지).
 * - 지정 산지에 그날 거래가 없으면 전체 산지로 대체하고 표시한다 (산지별 출하 시기가 달라 빈 날이 많음).
 * - 대표 가격은 범위 안에서 물량이 가장 많은 등급·단위 그룹의 수량 가중평균이다 (단위 혼합 평균 금지).
 * - 전일 비교는 같은 범위·등급·단위의 직전 거래일과 한다.
 */

import { z } from "zod";
import prisma from "@/lib/prisma";
import { packageKg } from "@/lib/market-analysis";
import { marketDateKey, marketDayStart } from "@/lib/market-date";
import { pickRepresentativeGroup, weightedAveragePrice } from "./garak-market";
import type { DigestItemRow } from "./market-digest-format";

const DAY_MS = 86_400_000;

export interface DigestItemConfig {
  productName: string;
  label: string;
  varieties: string[];
  origin: string;
}

interface TradeRow {
  price: number;
  quantity: number;
  unit: string;
  variety: string;
  grade: string;
}

interface Scope {
  productName: string;
  origin: string;
  varieties: string[];
}

const varietiesSchema = z.array(z.string()).catch([]);

/** DB의 JSON 문자열 품종 목록을 안전하게 배열로 바꾼다 (깨진 값은 빈 목록 = 자동). */
export function parseVarieties(raw: string): string[] {
  try {
    return varietiesSchema.parse(JSON.parse(raw)).map((v) => v.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function scopeWhere(scope: Scope) {
  return {
    productName: scope.productName,
    ...(scope.origin ? { origin: scope.origin } : {}),
    ...(scope.varieties.length > 0 ? { variety: { in: scope.varieties } } : {}),
  };
}

function dayWindow(dateKey: string) {
  const start = marketDayStart(dateKey);
  return { gte: start, lt: new Date(start.getTime() + DAY_MS) };
}

async function fetchDayRows(scope: Scope, dateKey: string): Promise<TradeRow[]> {
  return prisma.auctionResult.findMany({
    where: { ...scopeWhere(scope), auctionDate: dayWindow(dateKey) },
    select: { price: true, quantity: true, unit: true, variety: true, grade: true },
  });
}

/** 품종 미지정 항목: 그날 물량이 가장 많은 품종 하나로 좁힌다. */
function topVariety(rows: TradeRow[]): string {
  const totals = rows.reduce(
    (acc, row) => acc.set(row.variety, (acc.get(row.variety) ?? 0) + row.quantity),
    new Map<string, number>()
  );
  return [...totals.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

async function previousAverage(scope: Scope, grade: string, unit: string, before: Date) {
  const where = { ...scopeWhere(scope), grade, unit };
  const prev = await prisma.auctionResult.findFirst({
    where: { ...where, auctionDate: { lt: before } },
    orderBy: { auctionDate: "desc" },
    select: { auctionDate: true },
  });
  if (!prev) return null;
  const prevKey = marketDateKey(prev.auctionDate);
  const rows = await prisma.auctionResult.findMany({
    where: { ...where, auctionDate: dayWindow(prevKey) },
    select: { price: true, quantity: true },
  });
  const avg = weightedAveragePrice(rows);
  return avg > 0 ? { dateKey: prevKey, avg } : null;
}

export async function buildItemRow(item: DigestItemConfig, dateKey: string): Promise<DigestItemRow> {
  const title = item.label.trim() || item.productName;
  const base: Scope = { productName: item.productName, origin: item.origin, varieties: item.varieties };
  let scope = base;
  let rows = await fetchDayRows(scope, dateKey);
  const originFallback = rows.length === 0 && Boolean(item.origin);
  if (originFallback) {
    scope = { ...base, origin: "" };
    rows = await fetchDayRows(scope, dateKey);
  }
  const empty: DigestItemRow = {
    title, autoVariety: null, origin: item.origin, originFallback: false,
    tradeCount: 0, totalQuantity: 0, representative: null, change: null,
  };
  if (rows.length === 0) return empty;

  let autoVariety: string | null = null;
  if (item.varieties.length === 0) {
    autoVariety = topVariety(rows);
    scope = { ...scope, varieties: [autoVariety] };
    rows = rows.filter((row) => row.variety === autoVariety);
  }

  // 품종 목록은 같은 품종의 다른 표기이므로 등급·단위로만 묶는다
  const group = pickRepresentativeGroup(rows.map((row) => ({ ...row, variety: "" })));
  const avgPrice = weightedAveragePrice(group.rows);
  const kg = packageKg(group.unit);
  const prev = await previousAverage(scope, group.grade, group.unit, marketDayStart(dateKey));

  return {
    ...empty,
    autoVariety: autoVariety || null,
    originFallback,
    tradeCount: rows.length,
    totalQuantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    representative: { grade: group.grade, unit: group.unit, avgPrice, kgPrice: kg ? Math.round(avgPrice / kg) : null },
    change: prev ? { prevDateKey: prev.dateKey, pct: ((avgPrice - prev.avg) / prev.avg) * 100 } : null,
  };
}

/** 요약을 켠 설정들의 활성 항목 (정렬 순서대로). */
export async function getDigestItems(): Promise<DigestItemConfig[]> {
  const settings = await prisma.marketCollectionSettings.findMany({
    where: { digestEnabled: true },
    orderBy: { createdAt: "asc" },
    select: { digestItems: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } },
  });
  return settings.flatMap((s) =>
    s.digestItems.map((item) => ({
      productName: item.productName,
      label: item.label,
      varieties: parseVarieties(item.varieties),
      origin: item.origin,
    }))
  );
}

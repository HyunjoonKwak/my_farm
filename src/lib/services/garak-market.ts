/**
 * 가락시장 공공데이터 API 서비스 — 조회(읽기) 계층.
 * http://www.garak.co.kr/homepage/publicdata/dataOpen.do
 *
 * 수집(fetch/저장/로그)은 garak-collector, 응답 파싱·날짜 유틸은 garak-parse에 있다.
 * 기존 import 경로 호환을 위해 여기서 다시 내보낸다.
 */

import { marketDateKey, marketWindowStart } from "@/lib/market-date";
import { packageKg } from "@/lib/market-analysis";
import { summarizeMarketPrices } from "@/lib/market-price-statistics";
import prisma from "@/lib/prisma";
import { MARKET_PRODUCTS } from "@/lib/constants/market-products";
import { dayRange } from "./garak-parse";

export {
  parseXmlResponse,
  parseGarakResponse,
  GarakResponseError,
  formatDateKey,
  parseYmdDate,
  dayRange,
  type AuctionItem,
  type GarakApiResponse,
  type ParsedGarakResponse,
} from "./garak-parse";

export {
  CORPORATION_CODES,
  collectAndSaveAuctionData,
  cleanupOldAuctionData,
  fetchAuctionData,
  fetchAuctionPage,
  GarakFetchError,
  getGarakApiUrl,
  DEFAULT_GARAK_API_URL,
  type CollectionStatus,
  type CollectionResult,
  type CorporationCollectionResult,
  type ProductCollectionResult,
  type CollectorDeps,
} from "./garak-collector";

// 주요 품목 목록 (공용 상수 재노출 — 기존 import 경로 호환)
export const MAJOR_PRODUCTS: readonly string[] = MARKET_PRODUCTS;

/**
 * 단위 문자열에서 kg 값 추출 (예: "10kg" -> 10, "5KG" -> 5)
 */
export function parseKgFromUnit(unit: string): number | null {
  return packageKg(unit);
}

export function weightedAveragePrice(
  items: { price: number; quantity: number }[]
): number {
  const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0);
  if (totalQuantity <= 0) return 0;
  const totalWeighted = items.reduce(
    (sum, i) => sum + i.price * i.quantity,
    0
  );
  return Math.round(totalWeighted / totalQuantity);
}

/**
 * 품목별 일자별 평균가격 조회 (가중평균 + kg당 단가)
 */
export async function getProductPriceHistory(
  productName: string,
  days: number = 30,
  variety?: string,
  origin?: string,
  varieties?: string[],
  unit?: string,
  grade?: string
) {
  const startDate = marketWindowStart(days);

  const where: {
    productName: string;
    auctionDate: { gte: Date };
    variety?: string | { in: string[] };
    origin?: { contains: string };
    unit?: string;
    grade?: string;
  } = {
    productName,
    auctionDate: { gte: startDate },
  };

  // 다중 품종 필터 (varieties 배열)가 있으면 우선 사용
  if (varieties && varieties.length > 0) {
    where.variety = { in: varieties };
  } else if (variety) {
    where.variety = variety;
  }

  if (origin) {
    // 부분 일치 검색 (예: "충남" 입력 시 "충남 논산", "충남 예산" 등 매칭)
    where.origin = { contains: origin };
  }

  if (unit) {
    where.unit = unit;
  }

  if (grade) where.grade = grade;

  const records = await prisma.auctionResult.findMany({
    where,
    select: {
      auctionDate: true,
      price: true,
      quantity: true,
      unit: true,
    },
    orderBy: { auctionDate: "desc" },
  });

  // 한국 날짜별로 그룹화 (서버 타임존과 무관)
  const dateGroups = new Map<string, typeof records>();
  for (const record of records) {
    const dateKey = marketDateKey(record.auctionDate);
    const group = dateGroups.get(dateKey) || [];
    group.push(record);
    dateGroups.set(dateKey, group);
  }

  const results = Array.from(dateGroups.entries()).flatMap(([dateKey, items]) => {
    const stats = summarizeMarketPrices(items);
    return stats ? [{ date: dateKey, ...stats }] : [];
  });

  results.sort((a, b) => b.date.localeCompare(a.date));

  // 휴장일은 추론하지 않는다. 예전 NO_AUCTION 로그는 "그 품목 0건"이거나 수집 실패(HTML/오류 응답을
  // 0건으로 잘못 읽은 경우)일 수 있어 휴장 근거가 되지 못한다. 필드는 클라이언트 호환을 위해 빈 배열로 유지.
  const noAuctionDates: string[] = [];

  return { history: results, noAuctionDates };
}

/**
 * 관심 품목용 최신 시세 정보.
 * 최신 거래일의 품종·등급·단위 그룹 중 물량이 가장 많은 그룹을 대표로 삼고,
 * 등락은 정확히 같은 그룹의 직전 거래일과 비교한다. 조건 없는 혼합 평균은 쓰지 않는다.
 */
export async function getWatchlistPriceInfo(
  productName: string,
  variety?: string,
  origin?: string
): Promise<{
  latestPrice: number | null;
  latestDate: Date | null;
  unit: string | null;
  latestVariety: string | null;
  latestGrade: string | null;
  priceChange: number | null;
}> {
  const where = {
    productName,
    ...(variety ? { variety } : {}),
    ...(origin ? { origin } : {}),
  };

  const empty = {
    latestPrice: null,
    latestDate: null,
    unit: null,
    latestVariety: null,
    latestGrade: null,
    priceChange: null,
  };

  const latest = await prisma.auctionResult.findFirst({
    where,
    orderBy: { auctionDate: "desc" },
    select: { auctionDate: true },
  });
  if (!latest) return empty;

  const latestRows = await prisma.auctionResult.findMany({
    where: { ...where, auctionDate: dayRange(latest.auctionDate) },
    select: { price: true, quantity: true, unit: true, variety: true, grade: true },
  });
  if (latestRows.length === 0) return empty;

  const representative = pickRepresentativeGroup(latestRows);
  const latestAvg = weightedAveragePrice(representative.rows);

  // 직전 거래일: 정확히 같은 품종·등급·단위 그룹만
  const groupWhere = {
    ...where,
    variety: representative.variety,
    grade: representative.grade,
    unit: representative.unit,
  };
  const prev = await prisma.auctionResult.findFirst({
    where: { ...groupWhere, auctionDate: { lt: dayRange(latest.auctionDate).gte } },
    orderBy: { auctionDate: "desc" },
    select: { auctionDate: true },
  });

  let priceChange: number | null = null;
  if (prev) {
    const prevRows = await prisma.auctionResult.findMany({
      where: { ...groupWhere, auctionDate: dayRange(prev.auctionDate) },
      select: { price: true, quantity: true },
    });
    const prevAvg = weightedAveragePrice(prevRows);
    if (prevAvg > 0) {
      priceChange = ((latestAvg - prevAvg) / prevAvg) * 100;
    }
  }

  return {
    latestPrice: latestAvg || null,
    latestDate: latest.auctionDate,
    unit: representative.unit,
    latestVariety: representative.variety || null,
    latestGrade: representative.grade || null,
    priceChange,
  };
}

interface GroupRow {
  price: number;
  quantity: number;
  unit: string;
  variety: string | null;
  grade: string | null;
}

/** 품종·등급·단위가 같은 행끼리 묶어 총 물량이 가장 많은 그룹을 고른다 (동률이면 행 수). */
export function pickRepresentativeGroup(rows: GroupRow[]): {
  variety: string;
  grade: string;
  unit: string;
  rows: GroupRow[];
  totalQuantity: number;
} {
  const groups = new Map<string, { variety: string; grade: string; unit: string; rows: GroupRow[]; totalQuantity: number }>();
  for (const row of rows) {
    const variety = row.variety ?? "";
    const grade = row.grade ?? "";
    const key = `${variety}|${grade}|${row.unit}`;
    const group = groups.get(key) ?? { variety, grade, unit: row.unit, rows: [], totalQuantity: 0 };
    groups.set(key, {
      ...group,
      rows: [...group.rows, row],
      totalQuantity: group.totalQuantity + row.quantity,
    });
  }
  return Array.from(groups.values()).reduce((best, group) =>
    group.totalQuantity > best.totalQuantity ||
    (group.totalQuantity === best.totalQuantity && group.rows.length > best.rows.length)
      ? group
      : best
  );
}

/**
 * 품목별 품종 목록 조회
 */
export async function getProductVarieties(productName: string) {
  // Prisma의 distinct는 앱에서 중복을 제거하므로 품목의 모든 행을 받아온다.
  // groupBy는 DB가 집계해 후보 개수만 돌려준다 (품목당 수십만 행 → 수십 행).
  const varieties = await prisma.auctionResult.groupBy({
    by: ["variety"],
    where: { productName },
    orderBy: { variety: "asc" },
  });

  return varieties
    .map((v) => v.variety)
    .filter((v): v is string => v !== null && v !== "");
}

/**
 * 품목별 산지 목록 조회
 */
export async function getProductOrigins(productName: string) {
  const origins = await prisma.auctionResult.groupBy({
    by: ["origin"],
    where: { productName },
    orderBy: { origin: "asc" },
  });

  return origins
    .map((o) => o.origin)
    .filter((o): o is string => o !== null && o !== "");
}

/**
 * 저장된 품목 목록 조회
 */
export async function getAvailableProducts() {
  const products = await prisma.auctionResult.findMany({
    distinct: ["productName"],
    select: { productName: true },
    orderBy: { productName: "asc" },
  });

  return products.map((p) => p.productName);
}

/**
 * 특정 날짜의 품목별 시세 요약
 */
export async function getDailySummary(date: Date, productNames?: string[]) {
  const where: {
    auctionDate: { gte: Date; lte: Date };
    productName?: { in: string[] };
  } = {
    auctionDate: dayRange(date),
  };

  if (productNames && productNames.length > 0) {
    where.productName = { in: productNames };
  }

  const results = await prisma.auctionResult.groupBy({
    by: ["productName"],
    where,
    _avg: { price: true },
    _max: { price: true },
    _min: { price: true },
    _count: { price: true },
    _sum: { quantity: true },
  });

  return results.map((r) => ({
    productName: r.productName,
    avgPrice: Math.round(r._avg.price || 0),
    maxPrice: r._max.price || 0,
    minPrice: r._min.price || 0,
    tradeCount: r._count.price,
    totalQuantity: r._sum.quantity || 0,
  }));
}

/**
 * 최근 수집된 데이터 날짜 조회
 */
export async function getLatestCollectionDate(): Promise<Date | null> {
  const latest = await prisma.auctionResult.findFirst({
    orderBy: { auctionDate: "desc" },
    select: { auctionDate: true },
  });

  return latest?.auctionDate || null;
}

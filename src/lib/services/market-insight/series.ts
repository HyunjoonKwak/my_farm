/**
 * 시세 인사이트용 DB 집계. 행을 내려받지 않고 SQLite에서 날짜·법인별로 합산한다.
 * auctionDate는 epoch ms 정수로 저장되며, 날짜 키는 서버 TZ와 무관하게 KST(+9h)로 만든다.
 */

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { weightedQuantile } from "@/lib/market-analysis";
import { CORPORATION_CODES } from "@/lib/services/garak-collector";
import { shiftDateKey } from "./stats";
import type { DailyPoint, ItemConfig, ItemSpec } from "./types";
import type { CorpMonthRow, CorpRow } from "./weekly-metrics";

const SPEC_WINDOW_DAYS = 28;
const KST_DAY = Prisma.sql`date(auctionDate / 1000, 'unixepoch', '+9 hours')`;

/** KST 날짜 키 → 그날 00:00 KST의 epoch ms */
export function kstStartMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00+09:00`);
}

function range(fromKey: string, toKey: string) {
  return Prisma.sql`auctionDate >= ${kstStartMs(fromKey)} AND auctionDate < ${kstStartMs(shiftDateKey(toKey, 1))}`;
}

function specFilter(productName: string, spec: ItemSpec, origin?: string) {
  return Prisma.sql`productName = ${productName}
    AND variety IN (${Prisma.join(spec.varieties)})
    AND grade = ${spec.grade} AND unit = ${spec.unit}
    ${origin ? Prisma.sql`AND origin = ${origin}` : Prisma.empty}`;
}

const num = (value: unknown) => Number(value ?? 0);

interface SpecRow { variety: string; grade: string; unit: string; qty: unknown }

/** 최근 28일 물량 기준으로 품목의 기준 규격(품종·등급·단위)을 고른다. */
export async function pickSpec(item: ItemConfig, dateKey: string): Promise<ItemSpec | null> {
  const varietyFilter = item.varieties.length
    ? Prisma.sql`AND variety IN (${Prisma.join(item.varieties)})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<SpecRow[]>`
    SELECT variety, grade, unit, SUM(quantity) AS qty FROM AuctionResult
    WHERE productName = ${item.productName} ${varietyFilter}
      AND ${range(shiftDateKey(dateKey, -(SPEC_WINDOW_DAYS - 1)), dateKey)}
    GROUP BY variety, grade, unit`;
  if (rows.length === 0) return null;

  const totals = (key: (r: SpecRow) => string, list: SpecRow[]) =>
    list.reduce((acc, r) => acc.set(key(r), (acc.get(key(r)) ?? 0) + num(r.qty)), new Map<string, number>());
  const top = (m: Map<string, number>) => [...m.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];

  const autoVariety = item.varieties.length ? null : top(totals((r) => r.variety, rows));
  const scoped = autoVariety === null ? rows : rows.filter((r) => r.variety === autoVariety);
  const [grade, unit] = top(totals((r) => `${r.grade}\u0000${r.unit}`, scoped)).split("\u0000");
  return { varieties: autoVariety === null ? item.varieties : [autoVariety], autoVariety, grade, unit };
}

/** 기준 규격의 일별 집계 (오름차순) */
export async function dailySeries(
  productName: string, spec: ItemSpec, fromKey: string, toKey: string, origin?: string
): Promise<DailyPoint[]> {
  const rows = await prisma.$queryRaw<{ d: string; amount: unknown; qty: unknown; n: unknown }[]>`
    SELECT ${KST_DAY} AS d, SUM(price * quantity) AS amount, SUM(quantity) AS qty, COUNT(*) AS n
    FROM AuctionResult
    WHERE ${specFilter(productName, spec, origin)} AND ${range(fromKey, toKey)}
    GROUP BY d ORDER BY d`;
  return rows.map((r) => ({ dateKey: r.d, amount: num(r.amount), qty: num(r.qty), n: num(r.n) }));
}

/** 그날 기준 규격의 수량 가중 상위 25% 가격 */
export async function topQuartile(productName: string, spec: ItemSpec, dateKey: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ price: unknown; quantity: unknown }[]>`
    SELECT price, quantity FROM AuctionResult
    WHERE ${specFilter(productName, spec)} AND ${range(dateKey, dateKey)}`;
  return weightedQuantile(rows.map((r) => ({ price: num(r.price), quantity: num(r.quantity) })), 0.75);
}

/** 기간 내 법인별 합계 (거래일 수 포함) */
export async function corpRows(
  productName: string, spec: ItemSpec, fromKey: string, toKey: string, origin?: string
): Promise<CorpRow[]> {
  const rows = await prisma.$queryRaw<{ corp: string; amount: unknown; qty: unknown; days: unknown }[]>`
    SELECT corporationCode AS corp, SUM(price * quantity) AS amount, SUM(quantity) AS qty,
           COUNT(DISTINCT ${KST_DAY}) AS days
    FROM AuctionResult
    WHERE ${specFilter(productName, spec, origin)} AND ${range(fromKey, toKey)}
    GROUP BY corporationCode`;
  return rows.map((r) => ({
    corp: r.corp,
    name: CORPORATION_CODES[r.corp] ?? r.corp,
    amount: num(r.amount),
    qty: num(r.qty),
    days: num(r.days),
  }));
}

/** 월·법인별 합계 (법인 간 월별 비교용) */
export async function corpMonths(productName: string, spec: ItemSpec, fromKey: string, toKey: string): Promise<CorpMonthRow[]> {
  const rows = await prisma.$queryRaw<{ month: string; corp: string; amount: unknown; qty: unknown }[]>`
    SELECT substr(${KST_DAY}, 1, 7) AS month, corporationCode AS corp,
           SUM(price * quantity) AS amount, SUM(quantity) AS qty
    FROM AuctionResult
    WHERE ${specFilter(productName, spec)} AND ${range(fromKey, toKey)}
    GROUP BY month, corporationCode`;
  return rows.map((r) => ({ month: r.month, corp: r.corp, amount: num(r.amount), qty: num(r.qty) }));
}

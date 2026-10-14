/** 시계열 통계 유틸 (순수 함수). */

import type { DailyPoint } from "./types";

export const DAY_MS = 86_400_000;

export function price(point: DailyPoint): number {
  return point.qty > 0 ? point.amount / point.qty : 0;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

/** 선형 보간 없는 단순 분위수 (정렬 후 위치 반올림). */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[index];
}

/**
 * 끝이 index인 window개 포인트의 평균 가격.
 * 포인트가 모자라거나 첫 포인트가 maxSpanDays보다 오래됐으면 null — 휴지기를 건너 지난 시즌 가격이
 * 섞이지 않게 한다 (예: 몇 달 만에 다시 거래되는 첫날).
 */
export function windowAvg(points: DailyPoint[], index: number, window: number, maxSpanDays = Infinity): number | null {
  if (index < 0 || index + 1 < window) return null;
  const slice = points.slice(index + 1 - window, index + 1);
  if (dayNumber(slice[slice.length - 1].dateKey) - dayNumber(slice[0].dateKey) > maxSpanDays) return null;
  return mean(slice.map(price));
}

export function dayNumber(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00Z`) / DAY_MS;
}

export function weekday(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

export function shiftDateKey(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** [from, to] 범위(포함)의 포인트 */
export function between(points: DailyPoint[], from: string, to: string): DailyPoint[] {
  return points.filter((p) => p.dateKey >= from && p.dateKey <= to);
}

/** 여러 날을 수량 가중으로 합친 평균 가격 */
export function pooledPrice(points: DailyPoint[]): number | null {
  const qty = points.reduce((sum, p) => sum + p.qty, 0);
  return qty > 0 ? points.reduce((sum, p) => sum + p.amount, 0) / qty : null;
}

export function ratio(current: number | null, base: number | null): number | null {
  return current !== null && base !== null && base > 0 ? current / base - 1 : null;
}

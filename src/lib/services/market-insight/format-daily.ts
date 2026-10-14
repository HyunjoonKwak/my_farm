/** 일일 브리핑 본문: 한눈에 → 주의 신호(최대 3개) → 품목별 상세. */

import { STATUS_ICON, appLink, count, dateLabel, joinWithinLimit, pct, specLabel, won } from "./format";
import type { DailyInsight, SignalKind } from "./types";

const MAX_SIGNALS = 3;
// 농가가 바로 확인할 일(산지 괴리)을 먼저, 공급 변화는 마지막에
const SIGNAL_PRIORITY: SignalKind[] = ["originGap", "spike", "trend", "supply"];

function headline(item: DailyInsight): string {
  const icon = STATUS_ICON[item.status];
  if (!item.today || !item.spec) return `${icon} ${item.title} — ${item.statusReason ?? "거래 없음"}`;
  const first = `${icon} ${item.title} ${won(item.today.price)} (${specLabel(item.spec)})`;
  if (item.status === "insufficient") return `${first}\n   ${item.statusReason}`;
  // 색과 숫자가 어긋나 보이지 않게 이 품목의 평소 변동폭 기준 판단을 함께 적는다
  const context = item.status === "calm" ? " (평소 범위)" : item.status === "watch" ? " (평소보다 큰 움직임)" : "";
  const parts = [
    item.vs4w !== null ? `4주 평균 대비 ${pct(item.vs4w)}${context}` : null,
    item.yoy !== null ? `전년 동기 ${pct(item.yoy)}` : null,
  ].filter(Boolean);
  return parts.length ? `${first}\n   ${parts.join(" · ")}` : first;
}

function signalSection(items: DailyInsight[]): string {
  const signals = items
    .flatMap((item) => item.signals)
    .sort((a, b) => SIGNAL_PRIORITY.indexOf(a.kind) - SIGNAL_PRIORITY.indexOf(b.kind))
    .slice(0, MAX_SIGNALS);
  if (signals.length === 0) return "✅ 특이 신호 없음 — 평소 범위 안의 움직임";
  return ["⚠️ 주의", ...signals.map((s) => `• [${s.title}] ${s.message}`)].join("\n");
}

function detail(item: DailyInsight): string | null {
  if (!item.today || !item.spec) return null;
  const lines = [`[${item.title}] ${specLabel(item.spec)} · 전국`];
  const averages = [
    `오늘 ${count(item.today.price)}`,
    item.avg5 !== null ? `5일 ${count(item.avg5)}` : null,
    item.avg24 !== null ? `4주 ${count(item.avg24)}` : null,
  ].filter(Boolean);
  lines.push(` ${averages.join(" │ ")}`);
  if (item.topQuartile !== null) lines.push(` 상위 25% ${won(item.topQuartile)} (좋은 물건 기준선)`);
  const supply = item.supplyDev !== null ? ` · 평소 같은 요일 대비 ${pct(item.supplyDev)}` : "";
  lines.push(` 물량 ${count(item.today.qty)}개 · ${count(item.today.n)}건${supply}`);
  if (item.origin) {
    const { name, price, gap, band } = item.origin;
    lines.push(price !== null && gap !== null
      ? ` ${name} ${won(price)} · 전국 대비 ${pct(gap)} (평소 ${pct(band[0])}~${pct(band[1])})`
      : ` ${name} 오늘 거래 없음`);
  }
  return lines.join("\n");
}

export function buildDailyText(dateKey: string, items: DailyInsight[], appUrl: string | null): string {
  const title = `📊 가락시장 브리핑 · ${dateLabel(dateKey)}`;
  if (items.every((item) => !item.today)) {
    return `${title}\n${items.map((item) => item.title).join("·")} 수집된 거래 없음 · 휴장 추정`;
  }
  const details = items.map(detail).filter((d): d is string => d !== null);
  return joinWithinLimit(
    [`${title}\n\n${items.map(headline).join("\n")}`, signalSection(items)],
    details,
    appLink(appUrl)
  );
}

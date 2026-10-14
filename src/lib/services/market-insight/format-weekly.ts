/** 주간 리포트 본문 (월요일): 품목별 주간 흐름 → 출하 법인 비교. */

import { appLink, count, dateLabel, josa, joinWithinLimit, pct, specLabel, won } from "./format";
import { shiftDateKey } from "./stats";
import type { CorpInsight, CorpLine, WeeklyItemInsight } from "./weekly-metrics";

export interface WeeklyCorpSection {
  title: string;
  originName: string | null;
  corp: CorpInsight;
}

function itemBlock(item: WeeklyItemInsight): string {
  if (!item.spec || item.weekAvg === null) return `[${item.title}] 지난주 거래 없음`;
  const lines = [`[${item.title}] ${specLabel(item.spec)} · 전국`];
  const moves = [
    item.vsPrevWeek !== null ? `전주 대비 ${pct(item.vsPrevWeek)}` : null,
    item.vs4w !== null ? `4주 대비 ${pct(item.vs4w)}` : null,
  ].filter(Boolean);
  lines.push(` 주간 평균 ${won(item.weekAvg)}${moves.length ? ` · ${moves.join(" · ")}` : ""}`);
  if (item.lastYearWeekAvg !== null && item.yoy !== null) {
    lines.push(` 전년 같은 주 ${won(item.lastYearWeekAvg)} (${pct(item.yoy)})`);
  }
  const qtyMove = item.qtyVsPrevWeek !== null ? ` · 전주 대비 ${pct(item.qtyVsPrevWeek)}` : "";
  lines.push(` 물량 ${count(item.weekQty)}개${qtyMove}`);
  if (item.rankTop !== null) {
    const level = item.rankTop <= 0.33 ? "비싼 편" : item.rankTop >= 0.67 ? "싼 편" : "중간";
    const position = item.rankTop <= 0.5
      ? `상위 ${Math.round(item.rankTop * 100)}%`
      : `하위 ${Math.round((1 - item.rankTop) * 100)}%`;
    lines.push(` 최근 52주 중 ${position} 가격대 (${level})`);
  }
  if (item.origin) {
    const { name, weekAvg, gap } = item.origin;
    lines.push(weekAvg !== null && gap !== null ? ` ${name} ${won(weekAvg)} · 전국 대비 ${pct(gap)}` : ` ${name} 지난주 거래 없음`);
  }
  if (item.lastYearNext4w !== null) lines.push(` 참고: 작년 이 시기 이후 4주 ${pct(item.lastYearNext4w)} (예측 아님)`);
  return lines.join("\n");
}

function corpList(lines: CorpLine[]): string {
  return lines
    .map((l) => `${l.name} ${count(l.avg)}(${Math.round(l.share * 100)}%${l.smallSample ? `, ${l.days}일·표본 적음` : ""})`)
    .join(" · ");
}

function corpBlock(section: WeeklyCorpSection): string | null {
  const { corp, title, originName } = section;
  if (corp.national.length === 0) return null;
  const lines = [`🏢 출하 법인 · ${title} (최근 4주, 높은 순)`, ` 전국: ${corpList(corp.national)}`];
  if (originName && corp.origin.length) lines.push(` ${originName}산: ${corpList(corp.origin)}`);
  if (corp.headToHead) {
    const { leader, other, months, wins } = corp.headToHead;
    lines.push(` 최근 ${months}개월 중 ${leader}${josa(leader, "이", "가")} ${other}보다 높았던 달 ${wins}개월`);
  }
  lines.push(" ※ 법인 간 차이는 물건 품질·산지 구성 차이일 수 있음");
  return lines.join("\n");
}

export function buildWeeklyText(
  monday: string,
  items: WeeklyItemInsight[],
  corps: WeeklyCorpSection[],
  appUrl: string | null
): string {
  const title = `📅 주간 시세 리포트 · ${dateLabel(monday)}~${dateLabel(shiftDateKey(monday, 6))}`;
  const corpBlocks = corps.map(corpBlock).filter((b): b is string => b !== null);
  return joinWithinLimit([title, ...items.map(itemBlock)], corpBlocks, appLink(appUrl));
}

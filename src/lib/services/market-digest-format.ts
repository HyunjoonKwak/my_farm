/**
 * 일일 경매 요약 텍스트 포맷터 (순수 함수 — DB·네트워크 없음).
 * 텔레그램에는 parse_mode 없이 일반 텍스트로 보낸다 (품종·등급명의 특수문자 이스케이프 회피).
 */

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const numberFormat = new Intl.NumberFormat("ko-KR");
// Telegram sendMessage 본문 한도는 4096자
export const MAX_MESSAGE_LENGTH = 4000;

export interface DigestItemRow {
  /** 표시 이름 (항목 라벨, 없으면 품목명) */
  title: string;
  /** 품종을 지정하지 않아 그날 물량 최다 품종을 자동 선택했으면 그 품종명 */
  autoVariety: string | null;
  /** 지정 산지 (빈 문자열 = 전체 산지) */
  origin: string;
  /** 지정 산지에 그날 거래가 없어 전체 산지로 대체했는지 */
  originFallback: boolean;
  tradeCount: number;
  totalQuantity: number;
  representative: { grade: string; unit: string; avgPrice: number; kgPrice: number | null } | null;
  change: { prevDateKey: string; pct: number } | null;
}

function shortDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month}/${day}`;
}

function dateLabel(dateKey: string): string {
  const weekday = WEEKDAYS[new Date(`${dateKey}T00:00:00Z`).getUTCDay()];
  return `${shortDate(dateKey)}(${weekday})`;
}

function won(value: number): string {
  return `${numberFormat.format(value)}원`;
}

/** "경기도 평택시" → "평택시" */
export function shortOrigin(origin: string): string {
  const parts = origin.trim().split(/\s+/);
  return parts[parts.length - 1] ?? origin;
}

function scopeLabel(row: DigestItemRow): string {
  if (!row.origin) return "전체 산지";
  const name = shortOrigin(row.origin);
  return row.originFallback ? `전체 산지(${name} 거래 없음)` : name;
}

function changeLine(change: DigestItemRow["change"]): string {
  if (!change) return "직전 거래 비교 없음";
  const rounded = Math.round(change.pct * 10) / 10;
  const mark = rounded > 0 ? "▲" : rounded < 0 ? "▼" : "＝";
  return `직전 거래일 ${shortDate(change.prevDateKey)} 대비 ${mark}${Math.abs(rounded).toFixed(1)}%`;
}

function itemBlock(row: DigestItemRow): string {
  const rep = row.representative;
  if (!rep || row.tradeCount === 0) return `[${row.title}] 거래 없음`;
  const spec = [row.autoVariety, scopeLabel(row), rep.grade, rep.unit].filter(Boolean).join(" · ");
  const kg = rep.kgPrice === null ? "—" : won(rep.kgPrice);
  return [
    `[${row.title}] ${spec}`,
    `평균 ${won(rep.avgPrice)} (kg당 ${kg})`,
    changeLine(row.change),
    `물량 ${numberFormat.format(row.totalQuantity)}개 · ${numberFormat.format(row.tradeCount)}건`,
  ].join("\n");
}

/** 요약 행 → 텔레그램 본문. 전 항목 0건이면 한 줄로 줄인다. */
export function buildDigestText(dateKey: string, rows: DigestItemRow[], appUrl: string | null): string {
  const title = `가락시장 경매 요약 · ${dateLabel(dateKey)}`;
  if (rows.every((row) => row.tradeCount === 0)) {
    return `${title}\n${rows.map((row) => row.title).join("·")} 수집된 거래 없음 · 휴장 추정`;
  }
  const sections = [
    `${title}\n대표 규격(물량 최다 등급·단위) 가중평균`,
    ...rows.map(itemBlock),
  ];
  if (appUrl) sections.push(`앱에서 보기: ${appUrl.replace(/\/+$/, "")}/market`);
  const text = sections.join("\n\n");
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

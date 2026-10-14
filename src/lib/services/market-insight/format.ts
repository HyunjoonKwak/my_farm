/** 텔레그램 일반 텍스트 포맷 공용 유틸 (parse_mode 미사용). */

import type { ItemSpec, Status } from "./types";

// Telegram sendMessage 본문 한도는 4096자
export const MAX_MESSAGE_LENGTH = 4000;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const numberFormat = new Intl.NumberFormat("ko-KR");

export const STATUS_ICON: Record<Status, string> = { alert: "🔴", watch: "🟡", calm: "🟢", insufficient: "⚪" };

export function shortDate(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month}/${day}`;
}

export function dateLabel(dateKey: string): string {
  return `${shortDate(dateKey)}(${WEEKDAYS[new Date(`${dateKey}T00:00:00Z`).getUTCDay()]})`;
}

export function won(value: number): string {
  return `${numberFormat.format(Math.round(value))}원`;
}

export function count(value: number): string {
  return numberFormat.format(Math.round(value));
}

export function pct(value: number): string {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** "특(1등)" → "특" */
export function shortGrade(grade: string): string {
  return grade.replace(/\(.*\)/, "").trim() || grade;
}

export function specLabel(spec: ItemSpec): string {
  return [spec.autoVariety, shortGrade(spec.grade), spec.unit].filter(Boolean).join("·");
}

/** "경기도 평택시" → "평택시" */
export function shortOrigin(origin: string): string {
  const parts = origin.trim().split(/\s+/);
  return parts[parts.length - 1] ?? origin;
}

export function appLink(appUrl: string | null): string | null {
  return appUrl ? `앱에서 보기: ${appUrl.replace(/\/+$/, "")}/market` : null;
}

/** 섹션을 순서대로 붙이되 한도를 넘으면 뒤쪽(우선순위 낮은) 섹션부터 뺀다. */
export function joinWithinLimit(required: string[], optional: string[], footer: string | null): string {
  const build = (extra: string[]) => [...required, ...extra, ...(footer ? [footer] : [])].join("\n\n");
  let kept = [...optional];
  while (kept.length && build(kept).length > MAX_MESSAGE_LENGTH) kept = kept.slice(0, -1);
  const text = build(kept);
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

/** 마지막 한글 음절의 받침 여부로 조사를 고른다 ("농협(공)" → 이, "중앙청과" → 가). */
export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const syllables = word.match(/[가-힣]/g);
  if (!syllables) return withoutFinal;
  const code = syllables[syllables.length - 1].charCodeAt(0) - 0xac00;
  return code % 28 > 0 ? withFinal : withoutFinal;
}

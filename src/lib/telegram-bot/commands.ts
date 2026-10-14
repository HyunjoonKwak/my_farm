/**
 * 텔레그램 봇 명령 해석 (순수 함수).
 * 메뉴에 등록 가능한 영문 명령과 한글 별칭을 함께 받는다. "/시세 오이", "시세 오이" 모두 같은 뜻이다.
 */

import { MARKET_PRODUCTS } from "@/lib/constants/market-products";
import type { ItemConfig } from "@/lib/services/market-insight/types";

export type CommandName = "today" | "week" | "price" | "items" | "help";

export interface ParsedCommand {
  name: CommandName | "unknown";
  arg: string;
}

const ALIASES: Record<string, CommandName> = {
  today: "today", 오늘: "today", 브리핑: "today",
  week: "week", 주간: "week",
  price: "price", 시세: "price",
  items: "items", 항목: "items",
  help: "help", start: "help", 도움말: "help",
};

/** 텔레그램 메뉴에 등록할 명령 (영문만 허용) */
export const BOT_MENU: { command: CommandName; description: string }[] = [
  { command: "today", description: "최근 거래일 시세 브리핑" },
  { command: "week", description: "지난주 주간 리포트" },
  { command: "price", description: "품목 시세 (예: /price 대추방울)" },
  { command: "items", description: "브리핑 항목 목록" },
  { command: "help", description: "사용법" },
];

export const HELP_TEXT = [
  "🌱 가락시장 시세 봇",
  "",
  "/today (오늘) — 최근 거래일 브리핑",
  "/week (주간) — 지난주 주간 리포트",
  "/price 품목 (시세 품목) — 품목 시세",
  "   예: /price 대추방울 · 시세 오이 · 시세 딸기",
  "/items (항목) — 브리핑 항목 목록",
  "",
  "항목·비교 산지는 앱의 시세 → 데이터 수집 화면에서 바꿀 수 있습니다.",
].join("\n");

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const [head = "", ...rest] = trimmed.split(/\s+/);
  // "/price@봇이름" 형태도 받는다
  const word = head.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
  const name = ALIASES[word];
  if (!name) return { name: "unknown", arg: trimmed };
  return { name, arg: rest.join(" ").trim() };
}

const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/**
 * 질의에 맞는 브리핑 항목을 찾는다 (표시 이름·품목명·품종 표기 부분 일치).
 * 항목에 없더라도 가락시장 품목명이면 전국·물량 최다 품종 기준 임시 항목을 만든다.
 */
export function matchItems(items: ItemConfig[], query: string): ItemConfig[] {
  const q = normalize(query);
  if (!q) return items;
  const matched = items.filter((item) =>
    [item.label, item.productName, ...item.varieties].some((name) => {
      const n = normalize(name);
      return n.length > 0 && (n.includes(q) || q.includes(n));
    })
  );
  if (matched.length) return matched;
  const product = MARKET_PRODUCTS.find((p) => q.includes(normalize(p)) || normalize(p).includes(q));
  return product ? [{ productName: product, label: "", varieties: [], origin: "" }] : [];
}

export function itemsText(items: ItemConfig[]): string {
  if (items.length === 0) return "등록된 브리핑 항목이 없습니다. 앱의 시세 → 데이터 수집 화면에서 추가하세요.";
  const lines = items.map((item, i) => {
    const name = item.label.trim() || item.productName;
    const varieties = item.varieties.length ? item.varieties.join("·") : "물량 최다 품종 자동";
    const origin = item.origin ? ` · 비교 산지 ${item.origin}` : "";
    return `${i + 1}. ${name} (${item.productName}: ${varieties})${origin}`;
  });
  return ["📋 브리핑 항목", ...lines].join("\n");
}

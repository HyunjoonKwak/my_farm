/** 봇 명령 → 답장 본문. DB·계산 의존성은 주입받아 테스트한다. */

import { HELP_TEXT, itemsText, matchItems, parseCommand } from "./commands";
import type { ItemConfig } from "@/lib/services/market-insight/types";

export interface BotDeps {
  /** 브리핑 항목 (발송 on/off와 무관하게 활성 항목) */
  getItems: () => Promise<ItemConfig[]>;
  /** 거래가 수집된 가장 최근 날짜 (없으면 null) */
  latestTradingDay: () => Promise<string | null>;
  /** 오늘 날짜 키 (KST) */
  today: () => string;
  daily: (dateKey: string, items: ItemConfig[]) => Promise<string>;
  weekly: (dateKey: string, items: ItemConfig[]) => Promise<string>;
}

const NO_ITEMS = "등록된 브리핑 항목이 없습니다. 앱의 시세 → 데이터 수집 화면에서 추가하세요.";
const NO_DATA = "아직 수집된 시세가 없습니다.";

export async function handleCommand(text: string, deps: BotDeps): Promise<string> {
  const command = parseCommand(text);
  switch (command.name) {
    case "help":
      return HELP_TEXT;
    case "items":
      return itemsText(await deps.getItems());
    case "today": {
      const [items, day] = await Promise.all([deps.getItems(), deps.latestTradingDay()]);
      if (!items.length) return NO_ITEMS;
      return day ? deps.daily(day, items) : NO_DATA;
    }
    case "week": {
      const items = await deps.getItems();
      return items.length ? deps.weekly(deps.today(), items) : NO_ITEMS;
    }
    case "price": {
      if (!command.arg) return "품목을 함께 적어 주세요. 예: /price 대추방울 · 시세 오이";
      const [items, day] = await Promise.all([deps.getItems(), deps.latestTradingDay()]);
      const matched = matchItems(items, command.arg);
      if (!matched.length) {
        const names = items.map((item) => item.label.trim() || item.productName).join(", ");
        return `'${command.arg}'에 맞는 품목을 찾지 못했습니다.${names ? ` 등록된 항목: ${names}` : ""}`;
      }
      return day ? deps.daily(day, matched) : NO_DATA;
    }
    default:
      return `알 수 없는 명령입니다.\n\n${HELP_TEXT}`;
  }
}

/** 봇 명령 실제 의존성 연결 (DB·브리핑 계산) 후 수신 시작. */

import { marketDateKey } from "@/lib/market-date";
import { getLatestCollectionDate } from "@/lib/services/garak-market";
import { getDigestItems } from "@/lib/services/market-digest-data";
import { reportMonday } from "@/lib/services/market-digest";
import { buildDailyBriefing, buildWeeklyReport } from "@/lib/services/market-insight/build";
import { handleCommand, type BotDeps } from "./handlers";
import { startTelegramBotPoller } from "./poller";

const appUrl = () => process.env.NEXTAUTH_URL?.trim() || null;

export const botDeps: BotDeps = {
  getItems: () => getDigestItems({ requireDigestEnabled: false }),
  latestTradingDay: async () => {
    const latest = await getLatestCollectionDate();
    return latest ? marketDateKey(latest) : null;
  },
  today: () => marketDateKey(new Date()),
  daily: async (dateKey, items) => (await buildDailyBriefing(dateKey, items, appUrl())).text,
  weekly: async (dateKey, items) => (await buildWeeklyReport(reportMonday(dateKey), items, appUrl())).text,
};

export function startTelegramBot(): void {
  startTelegramBotPoller((text) => handleCommand(text, botDeps));
}

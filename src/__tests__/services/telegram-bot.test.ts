import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/services/telegram", () => ({
  TELEGRAM_API_BASE: "https://api.telegram.org",
  getTelegramConfig: () => ({ token: "t", chatId: "555" }),
  sendTelegramMessage: vi.fn(),
}));

import { matchItems, parseCommand } from "@/lib/telegram-bot/commands";
import { handleCommand, type BotDeps } from "@/lib/telegram-bot/handlers";
import { pollOnce } from "@/lib/telegram-bot/poller";

const ITEMS = [
  { productName: "토마토", label: "대추방울토마토", varieties: ["대추빨강", "대추방울토마토"], origin: "경기도 평택시" },
  { productName: "포도", label: "샤인머스캣", varieties: ["샤인머스켓"], origin: "경기도 평택시" },
  { productName: "오이", label: "", varieties: [], origin: "경기도 평택시" },
];

describe("parseCommand", () => {
  it.each([
    ["/today", "today", ""],
    ["오늘", "today", ""],
    ["/week@specialrisk_bot", "week", ""],
    ["/시세 대추 방울", "price", "대추 방울"],
    ["시세 오이", "price", "오이"],
    ["/PRICE 포도", "price", "포도"],
    ["/start", "help", ""],
    ["안녕", "unknown", "안녕"],
  ])("%s → %s", (text, name, arg) => {
    expect(parseCommand(text)).toEqual({ name, arg });
  });
});

describe("matchItems", () => {
  it("matches labels, product names and variety spellings", () => {
    expect(matchItems(ITEMS, "대추방울").map((i) => i.productName)).toEqual(["토마토"]);
    expect(matchItems(ITEMS, "샤인").map((i) => i.productName)).toEqual(["포도"]);
    expect(matchItems(ITEMS, "오이").map((i) => i.productName)).toEqual(["오이"]);
  });

  it("builds an ad-hoc national item for other market products", () => {
    expect(matchItems(ITEMS, "딸기")).toEqual([{ productName: "딸기", label: "", varieties: [], origin: "" }]);
    expect(matchItems(ITEMS, "망고")).toEqual([]);
  });
});

describe("handleCommand", () => {
  let deps: BotDeps;
  beforeEach(() => {
    deps = {
      getItems: vi.fn().mockResolvedValue(ITEMS),
      latestTradingDay: vi.fn().mockResolvedValue("2026-10-14"),
      today: () => "2026-10-15",
      daily: vi.fn().mockResolvedValue("DAILY"),
      weekly: vi.fn().mockResolvedValue("WEEKLY"),
    };
  });

  it("answers today with the latest trading day", async () => {
    expect(await handleCommand("/today", deps)).toBe("DAILY");
    expect(deps.daily).toHaveBeenCalledWith("2026-10-14", ITEMS);
  });

  it("answers week from today's date", async () => {
    expect(await handleCommand("주간", deps)).toBe("WEEKLY");
    expect(deps.weekly).toHaveBeenCalledWith("2026-10-15", ITEMS);
  });

  it("answers price for the matched item only", async () => {
    await handleCommand("시세 샤인", deps);
    expect(deps.daily).toHaveBeenCalledWith("2026-10-14", [ITEMS[1]]);
  });

  it("explains missing arguments, unknown items and empty settings", async () => {
    expect(await handleCommand("/price", deps)).toContain("품목을 함께 적어 주세요");
    expect(await handleCommand("/price 망고", deps)).toContain("등록된 항목: 대추방울토마토, 샤인머스캣, 오이");
    deps.getItems = vi.fn().mockResolvedValue([]);
    expect(await handleCommand("/today", deps)).toContain("등록된 브리핑 항목이 없습니다");
  });

  it("lists items and falls back to help", async () => {
    expect(await handleCommand("/items", deps)).toContain("1. 대추방울토마토 (토마토: 대추빨강·대추방울토마토) · 비교 산지 경기도 평택시");
    expect(await handleCommand("뭐해", deps)).toContain("알 수 없는 명령입니다.");
  });
});

describe("pollOnce", () => {
  const NOW = Date.parse("2026-10-14T05:00:00Z");
  const update = (id: number, chatId: number, text: string, ageSeconds = 0) => ({
    update_id: id,
    message: { date: Math.floor(NOW / 1000) - ageSeconds, chat: { id: chatId }, text },
  });
  const respond = (body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));

  it("answers only the registered chat, skips stale messages, and advances the offset", async () => {
    const fetchImpl = respond({
      ok: true,
      result: [update(10, 555, "/today"), update(11, 999, "/today"), update(12, 555, "/week", 3600)],
    });
    const handle = vi.fn().mockResolvedValue("ANSWER");
    const reply = vi.fn().mockResolvedValue(undefined);
    const { result, state } = await pollOnce({ startedAt: NOW }, { token: "t", chatId: "555" }, { fetchImpl, handle, reply });
    expect(result).toBe("ok");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith("/today");
    expect(reply).toHaveBeenCalledWith("ANSWER");
    expect(state.offset).toBe(13);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ timeout: 50, allowed_updates: ["message"] });
  });

  it("reports a polling conflict and keeps the offset", async () => {
    const out = await pollOnce({ startedAt: NOW, offset: 5 }, { token: "t", chatId: "555" }, {
      fetchImpl: respond({ ok: false, error_code: 409 }), handle: vi.fn(),
    });
    expect(out).toEqual({ result: "conflict", state: { startedAt: NOW, offset: 5 } });
  });

  it("replies with an apology when a command fails", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    await pollOnce({ startedAt: NOW }, { token: "t", chatId: "555" }, {
      fetchImpl: respond({ ok: true, result: [update(1, 555, "/today")] }),
      handle: vi.fn().mockRejectedValue(new Error("db")),
      reply,
    });
    expect(reply).toHaveBeenCalledWith("요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  });

  it("treats network failures as errors", async () => {
    const out = await pollOnce({ startedAt: NOW }, { token: "t", chatId: "555" }, {
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")), handle: vi.fn(),
    });
    expect(out.result).toBe("error");
  });
});

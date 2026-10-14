/**
 * 텔레그램 봇 명령 수신 (getUpdates 롱폴링).
 *
 * - 앱 주소가 HTTPS가 아니어서 웹훅 대신 서버가 텔레그램에 새 메시지를 묻는다.
 * - 등록된 TELEGRAM_CHAT_ID의 메시지에만 답하고 나머지는 조용히 무시한다.
 * - 재시작 사이에 쌓인 오래된 메시지(5분 초과)는 답하지 않는다 (뒤늦은 답장 폭주 방지).
 * - 같은 봇을 다른 프로그램이 폴링하면 409가 나므로 길게 쉬었다 다시 시도한다.
 * - 토큰이 URL에 들어가므로 오류·로그에 URL을 남기지 않는다. 루프는 서버를 멈추지 않는다.
 */

import { logger } from "@/lib/logger";
import { TELEGRAM_API_BASE, getTelegramConfig, sendTelegramMessage, type TelegramConfig } from "@/lib/services/telegram";
import { BOT_MENU } from "./commands";

const LONG_POLL_SECONDS = 50;
const REQUEST_TIMEOUT_MS = (LONG_POLL_SECONDS + 15) * 1000;
const STALE_MS = 5 * 60 * 1000;
const CONFLICT_WAIT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

interface TelegramUpdate {
  update_id: number;
  message?: { date: number; chat: { id: number | string }; text?: string };
}

export interface PollState {
  offset?: number;
  startedAt: number;
}

export interface PollDeps {
  fetchImpl?: typeof fetch;
  handle: (text: string) => Promise<string>;
  reply?: (text: string) => Promise<unknown>;
}

export type PollResult = "ok" | "conflict" | "error";

/** 한 번 롱폴링하고 받은 메시지를 처리한다. 다음 offset은 state에 반영한다. */
export async function pollOnce(state: PollState, config: TelegramConfig, deps: PollDeps): Promise<{ result: PollResult; state: PollState }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const reply = deps.reply ?? ((text: string) => sendTelegramMessage(text));
  let body: { ok?: boolean; error_code?: number; result?: TelegramUpdate[] };
  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${config.token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset: state.offset, timeout: LONG_POLL_SECONDS, allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await response.json();
  } catch {
    return { result: "error", state };
  }
  if (!body.ok) return { result: body.error_code === 409 ? "conflict" : "error", state };

  let offset = state.offset;
  for (const update of body.result ?? []) {
    offset = update.update_id + 1;
    const message = update.message;
    if (!message?.text || String(message.chat.id) !== config.chatId) continue;
    if (message.date * 1000 < state.startedAt - STALE_MS) continue;
    try {
      await reply(await deps.handle(message.text));
    } catch (error) {
      logger.error("[Telegram bot] 명령 처리 실패:", error);
      await reply("요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.").catch(() => undefined);
    }
  }
  return { result: "ok", state: { ...state, offset } };
}

async function registerMenu(config: TelegramConfig): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API_BASE}/bot${config.token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: BOT_MENU }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    logger.warn("[Telegram bot] 명령 메뉴 등록 실패 (명령은 그대로 동작)");
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const shared = globalThis as typeof globalThis & { telegramBotPolling?: boolean };

export function isBotEnabled(): boolean {
  return getTelegramConfig() !== null && process.env.TELEGRAM_COMMANDS_ENABLED !== "false";
}

/** 서버 부팅 시 한 번 시작한다 (중복 시작 방지). */
export function startTelegramBotPoller(handle: (text: string) => Promise<string>): void {
  const config = getTelegramConfig();
  if (!config || !isBotEnabled() || shared.telegramBotPolling) return;
  shared.telegramBotPolling = true;

  void (async () => {
    await registerMenu(config);
    let state: PollState = { startedAt: Date.now() };
    let failures = 0;
    logger.info("[Telegram bot] 명령 수신 시작");
    for (;;) {
      const { result, state: next } = await pollOnce(state, config, { handle });
      state = next;
      if (result === "ok") {
        failures = 0;
        continue;
      }
      failures++;
      if (result === "conflict") logger.warn("[Telegram bot] 같은 봇을 다른 곳에서 폴링 중 (409) — 잠시 후 재시도");
      await sleep(result === "conflict" ? CONFLICT_WAIT_MS : Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (failures - 1)));
    }
  })();
}

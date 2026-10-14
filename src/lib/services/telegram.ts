/**
 * Telegram Bot API 발송 어댑터 (서버 전용).
 *
 * - TELEGRAM_TOKEN / TELEGRAM_CHAT_ID 미설정은 성공이 아니라 SKIPPED다.
 * - HTTP 200만으로 성공 처리하지 않고 응답 `ok`와 `result.message_id`를 확인한다.
 * - 타임아웃은 전송 여부가 모호하므로 UNKNOWN으로 남기고 재전송하지 않는다.
 * - 토큰이 URL에 들어가므로 오류 메시지·로그에 요청 URL을 절대 넣지 않는다.
 */

import { logger } from "@/lib/logger";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
const SEND_TIMEOUT_MS = 15_000;
// 429는 retry_after가 이 값 이하일 때 한 번만 기다렸다 재시도한다
const MAX_RETRY_AFTER_SECONDS = 30;

export type TelegramSendStatus = "SENT" | "SKIPPED" | "FAILED" | "UNKNOWN";

export interface TelegramSendResult {
  status: TelegramSendStatus;
  messageId: string | null;
  error: string | null;
}

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export interface TelegramDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: { message_id?: number };
}

export function getTelegramConfig(): TelegramConfig | null {
  const token = (process.env.TELEGRAM_TOKEN ?? "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
  return token && chatId ? { token, chatId } : null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function result(status: TelegramSendStatus, error: string | null, messageId: string | null = null): TelegramSendResult {
  return { status, messageId, error };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function readBody(response: Response): Promise<TelegramApiResponse> {
  try {
    return (await response.json()) as TelegramApiResponse;
  } catch (error) {
    // 본문을 읽던 중 타임아웃은 이미 전송됐을 수 있으므로 호출부에서 UNKNOWN으로 처리한다
    if (isTimeout(error)) throw error;
    return {};
  }
}

async function postOnce(config: TelegramConfig, text: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return { httpStatus: response.status, body: await readBody(response) };
}

/** 일반 텍스트 메시지 발송 (parse_mode 미사용 — 품종·등급명의 특수문자 이스케이프 문제 회피). */
export async function sendTelegramMessage(text: string, deps: TelegramDeps = {}): Promise<TelegramSendResult> {
  const config = getTelegramConfig();
  if (!config) return result("SKIPPED", "TELEGRAM_TOKEN/TELEGRAM_CHAT_ID 미설정");

  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { httpStatus, body } = await postOnce(config, text, fetchImpl);
      const messageId = body.result?.message_id;
      if (body.ok === true && typeof messageId === "number") {
        return result("SENT", null, String(messageId));
      }
      const retryAfter = body.parameters?.retry_after;
      if (httpStatus === 429 && attempt === 1 && typeof retryAfter === "number" && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
        await sleep(retryAfter * 1000);
        continue;
      }
      const detail = body.description ?? (body.ok === true ? "message_id 없음" : "응답 형식 오류");
      logger.warn(`[Telegram] 발송 실패 (HTTP ${httpStatus}): ${detail}`);
      return result("FAILED", `HTTP ${httpStatus}: ${detail}`);
    } catch (error) {
      if (isTimeout(error)) {
        logger.warn("[Telegram] 응답 타임아웃 — 전송 여부 불명");
        return result("UNKNOWN", "응답 타임아웃 (전송 여부 불명)");
      }
      // 네트워크 오류 메시지에 URL(토큰 포함)이 섞일 수 있어 원문을 남기지 않는다
      logger.warn("[Telegram] 네트워크 오류로 발송 실패");
      return result("FAILED", "네트워크 오류");
    }
  }
  return result("FAILED", "429 재시도 후에도 실패");
}

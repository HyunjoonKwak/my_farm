import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getTelegramConfig, sendTelegramMessage } from "@/lib/services/telegram";

const TOKEN = "123456:SECRET-TOKEN";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.stubEnv("TELEGRAM_TOKEN", TOKEN);
  vi.stubEnv("TELEGRAM_CHAT_ID", "-100200300");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTelegramConfig", () => {
  it("returns null when token or chat id is missing", () => {
    vi.stubEnv("TELEGRAM_CHAT_ID", " ");
    expect(getTelegramConfig()).toBeNull();
  });

  it("trims configured values", () => {
    vi.stubEnv("TELEGRAM_CHAT_ID", " -100200300 ");
    expect(getTelegramConfig()).toEqual({ token: TOKEN, chatId: "-100200300" });
  });
});

describe("sendTelegramMessage", () => {
  it("is SKIPPED without configuration and never calls fetch", async () => {
    vi.stubEnv("TELEGRAM_TOKEN", "");
    const fetchImpl = vi.fn();
    const result = await sendTelegramMessage("hi", { fetchImpl });
    expect(result.status).toBe("SKIPPED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is SENT only when ok=true and a message id is returned", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 42 } }));
    const result = await sendTelegramMessage("요약", { fetchImpl });
    expect(result).toEqual({ status: "SENT", messageId: "42", error: null });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ chat_id: "-100200300", text: "요약", disable_web_page_preview: true });
  });

  it("is FAILED when Telegram answers ok=false, without leaking the token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, 400));
    const result = await sendTelegramMessage("요약", { fetchImpl });
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("chat not found");
    expect(result.error).not.toContain(TOKEN);
  });

  it("is FAILED when HTTP 200 carries no message id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: {} }));
    expect((await sendTelegramMessage("요약", { fetchImpl })).status).toBe("FAILED");
  });

  it("retries once after 429 using retry_after", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 7 } }));
    const result = await sendTelegramMessage("요약", { fetchImpl, sleep });
    expect(result.status).toBe("SENT");
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("is UNKNOWN on timeout and does not retry", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    const result = await sendTelegramMessage("요약", { fetchImpl });
    expect(result.status).toBe("UNKNOWN");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is UNKNOWN when the timeout fires while reading the response body", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const response = { status: 200, json: vi.fn().mockRejectedValue(timeout) } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(response);
    expect((await sendTelegramMessage("요약", { fetchImpl })).status).toBe("UNKNOWN");
  });

  it("is FAILED on a network error and hides the request URL", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const result = await sendTelegramMessage("요약", { fetchImpl });
    expect(result.status).toBe("FAILED");
    expect(result.error).not.toContain(TOKEN);
  });
});

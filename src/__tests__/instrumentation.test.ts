import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

const { schedulerMock, backupMock, loggerMock, recoveryMock, botMock } = vi.hoisted(() => ({
  botMock: { startTelegramBot: vi.fn() },
  schedulerMock: { loadAllSchedules: vi.fn() },
  backupMock: { startBackupScheduler: vi.fn() },
  recoveryMock: { startMarketRecoveryScheduler: vi.fn() },
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/scheduler", () => schedulerMock);
vi.mock("@/lib/backup/scheduler", () => backupMock);
vi.mock("@/lib/market-recovery-scheduler", () => recoveryMock);
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));
vi.mock("@/lib/telegram-bot", () => botMock);

import { register } from "@/instrumentation";

const ROOT = process.cwd();

describe("instrumentation 등록 위치 (Next 16, src/app 구조)", () => {
  it("앱이 src/app에 있으므로 instrumentation.ts는 src/ 에 있어야 하고 루트에는 없어야 한다", () => {
    // next/dist/build/index.js: rootDir = path.join(appDir, "..") → src/ 만 스캔한다.
    // 루트 파일은 hasInstrumentationHook=false → standalone 출력에서 server/instrumentation.js가 빠져
    // 운영 서버가 register()를 건너뛴다 (2026-07-22 이후 자동 수집 중단).
    expect(existsSync(path.join(ROOT, "src", "app"))).toBe(true);
    expect(existsSync(path.join(ROOT, "src", "instrumentation.ts"))).toBe(true);
    expect(existsSync(path.join(ROOT, "instrumentation.ts"))).toBe(false);
  });


});

describe("register()", () => {
  const originalPhase = process.env.NEXT_PHASE;
  const originalRuntime = process.env.NEXT_RUNTIME;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    schedulerMock.loadAllSchedules.mockResolvedValue(2);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NEXT_PHASE = originalPhase;
    process.env.NEXT_RUNTIME = originalRuntime;
    if (originalPhase === undefined) delete process.env.NEXT_PHASE;
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    consoleError.mockRestore();
  });

  it("빌드 단계에서는 아무것도 초기화하지 않는다", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(backupMock.startBackupScheduler).not.toHaveBeenCalled();
    expect(recoveryMock.startMarketRecoveryScheduler).not.toHaveBeenCalled();
    expect(schedulerMock.loadAllSchedules).not.toHaveBeenCalled();
    expect(botMock.startTelegramBot).not.toHaveBeenCalled();
  });

  it("서버 런타임에서 텔레그램 봇 수신을 시작하고, 실패해도 스케줄러는 계속 올린다", async () => {
    delete process.env.NEXT_PHASE;
    process.env.NEXT_RUNTIME = "nodejs";
    botMock.startTelegramBot.mockImplementationOnce(() => { throw new Error("boom"); });
    await register();
    expect(botMock.startTelegramBot).toHaveBeenCalledTimes(1);
    expect(schedulerMock.loadAllSchedules).toHaveBeenCalled();
  });

  it("nodejs 런타임이 아니면(edge 등) 건너뛴다", async () => {
    delete process.env.NEXT_PHASE;
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(schedulerMock.loadAllSchedules).not.toHaveBeenCalled();
  });

  it("nodejs 런타임에서는 백업 스케줄러와 수집 스케줄을 로드하고 건수를 남긴다", async () => {
    delete process.env.NEXT_PHASE;
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(backupMock.startBackupScheduler).toHaveBeenCalledTimes(1);
    expect(schedulerMock.loadAllSchedules).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith("[Instrumentation] Scheduler initialized: 2 schedule(s)");
  });

  it("최초 로드가 실패해도 주기적인 복구 점검기는 시작되어 있다", async () => {
    delete process.env.NEXT_PHASE;
    process.env.NEXT_RUNTIME = "nodejs";
    schedulerMock.loadAllSchedules.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    await expect(register()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "[Instrumentation] Failed to initialize schedulers:",
      expect.any(Error)
    );
    expect(recoveryMock.startMarketRecoveryScheduler).toHaveBeenCalledTimes(1);
    expect(schedulerMock.loadAllSchedules).toHaveBeenCalledTimes(1);
  });
});

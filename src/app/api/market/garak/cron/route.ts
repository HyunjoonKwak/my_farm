import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { isValidCronRequest } from "@/lib/auth/guards";
import {
  collectAndSaveAuctionData,
  cleanupOldAuctionData,
  type CollectionStatus,
} from "@/lib/services/garak-market";
import { maybeSendDailyDigest } from "@/lib/services/market-digest";
import { marketDateKey } from "@/lib/market-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5분

/**
 * 현재 시각을 KST 기준으로 반환.
 * 컨테이너가 UTC로 동작해도 사용자 설정(KST 기준 HH:mm)과 올바르게 비교되도록 함.
 */
function getKstNow(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
}

/**
 * GET: 스케줄된 자동 수집 실행 (외부 크론 호출용, CRON_SECRET 필수)
 * node-cron 스케줄러가 기본 경로이며, 이 엔드포인트는 외부 크론 백업용이다.
 */
export async function GET(request: NextRequest) {
  try {
    if (!isValidCronRequest(request.headers.get("authorization"))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const kstNow = getKstNow();
    const currentTime = `${String(kstNow.getHours()).padStart(2, "0")}:${String(
      kstNow.getMinutes()
    ).padStart(2, "0")}`;
    const currentDay = kstNow.getDay(); // 0=일, 1=월, ..., 6=토

    const allSettings = await prisma.marketCollectionSettings.findMany({
      where: { autoCollectEnabled: true },
    });

    // 요일 일치 + 설정 시각과 15분 이내인 설정만 실행
    const settingsToRun = allSettings.filter((s) => {
      const collectDays = s.collectDays.split(",").filter(Boolean).map(Number);
      if (!collectDays.includes(currentDay)) return false;

      const [setHour, setMin] = s.collectTime.split(":").map(Number);
      const setMinutes = setHour * 60 + setMin;
      const curMinutes = kstNow.getHours() * 60 + kstNow.getMinutes();

      return Math.abs(setMinutes - curMinutes) <= 15;
    });

    if (settingsToRun.length === 0) {
      return NextResponse.json({
        message: "현재 시간에 실행할 수집 작업이 없습니다.",
        currentTime,
        currentDay,
        checkedSettings: allSettings.length,
      });
    }

    const results: Array<{
      userId: string;
      success: boolean;
      status?: CollectionStatus;
      issues?: string[];
      totalCount?: number;
      newCount?: number;
      error?: string;
    }> = [];

    for (const setting of settingsToRun) {
      try {
        const startedAt = new Date();
        const targetDate = new Date(startedAt);
        targetDate.setDate(targetDate.getDate() - setting.collectDaysAgo);

        const corporationCodes = setting.corporationCodes
          .split(",")
          .filter(Boolean);

        // collectAndSaveAuctionData가 쉼표 구분 다품목을 내부에서 분리 처리함
        const result = await collectAndSaveAuctionData(
          targetDate,
          corporationCodes,
          setting.targetProducts || undefined
        );

        if (setting.autoCleanupEnabled && result.complete) {
          await cleanupOldAuctionData();
        }
        if (result.complete) {
          await maybeSendDailyDigest(setting, marketDateKey(targetDate), startedAt);
        }

        results.push({
          userId: setting.userId,
          success: result.complete,
          status: result.status,
          issues: result.issues,
          totalCount: result.totalCount,
          newCount: result.newCount,
        });
      } catch (error) {
        results.push({
          userId: setting.userId,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return NextResponse.json({
      message: `${results.length}개의 수집 작업이 실행되었습니다.`,
      currentTime,
      results,
    });
  } catch (error) {
    logger.error("Cron collection error:", error);
    return NextResponse.json(
      { error: "수집 작업 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

const manualTriggerSchema = z.object({
  userId: z.string().min(1, "userId가 필요합니다."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.")
    .optional(),
  products: z.string().optional(),
});

/**
 * POST: 수동 수집 트리거 (서비스 간 호출용, CRON_SECRET 필수)
 */
export async function POST(request: NextRequest) {
  try {
    if (!isValidCronRequest(request.headers.get("authorization"))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = manualTriggerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "잘못된 요청입니다." },
        { status: 400 }
      );
    }
    const { userId, date, products } = parsed.data;

    const setting = await prisma.marketCollectionSettings.findUnique({
      where: { userId },
    });

    if (!setting) {
      return NextResponse.json(
        { error: "설정을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const targetDate = date ? new Date(date) : new Date();
    if (!date) {
      targetDate.setDate(targetDate.getDate() - setting.collectDaysAgo);
    }

    const corporationCodes = setting.corporationCodes.split(",").filter(Boolean);
    const targetProducts = products ?? setting.targetProducts;

    const result = await collectAndSaveAuctionData(
      targetDate,
      corporationCodes,
      targetProducts || undefined
    );

    return NextResponse.json({
      message: result.complete ? "수집 확인이 완료되었습니다." : "수집 상태와 안내를 확인하세요.",
      status: result.status,
      complete: result.complete,
      issues: result.issues,
      guidance: result.guidance,
      targetDate: targetDate.toISOString(),
      targetProducts,
      totalCount: result.totalCount,
      newCount: result.newCount,
    });
  } catch (error) {
    logger.error("Manual collection error:", error);
    return NextResponse.json(
      { error: "수집 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

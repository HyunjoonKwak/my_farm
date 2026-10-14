import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { isValidCronRequest, requireAdminUser } from "@/lib/auth/guards";
import { marketDateKey, marketDayStart } from "@/lib/market-date";
import { buildDigest, defaultDigestDateKey, sendDigest, sendTestDigest } from "@/lib/services/market-digest";
import { getTelegramConfig } from "@/lib/services/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 실제 달력 날짜이고 미래가 아니어야 한다 (미래 날짜 점유로 정상 발송이 막히는 것 방지)
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.")
  .refine((key) => {
    const start = marketDayStart(key);
    return !Number.isNaN(start.getTime()) && marketDateKey(start) === key;
  }, "존재하지 않는 날짜입니다.")
  .refine((key) => key <= marketDateKey(new Date()), "미래 날짜는 사용할 수 없습니다.")
  .optional();

// daily: 일일 브리핑, weekly: 그 날짜 기준 지난주(월~일) 주간 리포트
const kindSchema = z.enum(["daily", "weekly"]).default("daily");

// test=true: 발송 이력 없이 "[테스트]"로 보낸다 (그날 정기 발송을 막지 않음)
const sendSchema = z.object({ date: dateSchema, kind: kindSchema, test: z.boolean().optional() });
const previewSchema = z.object({ date: dateSchema, kind: kindSchema });

/** 서비스 간 호출(CRON_SECRET) 또는 DB 기준 관리자만 허용한다. */
async function authorize(request: NextRequest): Promise<NextResponse | null> {
  if (isValidCronRequest(request.headers.get("authorization"))) return null;
  return requireAdminUser();
}

/** GET: 미리보기 (발송하지 않음). ?date=YYYY-MM-DD&kind=daily|weekly, 날짜 기본값은 자동 수집 대상 날짜. */
export async function GET(request: NextRequest) {
  try {
    const denied = await authorize(request);
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const parsed = previewSchema.safeParse({
      date: params.get("date") ?? undefined,
      kind: params.get("kind") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다." }, { status: 400 });
    }
    const dateKey = parsed.data.date ?? (await defaultDigestDateKey());
    const digest = await buildDigest(parsed.data.kind, dateKey);
    return NextResponse.json({
      dateKey,
      kind: parsed.data.kind,
      telegramConfigured: getTelegramConfig() !== null,
      text: digest?.text ?? null,
    });
  } catch (error) {
    logger.error("[Market digest] preview failed:", error);
    return NextResponse.json({ error: "요약을 만들지 못했습니다." }, { status: 500 });
  }
}

/** POST: 해당 날짜 요약 발송. 같은 날짜는 한 번만 보낸다 (확실한 실패만 재시도). test=true는 이력 없이 보낸다. */
export async function POST(request: NextRequest) {
  try {
    const denied = await authorize(request);
    if (denied) return denied;

    const parsed = sendSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다." }, { status: 400 });
    }
    const { kind, test } = parsed.data;
    const dateKey = parsed.data.date ?? (await defaultDigestDateKey());
    const outcome = test ? await sendTestDigest(dateKey, kind) : await sendDigest(kind, dateKey);
    return NextResponse.json({ dateKey, kind, outcome }, { status: outcome === "ERROR" ? 500 : 200 });
  } catch (error) {
    logger.error("[Market digest] send failed:", error);
    return NextResponse.json({ error: "요약 발송에 실패했습니다." }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getSessionUser, requireAdminUser } from "@/lib/auth/guards";
import { getTelegramConfig } from "@/lib/services/telegram";
import { parseVarieties } from "@/lib/services/market-digest-data";
import { digestSettingsSchema } from "@/lib/validations/market-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECENT_DELIVERIES = 8;

async function loadState(userId: string) {
  const [settings, deliveries] = await Promise.all([
    prisma.marketCollectionSettings.findUnique({
      where: { userId },
      select: {
        digestEnabled: true,
        targetProducts: true,
        digestItems: { orderBy: { sortOrder: "asc" } },
      },
    }),
    prisma.marketDigestDelivery.findMany({
      // 주간 이력의 날짜 키는 지난주 월요일이라 처리 시각 순으로 보여야 함께 보인다
      orderBy: { updatedAt: "desc" },
      take: RECENT_DELIVERIES,
      select: { channel: true, dateKey: true, status: true, error: true, updatedAt: true },
    }),
  ]);
  return {
    hasSettings: settings !== null,
    digestEnabled: settings?.digestEnabled ?? false,
    targetProducts: (settings?.targetProducts ?? "").split(",").filter(Boolean),
    items: (settings?.digestItems ?? []).map((item) => ({
      productName: item.productName,
      label: item.label,
      varieties: parseVarieties(item.varieties),
      origin: item.origin,
      enabled: item.enabled,
    })),
    telegramConfigured: getTelegramConfig() !== null,
    deliveries,
  };
}

/** GET: 텔레그램 일일 요약 설정·최근 발송 이력 */
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    return NextResponse.json(await loadState(user.id));
  } catch (error) {
    logger.error("[Market digest] settings load failed:", error);
    return NextResponse.json({ error: "요약 설정을 불러오지 못했습니다." }, { status: 500 });
  }
}

/** PUT: 요약 사용 여부와 항목 전체 교체. 운영자 텔레그램으로 나가므로 관리자만 바꿀 수 있다. */
export async function PUT(request: NextRequest) {
  try {
    const denied = await requireAdminUser();
    if (denied) return denied;
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    const parsed = digestSettingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "잘못된 요청입니다." }, { status: 400 });
    }
    const settings = await prisma.marketCollectionSettings.findUnique({ where: { userId: user.id }, select: { id: true } });
    if (!settings) {
      return NextResponse.json({ error: "먼저 자동 수집 설정을 저장해 주세요." }, { status: 404 });
    }

    const { digestEnabled, items } = parsed.data;
    await prisma.$transaction([
      prisma.marketCollectionSettings.update({ where: { id: settings.id }, data: { digestEnabled } }),
      prisma.marketDigestItem.deleteMany({ where: { settingsId: settings.id } }),
      prisma.marketDigestItem.createMany({
        data: items.map((item, index) => ({
          settingsId: settings.id,
          productName: item.productName,
          label: item.label,
          varieties: JSON.stringify(item.varieties),
          origin: item.origin,
          enabled: item.enabled,
          sortOrder: index,
        })),
      }),
    ]);
    return NextResponse.json(await loadState(user.id));
  } catch (error) {
    logger.error("[Market digest] settings save failed:", error);
    return NextResponse.json({ error: "요약 설정을 저장하지 못했습니다." }, { status: 500 });
  }
}

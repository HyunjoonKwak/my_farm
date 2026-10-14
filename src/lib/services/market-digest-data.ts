/**
 * 텔레그램 브리핑 알림 항목(MarketDigestItem) 설정 읽기.
 * 품목·표시 이름·품종 표기 목록·비교 산지를 브리핑 계산(market-insight/)에 넘긴다.
 */

import { z } from "zod";
import prisma from "@/lib/prisma";
import type { ItemConfig } from "./market-insight/types";

const varietiesSchema = z.array(z.string()).catch([]);

/** DB의 JSON 문자열 품종 목록을 안전하게 배열로 바꾼다 (깨진 값은 빈 목록 = 자동). */
export function parseVarieties(raw: string): string[] {
  try {
    return varietiesSchema.parse(JSON.parse(raw)).map((v) => v.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 활성 브리핑 항목 (정렬 순서대로). 기본은 발송을 켠 설정만,
 * 봇 명령처럼 사용자가 직접 물을 때는 발송 on/off와 무관하게 읽는다.
 */
export async function getDigestItems({ requireDigestEnabled = true } = {}): Promise<ItemConfig[]> {
  const settings = await prisma.marketCollectionSettings.findMany({
    where: requireDigestEnabled ? { digestEnabled: true } : {},
    orderBy: { createdAt: "asc" },
    select: { digestItems: { where: { enabled: true }, orderBy: { sortOrder: "asc" } } },
  });
  return settings.flatMap((s) =>
    s.digestItems.map((item) => ({
      productName: item.productName,
      label: item.label,
      varieties: parseVarieties(item.varieties),
      origin: item.origin,
    }))
  );
}

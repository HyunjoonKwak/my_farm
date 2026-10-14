import { z } from "zod";
import { MARKET_PRODUCTS } from "@/lib/constants/market-products";

export const MAX_DIGEST_ITEMS = 20;
export const MAX_DIGEST_VARIETIES = 20;

const text = (max: number) => z.string().trim().max(max);

export const digestItemSchema = z.object({
  productName: z.enum(MARKET_PRODUCTS, { message: "지원하지 않는 품목입니다." }),
  label: text(30),
  // 빈 배열 = 그날 물량 최다 품종 자동
  varieties: z
    .array(text(50).min(1))
    .max(MAX_DIGEST_VARIETIES, `품종은 ${MAX_DIGEST_VARIETIES}개까지 고를 수 있습니다.`)
    .transform((list) => [...new Set(list)]),
  // 빈 문자열 = 전체 산지
  origin: text(50),
  enabled: z.boolean(),
});

export const digestSettingsSchema = z.object({
  digestEnabled: z.boolean(),
  items: z.array(digestItemSchema).max(MAX_DIGEST_ITEMS, `알림 항목은 ${MAX_DIGEST_ITEMS}개까지 만들 수 있습니다.`),
});

export type DigestItemInput = z.infer<typeof digestItemSchema>;
export type DigestSettingsInput = z.infer<typeof digestSettingsSchema>;

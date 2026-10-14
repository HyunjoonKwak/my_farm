import { describe, it, expect } from "vitest";
import { buildDigestText, shortOrigin, type DigestItemRow } from "@/lib/services/market-digest-format";

const CHERRY: DigestItemRow = {
  title: "대추방울토마토",
  autoVariety: null,
  origin: "경기도 평택시",
  originFallback: false,
  tradeCount: 34,
  totalQuantity: 1211,
  representative: { grade: "특(1등)", unit: "3kg", avgPrice: 18450, kgPrice: 6150 },
  change: { prevDateKey: "2026-10-12", pct: 3.24 },
};

const CUCUMBER: DigestItemRow = {
  ...CHERRY,
  title: "오이",
  autoVariety: "백다다기",
  origin: "",
  representative: { grade: "특(1등)", unit: "1상자", avgPrice: 9901, kgPrice: null },
  change: { prevDateKey: "2026-10-12", pct: -27.64 },
};

describe("buildDigestText", () => {
  it("renders scope, price, change, volume and link", () => {
    const text = buildDigestText("2026-10-13", [CHERRY], "https://farm.example.com/");
    expect(text).toContain("가락시장 경매 요약 · 10/13(화)");
    expect(text).toContain("[대추방울토마토] 평택시 · 특(1등) · 3kg");
    expect(text).toContain("평균 18,450원 (kg당 6,150원)");
    expect(text).toContain("직전 거래일 10/12 대비 ▲3.2%");
    expect(text).toContain("물량 1,211개 · 34건");
    expect(text).toContain("https://farm.example.com/market");
  });

  it("shows the auto-picked variety, missing kg price and falling change", () => {
    const text = buildDigestText("2026-10-13", [CUCUMBER], null);
    expect(text).toContain("[오이] 백다다기 · 전체 산지 · 특(1등) · 1상자");
    expect(text).toContain("평균 9,901원 (kg당 —)");
    expect(text).toContain("▼27.6%");
    expect(text).not.toContain("앱에서 보기");
  });

  it("labels an origin fallback and items without trades", () => {
    const fallback = { ...CHERRY, title: "샤인머스캣", originFallback: true, change: null };
    const none = { ...CHERRY, title: "참외", tradeCount: 0, totalQuantity: 0, representative: null, change: null };
    const text = buildDigestText("2026-10-13", [fallback, none], null);
    expect(text).toContain("[샤인머스캣] 전체 산지(평택시 거래 없음) · 특(1등) · 3kg");
    expect(text).toContain("직전 거래 비교 없음");
    expect(text).toContain("[참외] 거래 없음");
  });

  it("collapses to a single line when nothing traded", () => {
    const none = { ...CHERRY, tradeCount: 0, representative: null };
    const text = buildDigestText("2026-10-11", [none, { ...none, title: "오이" }], null);
    expect(text).toBe("가락시장 경매 요약 · 10/11(일)\n대추방울토마토·오이 수집된 거래 없음 · 휴장 추정");
  });

  it("stays under the Telegram length limit", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...CHERRY, title: `항목${i}` }));
    expect(buildDigestText("2026-10-13", many, null).length).toBeLessThanOrEqual(4000);
  });
});

describe("shortOrigin", () => {
  it("keeps the last administrative unit", () => {
    expect(shortOrigin("경기도 평택시")).toBe("평택시");
    expect(shortOrigin("강원특별자치도 인제군")).toBe("인제군");
  });
});

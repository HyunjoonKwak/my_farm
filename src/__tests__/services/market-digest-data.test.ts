import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    marketCollectionSettings: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ default: prismaMock }));

import { getDigestItems, parseVarieties } from "@/lib/services/market-digest-data";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseVarieties", () => {
  it("returns a clean list and tolerates broken values", () => {
    expect(parseVarieties('["샤인머스켓", " ", "샤인머스캣"]')).toEqual(["샤인머스켓", "샤인머스캣"]);
    expect(parseVarieties("not json")).toEqual([]);
    expect(parseVarieties('{"a":1}')).toEqual([]);
  });
});

describe("getDigestItems", () => {
  it("flattens enabled items of settings with the digest on", async () => {
    prismaMock.marketCollectionSettings.findMany.mockResolvedValue([
      { digestItems: [{ productName: "포도", label: "샤인머스캣", varieties: '["샤인머스켓"]', origin: "" }] },
    ]);
    expect(await getDigestItems()).toEqual([
      { productName: "포도", label: "샤인머스캣", varieties: ["샤인머스켓"], origin: "" },
    ]);
    expect(prismaMock.marketCollectionSettings.findMany.mock.calls[0][0].where).toEqual({ digestEnabled: true });
  });
});

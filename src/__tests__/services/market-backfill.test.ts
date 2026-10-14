// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { recoveryDates, scopeKey } = require("../../../scripts/market-backfill.cjs");
const now = new Date("2026-09-06T08:00:00Z");
it("recovers newest first with inclusive, valid bounded calendar dates", () => {
  expect(recoveryDates("2026-09-04", "2026-09-06", now)).toEqual(["2026-09-06", "2026-09-05", "2026-09-04"]);
  for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-09-07", "2026-09-07"], ["2026-09-06", "2026-09-05"], ["2026-01-01", "2026-09-06"]]) {
    expect(() => recoveryDates(from, to, now)).toThrow();
  }
});
it("resumes only matching commodity and corporation scopes", () => {
  const a = scopeKey({ corporationCodes: "a,b", targetProducts: "토마토,포도" });
  expect(scopeKey({ corporationCodes: "b,a", targetProducts: "포도, 토마토" })).toBe(a);
  expect(scopeKey({ corporationCodes: "a,b", targetProducts: "딸기" })).not.toBe(a);
});
it("keys a product-limited backfill separately from the full settings scope", () => {
  const setting = { corporationCodes: "a,b", targetProducts: "토마토,포도,오이" };
  expect(scopeKey(setting, "오이")).not.toBe(scopeKey(setting));
  expect(scopeKey(setting, "오이")).toBe(scopeKey({ ...setting, targetProducts: "오이" }));
});

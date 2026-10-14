-- Covering index for the Telegram price briefing aggregates.
-- IF NOT EXISTS: production created it ahead of this deploy on 2026-10-14.
CREATE INDEX IF NOT EXISTS "AuctionResult_insight_idx" ON "AuctionResult"("productName", "unit", "grade", "variety", "auctionDate", "origin", "corporationCode", "price", "quantity");

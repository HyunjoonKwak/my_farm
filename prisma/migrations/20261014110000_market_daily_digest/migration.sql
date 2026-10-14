-- CreateTable
CREATE TABLE "MarketDigestDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketDigestDelivery_channel_dateKey_key" ON "MarketDigestDelivery"("channel", "dateKey");


-- AlterTable
ALTER TABLE "MarketCollectionSettings" ADD COLUMN "digestEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MarketDigestItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "settingsId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "varieties" TEXT NOT NULL DEFAULT '[]',
    "origin" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MarketDigestItem_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "MarketCollectionSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "MarketDigestItem_settingsId_sortOrder_idx" ON "MarketDigestItem"("settingsId", "sortOrder");

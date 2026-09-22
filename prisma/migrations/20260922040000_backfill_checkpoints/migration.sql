-- Expand-only operational state for resumable bounded backfills.
-- Creating this empty table does not scan or rewrite a financial table.
CREATE TABLE "BackfillCheckpoint" (
  "jobName" TEXT NOT NULL PRIMARY KEY,
  "lastId" TEXT,
  "completedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

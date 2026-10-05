CREATE TABLE "ban_appeals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "banAuditLogId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decisionReason" TEXT,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "ban_appeals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ban_appeals_banAuditLogId_key" ON "ban_appeals"("banAuditLogId");
CREATE INDEX "ban_appeals_status_createdAt_idx" ON "ban_appeals"("status", "createdAt");
CREATE INDEX "ban_appeals_userId_createdAt_idx" ON "ban_appeals"("userId", "createdAt");
ALTER TABLE "ban_appeals" ADD CONSTRAINT "ban_appeals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ban_appeals" ADD CONSTRAINT "ban_appeals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" VARCHAR(50) NOT NULL,
    "method" VARCHAR(20),
    "reason" VARCHAR(160) NOT NULL,
    "ipAddress" VARCHAR(45),
    "locationStatus" VARCHAR(20) NOT NULL,
    "city" VARCHAR(100),
    "region" VARCHAR(100),
    "country" VARCHAR(2),
    "browser" VARCHAR(100) NOT NULL,
    "device" VARCHAR(100) NOT NULL,
    "userAgent" VARCHAR(500),
    "sessionReference" VARCHAR(64),
    "requestId" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "security_events_createdAt_id_idx" ON "security_events"("createdAt", "id");
CREATE INDEX "security_events_userId_createdAt_idx" ON "security_events"("userId", "createdAt");
CREATE INDEX "security_events_action_createdAt_idx" ON "security_events"("action", "createdAt");
CREATE INDEX "security_events_sessionReference_createdAt_idx" ON "security_events"("sessionReference", "createdAt");
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

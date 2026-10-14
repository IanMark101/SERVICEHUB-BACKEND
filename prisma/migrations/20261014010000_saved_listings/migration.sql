CREATE TABLE "saved_listings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_listings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saved_listings_one_target" CHECK (num_nonnulls("serviceId", "requestId") = 1)
);
CREATE UNIQUE INDEX "saved_listings_userId_serviceId_key" ON "saved_listings"("userId", "serviceId");
CREATE UNIQUE INDEX "saved_listings_userId_requestId_key" ON "saved_listings"("userId", "requestId");
CREATE INDEX "saved_listings_userId_createdAt_id_idx" ON "saved_listings"("userId", "createdAt", "id");
ALTER TABLE "saved_listings" ADD CONSTRAINT "saved_listings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_listings" ADD CONSTRAINT "saved_listings_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_listings" ADD CONSTRAINT "saved_listings_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

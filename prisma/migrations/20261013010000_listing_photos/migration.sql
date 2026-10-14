CREATE TABLE "listing_photos" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT,
  "publicId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "listing_photos_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "listing_photos_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "listing_photos_publicId_key" ON "listing_photos"("publicId");
CREATE INDEX "listing_photos_ownerId_createdAt_idx" ON "listing_photos"("ownerId", "createdAt");
CREATE TABLE "service_listing_photos" (
  "serviceId" TEXT NOT NULL,
  "photoId" TEXT NOT NULL,
  "position" INTEGER NOT NULL CHECK ("position" BETWEEN 0 AND 2),
  CONSTRAINT "service_listing_photos_pkey" PRIMARY KEY ("serviceId", "photoId"),
  CONSTRAINT "service_listing_photos_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "service_listing_photos_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "listing_photos"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "service_listing_photos_serviceId_position_key" ON "service_listing_photos"("serviceId", "position");
CREATE INDEX "service_listing_photos_photoId_idx" ON "service_listing_photos"("photoId");
CREATE TABLE "request_listing_photos" (
  "requestId" TEXT NOT NULL,
  "photoId" TEXT NOT NULL,
  "position" INTEGER NOT NULL CHECK ("position" BETWEEN 0 AND 2),
  CONSTRAINT "request_listing_photos_pkey" PRIMARY KEY ("requestId", "photoId"),
  CONSTRAINT "request_listing_photos_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "request_listing_photos_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "listing_photos"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "request_listing_photos_requestId_position_key" ON "request_listing_photos"("requestId", "position");
CREATE INDEX "request_listing_photos_photoId_idx" ON "request_listing_photos"("photoId");

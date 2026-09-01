-- Official Community Hub notices. This deliberately supports only
-- administrator-authored announcements; it is not a social-feed table.
CREATE TABLE IF NOT EXISTS "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "announcements_isPublished_publishedAt_idx"
ON "announcements"("isPublished", "publishedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'announcements_authorId_fkey'
  ) THEN
    ALTER TABLE "announcements"
    ADD CONSTRAINT "announcements_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

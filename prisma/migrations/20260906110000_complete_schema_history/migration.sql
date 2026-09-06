-- Complete migration history for fields that were previously introduced via
-- schema synchronization instead of a checked-in migration.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "facebookUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "instagramUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "websiteUrl" TEXT;

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "scheduledDate" TEXT,
  ADD COLUMN IF NOT EXISTS "scheduledTime" TEXT,
  ADD COLUMN IF NOT EXISTS "hiddenBySeeker" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hiddenByProvider" BOOLEAN NOT NULL DEFAULT false;

-- The original migration looked up this constraint by name across every
-- schema. On shared PostgreSQL databases, a matching constraint in `public`
-- could therefore make a fresh isolated schema skip its own foreign key.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'announcements_authorId_fkey'
      AND conrelid = '"announcements"'::regclass
  ) THEN
    ALTER TABLE "announcements"
      ADD CONSTRAINT "announcements_authorId_fkey"
      FOREIGN KEY ("authorId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

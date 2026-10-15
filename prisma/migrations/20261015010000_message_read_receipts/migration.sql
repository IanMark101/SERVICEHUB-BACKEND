-- Nullable: historical read messages have no trustworthy seen timestamp.
ALTER TABLE "messages" ADD COLUMN "readAt" TIMESTAMP(3);

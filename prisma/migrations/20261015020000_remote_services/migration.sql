-- Existing service arrangements and booking snapshots are unchanged.
ALTER TYPE "ServiceLocationMode" ADD VALUE IF NOT EXISTS 'REMOTE';

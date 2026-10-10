-- Retire the category-request workflow. The official catalog and category
-- relations on listings/requests remain intact, as do historical audit records.
BEGIN;
DELETE FROM "notifications" WHERE "link" = '/seeker/suggest-category';
DROP TABLE "categories_suggested";
DROP TYPE "CategorySuggestionStatus";
COMMIT;

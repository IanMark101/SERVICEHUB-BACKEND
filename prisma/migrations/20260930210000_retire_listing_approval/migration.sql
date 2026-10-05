-- Retire listing pre-approval without publishing content that has never passed
-- the current checks. Providers can edit/save these legacy records to publish.
ALTER TABLE "services" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
UPDATE "services"
SET "status" = 'REJECTED', "isAvailable" = false,
    "moderationReasonCode" = 'PUBLICATION_CHECK_REQUIRED'
WHERE "status" = 'PENDING_REVIEW';

-- Retire obsolete action links in existing notifications. Historical decisions
-- and audit records remain intact; these messages only concerned pending work.
UPDATE "notifications"
SET "title" = 'Listing needs attention',
    "body" = 'Service listings no longer wait for administrator approval. Open Service Manager, check your unpublished listing, and save it to publish after the content checks pass.',
    "link" = '/provider/service-manager?status=rejected'
WHERE "title" IN ('Listing Awaiting Admin Review', 'Listing Changes Submitted');
UPDATE "notifications"
SET "title" = 'Listing publication updated',
    "body" = 'Providers now publish after automatic content checks. Use Service Listings to inspect content and handle policy violations after publication.',
    "link" = '/admin/services'
WHERE "title" IN ('New Service Listing Pending Review', 'Service Listing Changes Pending Review');

-- Preserve existing reports and appeals; older records have no selected report reason.
ALTER TABLE "content_moderation_cases" ADD COLUMN "reportReason" VARCHAR(32);

ALTER TABLE "content_moderation_cases"
ADD CONSTRAINT "content_report_reason_valid"
CHECK ("reportReason" IS NULL OR (
  "caseType" = 'REPORT' AND "reportReason" IN ('MISLEADING', 'SCAM', 'INAPPROPRIATE', 'UNSAFE', 'SPAM', 'OTHER')
));

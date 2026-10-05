export const VERIFICATION_PRIVACY_NOTICE_VERSION = "2026-09-30-v2";
export const VERIFICATION_DOCUMENT_RETENTION_DAYS = 365;

export const VERIFICATION_PRIVACY_NOTICE =
  "ServiceHub Cordova collects identity and residency document images only for eligibility review, fraud prevention, and authorized case handling. Access is limited to authenticated administrators and is audit logged. Verification records normally follow a 365-day retention period. Permanent account deletion removes these records from the database once all marketplace obligations and document holds are resolved. Files held by the storage provider are managed separately.";

export function verificationRetentionDeadline(from = new Date()): Date {
  return new Date(from.getTime() + VERIFICATION_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

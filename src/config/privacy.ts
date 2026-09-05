export const VERIFICATION_PRIVACY_NOTICE_VERSION = "2026-09-04-v1";
export const VERIFICATION_DOCUMENT_RETENTION_DAYS = 365;

export const VERIFICATION_PRIVACY_NOTICE =
  "ServiceHub Cordova collects identity and residency document images only for eligibility review, fraud prevention, and authorized case handling. Access is limited to authenticated administrators and is audit logged. Documents are retained for at least 365 days after submission or review and longer when a legal or active-case hold applies.";

export function verificationRetentionDeadline(from = new Date()): Date {
  return new Date(from.getTime() + VERIFICATION_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

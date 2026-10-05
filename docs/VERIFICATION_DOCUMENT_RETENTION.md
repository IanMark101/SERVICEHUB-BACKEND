# Verification records and account deletion

Version: 2026-09-30-v2

ServiceHub stores identity/residency images in private managed storage. Normal
API responses expose metadata; administrator access is authorized and audited.

Active-account verification records normally follow a 365-day retention period.
The account owner may permanently delete their account sooner after clearing all
marketplace obligations and explicit document holds. This removes verification
and proof records from the live database together with the User row and all its
related data. No anonymous account placeholder or completion receipt remains.

An explicit ServiceVerification.legalHold, unfinished booking/queue, unsettled
payment/refund, unresolved case, or retryable resolution blocks account deletion.
The server checks these inside the locked deletion transaction. Password or fresh
Google verification is still required after typing DELETE.

The confirmation explains that shared closed bookings, payment/case history,
reviews, and chats are removed from both participants' views. Other accounts and
unrelated engagements are preserved.

Managed-storage images and database backups are separate from live database rows.
This SQL deletion does not claim to delete Cloudinary files or backups. A separate
storage cleanup mechanism is required for physical removal of those files;
getVerificationRetentionState only evaluates retention of existing records and
is not a storage deletion worker. The privacy notice describes this boundary.

Previous anonymous Deleted account rows can be inspected with
npm run accounts:purge-deleted -- --dry-run. Applying cleanup requires one exact
--user-id and repeats the eligibility checks; it cannot purge a live account.

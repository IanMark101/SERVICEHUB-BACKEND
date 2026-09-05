# Verification Document Retention Policy

Version: 2026-09-04-v1

ServiceHub Cordova stores identity and residency evidence in private managed storage. Ordinary user and administrator queue responses expose document metadata only; opening or downloading a proof requires a dedicated administrator endpoint and creates an `AdminAuditLog` record.

Documents are retained for at least 365 days from submission. An administrator review resets the minimum retention deadline to 365 days from the review. A document must not be purged after that date when either condition applies:

- `ServiceVerification.legalHold` is enabled for a legal, regulatory, or administrator preservation requirement.
- The submitting user participates in a nonterminal booking, held payment, pending or escalated cancellation, unresolved report, or active completion escalation.

`getVerificationRetentionState` is the authoritative purge eligibility check. A later cleanup worker must call it before removing a database proof or private managed-storage object. Account deletion requests do not override transaction, moderation, audit, or verification retention requirements.

Account deletion in Phase 3 is a request workflow. Requests with active obligations are stored as `BLOCKED`; eligible requests are stored as `PENDING` for guarded administrator processing. Final deactivation/anonymization is intentionally deferred to the administrator safeguard phase and must preserve records required for financial reconciliation, disputes, legal holds, and immutable audit history.

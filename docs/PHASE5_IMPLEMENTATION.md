# Phase 5 implementation and verification

Updated September 5, 2026.

## Listing rules

Creation and resubmission serialize by provider. ACTIVE and PENDING_REVIEW
listings share a three-listing limit. Pausing uses INACTIVE; resumption checks
the limit again. Moderation uses the same provider lock as edits. Suspended
listings require administrator restoration before editing.

The database enforces normalized title uniqueness for ACTIVE/PENDING_REVIEW
listings. Archived titles may be reused. Description, title and category edits
return a listing to review. Listing media/proof is not implemented; the fake
skill-proof argument has been removed from the creation path.

CUSTOM persists a null listing price. An exact Offer is required for advanced
pricing. Only FIXED listings support direct booking. Session booking remains
disabled pending its scheduling implementation.

## Review and summary rules

Provider ratings and summary queries exclude hidden reviews and feedback
received while acting as a seeker. Seeker feedback remains in profile history
and participates in the shared-account trust model described in the Master
Prompt. Trust history is restricted to its owner or an administrator. Reading
history never fabricates legacy events.

The summary cache key hashes the newest 20 eligible reviews, their content,
tags, ratings and content versions. Requests check the database content before
reusing memory or persisted results, so moderation/editing invalidates results
across server restarts. Gemini needs five written reviews in that selected set.
Computed fallbacks retry after five minutes; successful Gemini results persist
until the content changes. Requests for the same version are deduplicated per
process. Generation times out after five seconds. The API returns a computed
result while generation runs. Background errors are handled. Contact patterns
are removed before sending review text to Gemini.

Cross-process generation deduplication and direct browser demonstrations remain
part of the remaining verification work; the current implementation does not
claim a distributed work queue.

## Payment controls

GCash, Maya and on-site cash use explicit accepted-method flags. Missing flags
do not infer support from price. Card is disabled in listing controls and
rejected before payment initiation because the current integration does not
implement card-detail collection or a hosted card checkout. Full payment-screen
verification is still pending; external Test Mode verification remains Phase 6.

## Defense seed

Executed against the configured development database on September 5:

```
node node_modules/tsx/dist/cli.mjs prisma/seed-defense.ts --confirm-demo-data
```

The seed creates a clearly labelled demonstration provider and five fictional
written reviews linked through CompletedService to completed cash bookings.
It skips existing demo reviews on retry and refuses production mode. Passwords
are random and are not logged. No real money or external payment calls occur.

## Evidence and remaining work

Backend and frontend production builds pass (93 frontend routes). The 14
existing contracts, Phase 4 integration, booking lifecycle integration and the
initial Phase 5 listing/AI integration pass. Gemini is mocked in the automated
threshold/cache test; this is not evidence of a live Gemini demonstration.

Phase 5 remains in progress until the tracker’s remaining trust-event coverage,
advanced-offer and payment UI checks have been completed. Do not interpret a
successful build as full browser or payment-provider verification.

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

Cross-process generation deduplication remains future scale work; the current
implementation does not claim a distributed work queue.

## Payment controls

GCash, Maya and on-site cash use explicit accepted-method flags. Missing flags
do not infer support from price. Card is disabled in listing controls and
rejected before payment initiation because the current integration does not
implement card-detail collection or a hosted card checkout. Returned Maya
bookings remain Maya throughout frontend mapping and activity/transaction
displays. External Test Mode verification remains Phase 6.

## Defense data

Temporary demonstration records were used during implementation and removed
after verification. The repository no longer contains a defense-data generator.
For a defense rehearsal, create ordinary test accounts through the application,
complete the required booking/review flows, capture evidence, and delete the
temporary accounts afterward.

## Evidence and remaining work

Backend and frontend production builds pass (93 frontend routes). All 14
contracts, Phase 4 integration, booking lifecycle integration and Phase 5
listing/review/trust/AI integration pass. The Phase 5 suite also proves that an
advanced-price listing rejects direct booking and accepts an exact provider
Offer. Gemini is mocked in the automated threshold/cache test; this is not
evidence of a live Gemini demonstration. Live payment-provider and final manual
browser verification remain explicitly assigned to later tracker phases.

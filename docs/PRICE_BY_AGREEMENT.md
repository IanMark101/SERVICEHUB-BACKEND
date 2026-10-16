# Price by agreement

Current behavior and release boundary: see CURRENT_SYSTEM.md. Dated implementation checks below retain their original scope. Generated review captures and logs removed during cleanup remain recoverable from the recorded pre-cleanup Git revisions.
Providers can publish or edit a service with `priceType: BY_AGREEMENT` and `price: null`. Existing fixed/hourly/daily/project modes keep their normal booking paths; retired `CUSTOM`/`STARTS_AT` remain unsupported choices.

Seeker request from the listing â†’ selected provider declines or sends a final Offer with included work â†’ seeker approves through Offers Received â†’ existing offer-origin cash booking or verified GCash payment admission. No second provider acceptance, public request listing, separate quote tab or booking before price approval.

`POST /api/requests/listing-inquiry` accepts service identity, concrete arrangement, work details and up to three owned photo IDs. The server derives the provider, title, category and payment methods. It creates a participant-scoped `ServiceRequest` with `targetServiceId`, `targetProviderId`, null preferred method and zero budget as an internal unset value. Zero must never be displayed as a free service or used as payment terms. Public discovery/maps exclude this request.

`POST /api/requests/:id/decline-inquiry` is selected-provider-only and idempotent before a pending price exists. Existing `POST /api/offers` submits the final PHP 50â€“50,000 total, duration and included-work explanation. Approval reuses Cash direct-from-offer or the existing GCash payment attempt. Offer amount, venue and job snapshots survive listing changes; travel is included once. Exact directions remain restricted before booking. Hosted image URLs use the current upload architecture and are not confidential storage.

Accounts must remain active, email-verified and identity-approved. Self requests, foreign photos, unauthorized replies/approval, duplicate active inquiries/offers and direct checkout bypass are rejected. Requests cannot edit quoted work/location after sending; cancel and resend. No paid queue position is created until verified online success, and work still requires explicit Provider Start.

Migration `20261014030000_price_by_agreement` adds one enum value without converting rows. Applied only to the recorded development target with the guarded development script. The isolated lifecycle tests replay all 47 migrations in a disposable schema and use a stubbed gateway; they do not claim a real wallet payment or production deployment.

Verification evidence: 128 focused frontend tests, 208 backend contract tests, eleven isolated integration tests across price approval, service arrangements and payment webhook replay, both builds, scoped lint/types, and 12 intercepted responsive browser views. Current requirements, schema, actor/workflow diagrams and test scope are reflected in Master Prompt 3.3 and the four native Word documents.

An unapproved private price declined by its Seeker or withdrawn by its Provider closes the inquiry atomically with the offer decision. Idempotent retries do not duplicate notifications. A fresh request is then allowed; declining a public request offer leaves its request open.

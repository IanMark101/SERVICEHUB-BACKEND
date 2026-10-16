# Current ServiceHub behavior

Aligned October 16, 2026 with frontend f0398bd and backend 821282e on feature/codebase-cleanup-2026-10-16. These local cleanup commits follow the recorded deployed frontend 3411838 and API c9a9a38 and change no application behavior. This alignment is documentation only and is not a new deployment claim.

## Discovery and delivery

The map helps seekers find provider services and providers find public seeker requests. Every new physical service or public request selects one Discovery location. Search and map selection are alternative ways to choose that same point. Physical arrangement changes retain it. An account's profile locality, each workspace's search center and the private booking address remain separate.

| Delivery arrangement | Provider service listing | Seeker public request and booking |
|---|---|---|
| Provider visits | One discovery point; no private workplace address required. | One public discovery point; the seeker supplies the private actual job location during booking or public-offer acceptance. |
| Seeker visits | One discovery point plus private workplace directions of 5–500 characters; no second workplace pin. | One public discovery point; the selected offer or service supplies the private provider venue snapshot. |
| Either option | One discovery point plus private workplace directions for receiving visitors. | One public discovery point; select one concrete physical direction for the booking. |
| Online / remote | No location, map, device-location, workplace-address or travel-fee field. | No location field or meetup address; eligible remote results have no distance or marker and bypass the discovery radius. |

The browsing radius supports presets 0.5, 1, 2, 5, 10, 15, 20 and 30 km, plus custom values from 0.5–30 km in 0.1 km increments. It filters physical discovery, not provider willingness to travel. There is no provider travel limit. Providers decide whether to offer or accept work under the applicable flow. AI Matches uses distance for ranking, without a fixed 30 km rejection.

Current creation/editing forms expose no exact-public-pin checkbox and save publicMapPin false. Public request pins are approximate. Legacy provider records with explicit consent retain the backend's exact-public-pin compatibility. Discovery coordinates do not replace new private workplace directions. Current forms can reuse a member's discovery point in the same browser; that preference is not cross-device synchronization.

## Pricing and booking

There are five supported price types: FIXED, PER_HOUR, PER_DAY, PER_PROJECT and BY_AGREEMENT. Fixed/rate listings retain posted terms in every delivery arrangement. Quantity and a displayed one-time provider travel fee are calculated server-side where applicable. Only BY_AGREEMENT uses a private inquiry and provider final offer before approval. Retained STARTS_AT/CUSTOM values do not authorize direct checkout.

Direct Cash booking requires provider approval. Accepting a provider's public-request offer with Cash creates accepted work without a second provider approval. Either GCash path creates paid work and a queue place only after verified server payment confirmation. A browser redirect, inquiry, offer or checkout link alone does not create a paid booking or start work.

## GCash and work progress

Selecting GCash on a provider service or public seeker request requires a valid private saved account number. The fixed +63 input accepts ten national digits starting with 9 and normalizes supported pasted formats to the stored 09 form. The number is separate from the contact phone, reused across workspaces and not public. Cash-only posts need none. Removal is blocked while retained GCash listings or active public requests depend on it.

GCash uses PayMongo Test Mode. No real transfer or provider payout is established. The GCash status interface shows the agreed server total, checkout/status/retry actions and booking confirmation when verified, with no cash-switch shortcut or MPIN/OTP field.

Eligible paid jobs share one provider-wide waiting queue, with capacity 1–10 and explicit Start Job. Cash bookings stay outside that paid waiting queue. Payment does not start work. Provider completion awaits seeker confirmation or an authorized Admin decision before final completion and the applicable internal settlement.

## Reviews trust and moderation

Eligible completed-booking participants submit/edit reviews through Activity. Profile review cards are read-only, with no public reply or new review-report action. Recorded historical responses remain readable. Star ratings and review changes do not award or deduct trust points.

Trust History shows recorded events and has no Appeal trust penalty button or new-appeal form. Existing TrustCase records, private responses to existing disputes and authorized Admin decisions remain supported. The backend retains trust-event case compatibility; this is not a member submission control. Ban appeals and public-content removal appeals remain separate available workflows.

## Maintained code and evidence

Cleanup removed historical execution logs, browser captures, a disposable fixture proxy, two unreferenced landing components, unused public assets and redundant dependencies. Maintained regression tests, migrations, operational scripts, design guidance and private database backups remain. Historical removed evidence is recoverable before cleanup at frontend 3411838 and API c9a9a38.

Local cleanup verification passed 1,441 frontend tests, 258 backend schema/contract tests, 16 development-runtime checks and four production-build map scenarios. Both builds and frontend lint passed. These results do not establish new live-wallet, database-integration or community acceptance. Earlier dated verification totals retain their original scope.

## Implementation references

Frontend: src/lib/location.ts, src/lib/serviceArrangement.ts, src/components/location/ListingLocationFields.tsx, src/components/location/DiscoveryLocationField.tsx, src/components/provider/OfferServices.tsx, src/components/provider/service-manager/EditServiceModal.tsx, src/components/seeker/IncomingOffers.tsx, src/components/ui/GCashNumberField.tsx and src/components/profile/TrustHistorySection.tsx.

Backend: src/schema/services.schema.ts, src/schema/location.schema.ts, src/lib/service-arrangement.ts, src/services/gcash-listing-policy.ts, src/services/ai-marketplace.service.ts, src/services/bookings/direct-listing-pricing.ts, src/services/nearby.service.ts and src/services/trust-policy.service.ts. The current schema contains 41 Prisma models. Retained compatibility fields alone do not prove a current UI feature.

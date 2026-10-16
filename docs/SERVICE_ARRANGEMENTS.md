# Service arrangements and locations

Aligned October 16, 2026. See CURRENT_SYSTEM.md for the shared current reference and release boundary.

Provider listings and seeker requests support PROVIDER_VISITS, SEEKER_VISITS, BOTH and REMOTE. BOTH offers either physical direction; each booking or offer selects one concrete arrangement.

Every physical service and public request uses one Discovery location, independent of who travels. Changing between physical arrangements retains it. Search and map are alternative ways to select that point. No provider travel-radius control or eligibility cutoff exists. The viewer's search circle filters physical discovery only.

A provider receiving visitors (SEEKER_VISITS or BOTH) additionally saves private workplace directions of 5–500 characters, without another map pin. A travelling provider needs no workplace address. Public seeker requests store discovery only; the actual private job address is collected during the applicable booking step. Accepting a public offer with PROVIDER_VISITS requires written job directions or a job pin. Direct service booking retains its existing job-location step. SEEKER_VISITS uses the provider venue snapshot. Missing legacy offer venues return PROVIDER_VENUE_REQUIRED rather than a fabricated address.

REMOTE forms show no location, area-search, map, device-location, workplace, public-pin or travel-fee control. Eligible remote discovery bypasses radius and returns no distance or map marker. Saving physical work as remote clears old location, venue and travel data; saving it later as physical requires a discovery point. Delivery compatibility still applies to listings, requests, offers and payment recovery.

Current forms save publicMapPin false and expose no exact-public-pin checkbox. Legacy explicitly consented provider records retain exact-pin backend compatibility. Request pins and current physical listing pins remain approximate. Private written directions stay outside unpaid public projections and are protected by booking authorization.

Pricing is independent of delivery. FIXED, PER_HOUR, PER_DAY and PER_PROJECT use posted terms through direct Cash approval or verified GCash checkout in every arrangement. Displayed provider travel is added once where applicable. Only BY_AGREEMENT uses a private inquiry and a final approved offer. Existing bookings and payment attempts retain immutable snapshots.

New location/address simplification needs no additional schema migration. The existing REMOTE enum migration and a matching Prisma client remain required. The compatible October 16 application release is recorded at frontend 3411838 and API c9a9a38; the subsequent local cleanup changed no runtime behavior. Manual community acceptance remains separate.

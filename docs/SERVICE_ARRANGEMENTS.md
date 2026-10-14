# Service arrangements

Provider listings and seeker requests support `PROVIDER_VISITS`, `SEEKER_VISITS`, or `BOTH`. Existing records default to provider visits. An offer or booking agrees to one concrete arrangement; it never stores `BOTH` as the choice.

For `PROVIDER_VISITS`, a listing's `serviceLocation` is a general service-area center selected by city/barangay search, not a required shop, home address or exact operating base. The publish form requires an explicit travel-coverage choice: a 1–30 km radius measured from that center, or no travel distance limit (`coverageRadiusKm: null`). A named city is a discovery anchor, not a municipal boundary restriction. `SEEKER_VISITS` requires the actual provider venue and no travel radius; anyone may request a visit. `BOTH` requires that venue and lets the provider define travel coverage for home service. Existing records with null coverage retain unlimited travel.

A seeker request for provider visits (or either arrangement) collects the actual job pin and optional private directions. A seeker-visit request collects only a general search area; the provider's offer supplies the work venue. Changing between general-area and actual-location roles requires a newly selected location in create/edit UI and on the update API. No general area is silently converted into a precise venue or job address.

For a direct listing booking, provider visits use the seeker’s submitted job pin, enforce the listing’s travel coverage and add the listing’s transportation fee once. Seeker visits use the provider’s saved venue pin and private directions, ignore a submitted seeker pin, and charge no provider transportation fee. Cash bookings and GCash attempts store the chosen arrangement, location and fee; payment finalization copies the stored attempt, so later listing changes do not move a paid booking.

For an offer on a seeker request, the provider chooses an arrangement allowed by both the request and any linked listing. A custom seeker-visit offer must supply a venue. A linked seeker-visit offer snapshots the listing venue. The offer’s quoted price is the final total, including any provider travel; listing fees and seeker travel allowances are never added again. Changing a request’s arrangement, job location or travel allowance is blocked while it has active offers.

Public discovery and unpaid offer previews show only general areas. Exact provider venue pins and directions remain private; participants receive the agreed job location through their booking. Incoming Requests displays `booking.jobLocation`, not the seeker’s profile location.

## Deploy

Apply the additive migration `20261012000000_service_arrangements` to the intended database before starting the updated backend:

```sh
npx prisma migrate deploy
npm run db:generate
npm run build
```

Restart/deploy the backend, then deploy the matching frontend. The migration keeps historical listing/request behavior and does not infer venues from user profile addresses. Providers must choose their venue before enabling seeker visits.

## Verify

`npm test` covers arrangement validation, location resolution, fee calculation, coverage and preview privacy. The integration suite exercises both cash booking directions, quote privacy, request edit locks and venue snapshots. Run it against an explicitly selected test database through the disposable schema runner:

```powershell
$env:SERVICEHUB_ARRANGEMENTS_ONLY = '1'
npm run test:fresh-migrations
Remove-Item Env:SERVICEHUB_ARRANGEMENTS_ONLY
```

Backend CI runs this suite against its temporary PostgreSQL service. Local implementation validation did not apply migrations or run integration tests against the configured remote database.

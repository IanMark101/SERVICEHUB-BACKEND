# Listing maps, locality autofill and provider cards

Current behavior and release boundary: see CURRENT_SYSTEM.md. Dated implementation checks below retain their original scope. Generated review captures and logs removed during cleanup remain recoverable from the recorded pre-cleanup Git revisions.
Provider Incoming Requests retains its existing inquiry and booking workflows. The inquiry card now groups service title, seeker identity, request status, problem description and response actions. It uses Provider green for the main action. Inquiry details reveals the full wrapped description and existing manual photo gallery. Accept & set price still opens the existing ProposalModal and submits the same Offer; no booking or payment is created before the seeker approves.

Service Manager uses a prominent first-photo cover beside listing content on wide cards and above it on narrow cards. Full descriptions wrap, including long unbroken words and line breaks. All photos are shown only when View all is opened. Existing edit, availability, delete confirmation, revision notices and removal appeals are retained. Payment labels reflect the saved cash/GCash options.

## Public map consent

Migration `20261014040000_public_listing_map_consent` adds `Service.publicMapPin`, default false. Existing listings are not opted in automatically. Current create/edit forms expose no exact-public-pin checkbox and save publicMapPin false. Older provider records with explicit consent retain backend compatibility; editing through current forms clears that consent. The original consent control described the earlier implementation.

Nearby service map pins use the saved, unrounded latitude/longitude only when `publicMapPin` is true and indicate `approximate: false`. Otherwise they retain the existing fixed public area grid with `approximate: true`. Seeker requests/job pins remain approximate. Public listing projections still omit raw private-coordinate fields, venue directions and private addresses. Booking participants' agreed location snapshots remain independent; current eligibility ignores provider travel coverage.

The seeker location dialog seeds markers from the already loaded nearby result. Initial discovery does not add the old 250 ms delay; viewport changes remain debounced and cancellable, with four concurrent query windows. Completed batches appear progressively. Revalidation still authoritatively removes paused/deleted listings and temporary errors retain known markers. Cached pins are visible while fresh discovery is pending; a cold map still depends on its library, data and network loading. Listing icons remain clickable when a search pin shares their coordinate. Exact public pins are never pulled toward a search circle.

## City and barangay autofill

`GET /api/locations/reverse?latitude=...&longitude=...` requires authentication and a marketplace account, validates coordinates and shares the search route's bounded queue/rate limiter. The proxy performs explicit selected-point reverse lookups only, not continuous map pan/zoom requests. It extracts general locality fields and never returns street, house number or business-address text. Provider place data can be configured with `LOCATION_REVERSE_URL`; otherwise the reverse endpoint is resolved beside `LOCATION_SEARCH_URL`. Both use `LOCATION_SEARCH_USER_AGENT`, an eight-second upstream timeout, caching and a shared 1.1-second minimum between upstream requests.

The editor names preview/confirmed map or device pins without moving their coordinates. Confirmation remains required. Old, cancelled and unmounted requests cannot overwrite a newer pin or a manually corrected name. If no locality is available, users can enter it themselves. Reverse geocoding uses available map data and does not guarantee perfect administrative-boundary labeling. See [Nominatim reverse lookup](https://nominatim.org/release-docs/latest/api/Reverse/) and its [usage policy](https://operations.osmfoundation.org/policies/nominatim/).

## Saved feedback

Save and unsave success feedback uses the saving workspace: orange for Seeker saving provider services, green for Provider saving seeker requests. The Saved page's removal feedback follows the same rule. Error messages retain red error semantics; unrelated success messages keep their existing appearance.

## Verification

Use `SERVICEHUB_LISTING_MAP_ONLY=1 npm run test:fresh-migrations` in the backend. It verifies the recorded development database, creates a disposable schema, replays migrations, checks drift, runs map-consent HTTP and arrangement regressions, then drops the test schema. Reverse responses in that suite are intercepted upstream fixtures, not a live geocoder availability certification.

Frontend regression evidence is recorded in `.listing-ui-map-tests.log`, types/lint/build logs, and `.impeccable/review/listing-ui-map-review.json`. Browser checks use intercepted API fixtures at 1440px, 768px and 390px; they test photo expansion, long descriptions, provider actions, consent/autofill, map caching and Save toast colors without changing user data. Production deployment remains separate.

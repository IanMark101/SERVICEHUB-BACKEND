# Service arrangements

Provider listings and seeker requests support PROVIDER_VISITS, SEEKER_VISITS, BOTH and REMOTE. A booking or offer chooses one concrete arrangement. BOTH means either physical visit direction.

Providers select one base city/barangay when travelling, or their actual shop/workplace when receiving visitors. There is no provider travel-radius setting or coverage rejection. Legacy coverageRadiusKm is retained for record compatibility, ignored by eligibility checks and cleared on new/edited listings.

Seeker public requests select one job point for Provider visits or Both, and a desired provider-search area for Seeker visits. Both physical request types appear as approximate points in Browse Service Requests. Remote uses a general discovery area and no booking meetup point. Search distance filters nearby results and is not a provider travel limit. AI matching uses distance for ranking without a fixed 30 km travel rejection.

Search results and map pins are alternative ways to select the same location. A successful reverse lookup supplies its city/barangay name. The listing control closes to one selected-place summary. Manual label recovery appears only if lookup fails.

Pricing is independent of delivery arrangement. Fixed and hourly/daily/project listings use direct Cash approval or verified GCash checkout at posted terms in every arrangement. Provider visits sends the private job point and adds the displayed travel fee once. Only BY_AGREEMENT creates a private inquiry and approved provider offer. The inquiry and offer APIs reject attempts to negotiate a new price for a fixed/rate private inquiry; old unquoted inquiries show guidance to close and rebook. Historical accepted bookings and already-created payment attempts keep their existing settlement snapshots.

Exact private coordinates/directions remain outside public maps and unpaid previews. Shop pin publication still requires explicit provider consent. New public requests always require coordinates; historical unlocated cash listings retain their compatibility path.

No schema migration is required for this simplification. The existing REMOTE enum migration must already be present. Deploy the compatible API before the frontend.

Scoped automated checks and disposable-database integration results are recorded in the revised capstone technical evidence. Manual community acceptance remains separate.

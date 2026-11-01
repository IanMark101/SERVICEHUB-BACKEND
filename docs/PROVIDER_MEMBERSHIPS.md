# Provider memberships

Implementation: `feature/provider-memberships`, October 22, 2026. This revision is locally verified; it has not been pushed, deployed or migrated into production.

| Provider plan | Price | Period | Active listings | New GCash fee | Analytics |
| --- | --- | --- | --- | --- | --- |
| Free | PHP 0 | One 30-day trial | 1 | 10% | Basic totals and history |
| Basic | PHP 99 | Calendar month | 3 | 8% | Basic plus 30-day insights and daily breakdown |
| Pro | PHP 199 | Calendar month | Unlimited | 5% | Full; quality-eligible featured placement |

Customers remain free. Cash has no percentage commission or credit-wallet deduction. Provider memberships are the primary planned sustainability source; GCash commissions are supplementary. Adoption, revenue and sustainability have not been proven by simulated payments.

## Enrollment and rollout

Entering Provider starts one Free period. A Customer does not start a trial merely by browsing services. Shared accounts use the existing user role; workspace selection never grants Administrator authority. The subscription page requires an explicit Provider switch for a Customer, and paid checkout requires an enrolled, eligible verified marketplace member.

Migration `20261022090000_three_provider_memberships` gives existing Providers a full new trial at rollout, preserves active paid Pro periods, and leaves Customer-only accounts unenrolled. On Free, the oldest published active listing remains active; extra listings become inactive without deletion. An expired legacy Pro account receives the rollout trial. This transition is separate from later expiry, which never resets a trial or changes an expired Basic/Pro account back to Free.

## Access and expiry

`subscription-policy.ts` is authoritative. Exact dates are checked on each new commitment and public discovery query. Active or cancelled paid benefits require a started period with expiry strictly after now. Calendar months use Philippine time and clamp month-end. Free uses exactly 30 elapsed days.

Expiry hides retained active listings from new-customer discovery and blocks publishing, activation, browsing new requests/matches, offers, inquiries, acceptance, new direct cash requests and GCash initiation. Waitlist enrollment and availability notifications also respect membership. Existing confirmed bookings, later scheduled work, messages, start/completion, disputes, cancellation, reviews and financial history remain available. Booking payment snapshots are preserved.

Saved customer requests follow the same access rule. Expired or unenrolled accounts retain removable bookmarks, but receive no request contents; reading Saved does not start a trial. Customer-side saved services remain available without Provider enrollment. Completing Provider enrollment refreshes an already-open Saved page.

Public request creation/update events contain only the request ID and status. Clients fetch contents through the membership-checked API. Socket connections and authorized existing-booking rooms remain available after expiry.

Renewal is manual after expiry and starts a new calendar month on verified payment. Cancellation retains paid access until expiry. No automatic recurring charge exists. Eligible active listings become discoverable again on renewal; manually paused or excess listings stay inactive until explicitly activated within capacity.

## Payment integrity and changes of plan

`POST /provider/subscription/quote` creates an owned HMAC-signed price valid for 15 minutes. `checkout` requires the selected Basic/Pro plan and token. A stored payment attempt carries its amount, billing action, membership version and, for upgrades, existing period expiry. Server-to-server intent verification checks ownership, amount, PHP currency and purpose metadata. Duplicate callbacks do not create another activation. Ambiguous gateway failures reuse the original idempotency key; unusable captures use existing refund recovery and unresolved payments block unsafe deletion.

Basic to Pro charges `(199 - 99) × remaining paid time / full paid period`, rounded once to centavos, and keeps the original start and expiry. An upgrade below the gateway's PHP 1 minimum is declined before charging; the Provider can choose Pro after expiry. An active Pro member can choose Basic after Pro expiry. Before purchase, Basic discloses that the three oldest published active listings remain active and excess listings are paused without deletion.

The central fee is snapshotted when a new GCash attempt is created: Free 1,000, Basic 800, Pro 500 basis points. The agreed total includes travel. Fee uses decimal half-up rounding to centavos; Provider net is gross less fee. A PHP 500 booking gives fee/net 50/450, 40/460 or 25/475. The Customer total stays 500. Later plan changes do not recalculate existing attempts. Cash completion records no fee.

## Interface, analytics and notifications

Public landing pricing and the dedicated close-only Subscription page share three aligned cards, visible prices and fees, with Basic recommended. The existing registration and account flows are reused. My Services and Payment Records show plan/status/expiry/fee/listing usage. Active paid members receive 30 Philippine calendar days of settled owner-only earnings, booking count, average earnings, fees and a daily breakdown. History and basic totals stay accessible on every plan and after expiry. Recorded Test amounts are labelled and are not a payout balance.

Admin Subscriptions separates memberships and payments, displays all plans, status, dates and fees, and separates real membership revenue from simulated totals. Hourly bounded maintenance stores one notice per period at seven days, one day and expiry; verified paid activation stores a once-only confirmation. Security does not depend on that job running on time.

Pro alone is eligible for Community featured services, subject to approved public-account/listing rules, trust at least 50, and at least one visible Provider review averaging at least 4/5. Up to six results show one listing per Provider, ranked by `0.6 × trust + 0.4 × (20 × rating)`. No additive paid trust/rating bonus exists. Ordinary nearby sorting and the community leaderboard are unchanged.

## Verification and release

Verified locally: 1,506 frontend tests across 204 files, frontend lint and both production builds; 303 backend schema/policy tests; 15 isolated integration checks (14 named scenarios plus their parent); one separate legacy rollout test; all 54 migrations replayed into a disposable development schema with 43 tables including migration tracking, and no schema drift. Existing confirmed Free, Basic and Pro bookings survived expiry, messaging, start, completion and cash settlement. Signed quote ownership/tampering, fee snapshots, proration, duplicate callbacks, failed/cancelled/late payments, refund recovery, renewal/downgrade, analytics and reminder deduplication were exercised with synthetic records and a simulated gateway.

Compiled UI checks cover desktop, tablet and phone in light/dark mode using intercepted synthetic API data. These do not establish live gateway acceptance, community evaluation, actual revenue or usability outcomes. Production rollout still requires the migration before the dependent API/frontend and deployment-specific acceptance; no production migration was performed for this change.

### Audit follow-up: Saved access and live events

The two request-reading gaps found in the follow-up audit are corrected: Saved hydration applies membership checks while retaining removable bookmarks, and public request events send only ID/status. The fix passed 312 backend tests, 23 isolated database checks, 76 focused frontend regressions, both production builds and touched-file lint. A connected Socket.io fixture verified minimal events after expiry while existing booking-room messages stayed available. The database suite also retained the Free/Basic/Pro existing-work expiry checks and the broader Saved ownership/privacy scenarios. Payments remained simulated; production rollout is still pending.

### October 23: paid-benefit comparison and Customer trial correction

A real-record HTTP and compiled-browser comparison verified Free/Basic/Pro listing limits, 10%/8%/5% fee snapshots and Customer displays, lifetime history, paid 30-day analytics, quality-qualified Pro featured placement, expiry and renewal. Basic and Pro share the same analytics; Pro adds listing capacity, its lower GCash fee and eligible featured exposure. The audit found that the shared frontend data loader opened the Provider opportunity feed for Customers, inadvertently starting a trial. Customer background reads now use the existing owned-request endpoint, with stale-response protection across workspace changes and sign-out. The rebuilt Customer receipt flow retained a null trial start. Final checks passed 1,512 frontend tests, 312 backend tests, 23 isolated integrations, the production frontend build and changed-file lint; 18 behavioral comparison scenarios passed. Two deliberately expired work-feed requests correctly returned 403. All temporary audit schemas/accounts/records were removed; existing development users/listings remained 16/15. Payments were simulated and no deployment occurred. Detailed evidence is retained under `.work/paid-membership-audit-2026-10-23/` in the parent workspace.

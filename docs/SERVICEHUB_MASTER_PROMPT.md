# SERVICEHUB MASTER PROMPT

**Specification version:** 3.0
**Effective date:** October 10, 2026
**Status:** Code-aligned documentation baseline; runtime acceptance remains evidence-dependent

This is the authoritative specification for **ServiceHub**, a location-based two-sided service marketplace and queue-management system. Seekers and providers discover nearby services and requests across communities and cities, then use the two established transaction flows. Read this document before changing application behavior or generating the SRS, SDD, SPMP, or STD. The repository-root `SERVICEHUB_MASTER_PROMPT.md` is a complete, identical copy for documentation preparation.

### How to interpret this document

- **Baseline:** October 10, 2026 static review of the current working tree, including uncommitted application changes. Part 30 records implementation status and source evidence. This revision changes documentation only; it does not certify deployed migrations, external integrations, or end-to-end test results.
- **Implemented** means corresponding code exists, not that every scenario has passed acceptance testing. **Configuration-dependent** requires external credentials/services. **Backend-only** is not a completed user-facing feature. **Future/excluded** must not be presented as current functionality.
- **MUST / MUST NOT** means a required security, data-integrity, or capstone behavior.
- **SHOULD / SHOULD NOT** means the default design unless there is a documented technical reason to differ.
- **MAY** means optional behavior.
- If prose conflicts with a status table or invariant in this document, the **status table or invariant wins**.
- An explicit new user decision may supersede this document, but the same change MUST update this file before related implementation is considered complete. Do not allow code and this specification to evolve separately.
- Existing code is not automatically correct merely because it predates this version. Conversely, internal package names and historical migration names do not need cosmetic renaming when they are not user-visible.
- This document defines product behavior. Secrets, local credentials, live access tokens, and real identity documents MUST NOT be copied into this file.
- For as-built documentation, schema/migrations define persisted structure and current routes/services/components define implementation. A normative requirement, historical amendment, comment, or enum alone does not prove implementation. Record a discrepancy as a gap; do not silently describe desired behavior as completed. Historical amendments at the end explain past decisions and do not override this baseline.

---

## PART 1 — SYSTEM IDENTITY

- **Name:** ServiceHub. Use this exact name in UI, browser metadata, accessibility labels, notifications, emails and current documentation. Existing technical hostnames and historical migration identifiers may remain without defining geographic scope.
- **Implemented geographic scope:** Nearby discovery across communities, cities and municipalities. No single municipality or fixed barangay list defines membership or transaction eligibility. The backend combines coordinates/distance with existing account, availability and service-coverage rules.
- **Marketplace concept:** Location/radius browsing and listing comparison similar to a nearby marketplace. ServiceHub specializes in services and work requests, with verified participation, two distinct hiring flows, booking records, a paid work queue, completion confirmation and reviews. The analogy does not introduce goods sales, unrestricted messaging, auctions or a social feed.
- **Current deployment context:** Registration validates Philippine mobile numbers, amounts use PHP, and explicit place search is configured for Philippine localities. Cross-city discovery is implemented; worldwide onboarding/payments and regional administration are not established capabilities.
- **Core purpose:** Help members find nearby providers or work opportunities and complete accountable service transactions with fair provider-wide paid queues, PayMongo Test Mode records and trust history.
- **One-sentence description:** ServiceHub lets verified members discover nearby services and requests, book a provider listing or accept an offer on a posted request, coordinate work/payment, and build trust through completed transactions and reviews.
- **Account roles:** Persisted values are `user` and `admin`. A member switches between Seeker and Provider workspaces under one account. Administrators moderate the platform and cannot act as marketplace participants through their admin account.
- **FCFS product rule:** online-paid bookings share one provider-wide waiting order across direct listings and accepted custom offers. A listing advertises a normal service; it does not own an operational queue.

---

## PART 1A — IMPLEMENTED NEARBY MARKETPLACE

### Separate location concepts

| Setting | Purpose | Current behavior |
|---|---|---|
| Profile locality | General area on the member profile | Free-text city/municipality and barangay; no fixed-city suffix or restricted barangay list |
| Seeker search location/radius | Discover provider services | Saved separately per member/workspace in this browser; changing it does not update the profile |
| Provider search location/radius | Discover open work requests | Independent of the seeker's saved search preferences |
| Service operating base/coverage | Where a listing operates and accepts jobs | Validated base pin/area label; optional 1–30 km coverage limit and transportation fee |
| Request job location | Where the requested work happens | Validated pin/area label, optional private directions and additional travel budget |
| Booking job location | Agreed work location | Snapshotted with amount, transportation and estimated duration for the transaction |

### Discovery and filtering

- Seek Services uses `GET /api/services/nearby`, a public endpoint with optional authentication and redacted listing data. Browse Service Requests uses `GET /api/requests/nearby`, which requires an authenticated marketplace member with verified email; identity/residency approval is not required merely to browse. Both validate latitude, longitude and radius. The workspace UI has its own authentication/email gates. Other public listing/explainer routes retain their own access policy. Backend router-relative paths elsewhere in this document are mounted under `/api` in `src/app.ts`.
- The UI offers radii of 1, 2, 5, 10, 15, 20 and 30 km. The API validates a 1–30 km radius and paginates results (default 6; maximum 30 per page).
- A geographical bounding box reduces candidates, followed by exact Haversine distance filtering. Municipal/city labels do not define eligibility. Distances are straight-line estimates, not road routing, travel times or guaranteed arrival times.
- Keep the discovery flow simple: a Seeker request has one actual job pin without its own radius; a Provider listing has a base pin and optional service coverage; each browsing workspace has an independent search center/radius. Do not add a second request-radius restriction to Provider discovery.
- Seek Services compares the chosen search center with service operating bases; Browse Service Requests compares it with request job pins. Default ordering is nearest first, with trust score breaking service-distance ties and newer requests breaking request-distance ties. Budget/offer quick filters retain their existing ordering.
- Search matches service/request title, description and category rather than merely the account name. Search, category and radius remain combined filters. Seeker quick filters cover availability, rating and waiting workload; provider quick filters cover urgency, budget and offer count.
- Opening the location dialog edits a draft. Apply commits it; Cancel/Escape discards it. Optional device geolocation is requested only through an explicit user action.
- Loading skeletons represent initial/query loading. Focus/reconnect refresh keeps confirmed cards or an empty result visible; a failed background refresh preserves that result with a recovery action.
- Records without coordinates remain in owner management and transaction history but do not appear in nearby discovery until the owner adds a location. Do not guess coordinates from profile text or migrate every legacy record to one default city.

### Coverage, price and privacy

- Search center, profile area and actual job point are independent. A listing appearing in search does not establish that the final job pin is within coverage. Validate listing coverage against the actual job location when preparing a direct booking or a linked offer.
- Provider create/edit forms put Service coverage radius above the operating-base map and pass the saved radius to its circle. The circle follows the base pin and updates in embedded/full-screen views. No distance limit shows the base pin without a circle. Seeker job-location forms show one job pin; both browsing location dialogs show their search-radius circles.
- Location and radius do not choose who travels. Participants arrange provider visits or visits to the provider through chat; do not add a required travel-mode selector to the current flow.
- A listing transportation fee is added once to a direct booking, including multi-hour/day quantities. A request's additional travel budget is context for the quote; it is not automatically added again to the accepted offer's final total. Current transportation/travel allowance validation supports 0–₱5,000 with at most two decimal places.
- Public discovery responses/broadcasts omit exact coordinates and private directions. They show the general area and approximate distance rounded to 0.1 km. Authorized booking participants can see the transaction's job point/directions; current search preferences must not store private job directions.
- GCash preparation snapshots the job and payment terms before checkout. Finalization uses that snapshot. Profile/listing/search edits do not silently rewrite an existing booking or successful payment.
- Editing a request's job/travel terms while active offers exist is restricted to protect existing quotes. Follow the current API validation; a new request is the recovery when terms cannot be changed safely.

### Maps and deployment limits

Every interactive location map has an optional in-map expand control for a full-viewport view, including Seeker job-location forms, Provider operating-base forms and nearby-search dialogs. The embedded map keeps its original form container. Expansion opens a separate full-screen map overlay with shared pin and coverage settings; selections made there update the same form location. Users can exit with the on-map control or Escape; the form and any enclosing dialog stay open. Full-screen map focus stays contained, page scrolling is paused, and closing restores focus to the expand control. Seeker controls use orange and Provider controls use green in both embedded and expanded views.

Selected locations use a recognizable teardrop map pin with a white center/outline and workspace color, consistently in embedded and full-screen maps. The pin tip anchors the exact selected coordinate and coverage-circle center; dragging retains the existing selection behavior.

Leaflet uses the configured map tiles with visible attribution. `GET /locations/search` performs explicit city/barangay searches through the backend. The current default is Nominatim with Philippine locality filtering, caching, query validation, a per-user rate limit and a single-process upstream request limiter. The map pin remains a recovery path when search fails. There is no background reverse-geocoding or per-keystroke autocomplete.

Document `LOCATION_SEARCH_URL`, `LOCATION_SEARCH_USER_AGENT`, `NEXT_PUBLIC_MAP_TILE_URL`, and `NEXT_PUBLIC_MAP_ATTRIBUTION` without copying secrets. Multiple backend instances/high traffic require a shared upstream limiter or an appropriate geocoding provider. The additive proximity migration exists; deployment/database application must be verified for the target environment rather than assumed from the code or a passing build.

Cross-city discovery is current functionality. Region-specific administrator partitions, regional policy engines, international payment/onboarding support, road routing and appointment scheduling remain future scope.

---

## PART 2 — TECH STACK

- **Frontend:** React through the existing **Next.js App Router** application. Do not migrate frameworks during capstone stabilization unless the user explicitly authorizes a separate migration project. Client/server component boundaries must remain deliberate, and browser-only authentication or Socket.IO code must run only in client components.
- **Backend:** Express + TypeScript
- **TypeScript config:** Preserve strict checking. The backend uses `module: "Node16"`, `moduleResolution: "Node16"`, `strict: true`, `noImplicitAny: true`, and a CommonJS package. `tsx` runs development; `tsc && tsc-alias` builds it and `node ./dist/src/server.js` starts it. Derive frontend compiler settings/dependency versions from its actual configuration and lockfile. Do not weaken type safety or switch module systems as an unrelated fix.
- **ORM:** Prisma
- **Database:** PostgreSQL through Prisma's PostgreSQL adapter; Neon is the project's hosting context. Actual target, capacity, applied migrations, backups, and availability must be established for the documentation's environment. A free-tier sufficiency or production-capacity guarantee has not been measured.
- **Payments:** PayMongo, **Test Mode only** for the entire build and defense period. No real money is needed. The application simulates a payment hold in its own ledger; it is not PayMongo escrow.
- **AI:** Gemini API
- **Supporting integrations:** Socket.IO for realtime delivery, Nodemailer/SMTP for email, Cloudinary for media/private evidence, Leaflet for maps, backend-mediated Nominatim place search by default, optional Google sign-in and optional Google reCAPTCHA v2.
- **Installed package baseline:** frontend Next.js 16.3.3, React 19.2.4, Tailwind CSS 4, Leaflet 1.9.4; backend Express 5.2.1, Prisma 7.10, TypeScript 6.0.3. Recheck package manifests/lockfiles when producing version-specific diagrams or deployment instructions; these are not guarantees about the deployed environment.
- **Backend path aliases:** if the backend emits unresolved TypeScript `paths` aliases, run `tsc-alias` after `tsc`. This requirement does not apply when emitted imports are already directly resolvable.

---

## PART 3 — USER ROLES AND ACCOUNT BEHAVIOR

- One `USER` account can act as both Seeker and Provider, switching via a workspace toggle in the UI. Switching workspaces resets the active tab to that workspace's default (Seeker → "Seek Services", Provider → "Browse Service Requests").
- Trust score, verification status, and profile data are shared across both roles — one identity, two dashboards, never two separate accounts.
- Profile saves submit only changed fields. Private phone data omitted by the public-profile endpoint is preserved from the owner's authenticated session; unchanged missing/legacy contact fields do not block a links, bio, photo or area update. Edited mobile numbers still require validation, the existing active-engagement lock and password confirmation. Non-empty profile links must use HTTPS; links may be cleared.
- General profile locality is independent of discovery/listing/job pins. Google-created accounts may have empty phone/location fields until the member completes them. Verification approval does not automatically populate the profile area; an empty area displays “Location not provided”.
- The current profile UI derives its @ display label from the member's name. It is not a stored/unique username, a chosen account handle, a searchable handle contract or a sign-in credential. Email/password and configured Google sign-in remain the actual sign-in methods.
- Admin accounts are provisioned directly through controlled database administration, never through public signup or an in-app promotion API. User Management MUST NOT offer a Make Admin action. Before changing a role in the database, the maintainer must resolve active bookings, held payments, and unresolved cases, record the reason in the administrator audit log, and revoke existing sessions. Role changes MUST NOT delete historical marketplace records.
- **Default state on account creation:** `verification_status: UNVERIFIED`, `trust_score: 50`, `moderation_status: ACTIVE`, `is_active: true`, `email_verified: false`.
- **Canonical account moderation statuses:** `ACTIVE | SUSPENDED | BANNED`.
  - `ACTIVE` permits normal behavior subject to email/residency verification, role, ownership, availability, and lifecycle rules.
  - `SUSPENDED` blocks every new marketplace relationship and Start Job, but keeps narrowly restricted access to existing engagements that must be resolved safely.
  - `BANNED` immediately blocks all normal authenticated ServiceHub access, including workspaces, messaging, payments, profile changes, and existing-engagement actions. The account may authenticate only into a banned-account notice with Appeal and Log Out.
- `moderation_status` is the authoritative access gate on every authenticated API request and socket connection. `is_active` is separate account deactivation state; keeping it true to support the ban notice never grants normal access.
- **System-wide text styling:** No text underlines on any public, authentication, Help Center, Seeker, Provider, profile, or Administrator page, including hover/focus states. Do not simulate underlines with borders, inset shadows, or decorative bars below labels. Use color, font weight, icons, filled selected states, and keyboard focus outlines to distinguish actions and selection.
- **Workspace Color & Theme Separation (UI Boundary):**
  - **Seeker Workspace:** Governed by **ServiceHub Orange (`#FF6B00`)**, with a centralized palette in `SERVICEHUB-FRONTEND/src/app/brand.css`. Use the vivid brand accent for decorative marks and emphasis, readable dark-orange action shades (`#C24C00`, hover `#A64000`) with white labels for primary buttons and active navigation, and theme-specific orange text, focus and supporting tints. Preserve the existing layouts and typography when changing colors. Green primary buttons should not appear in Seeker views.
  - **Provider Workspace:** Governed by emerald green (`#059669` accent; `#087E5F` navigation token) for provider service offerings, offer submissions, queue operations, and category-scroll controls. Derive exact action, hover and focus shades from the existing theme tokens.
  - **Admin Workspace:** Governed by **Crimson / Slate (`#dc2626` / `bg-red-600`)** for administrative moderation, verification queues, and dispute files.

---

## PART 4 — AUTHENTICATION AND ACCESS GATING (CRITICAL — IMPLEMENT EXACTLY AS SPECIFIED)

### Signup
Fields: full name, email, phone number, password, location. Validate: email format, password strength (min 8 characters, uppercase, lowercase, number, special character, max 72 UTF-8 bytes), PH mobile phone format, duplicate email check. On success: create account with the default state above, send an email verification link.

### Login
Correct credentials may establish a session regardless of verification status; verification gates subsequent actions. A `BANNED` account receives only a restricted identity session for the notice, appeal, and logout, and must never reach a normal workspace. The notice explicitly states that the account is banned. On success: issue a short-lived JWT access token plus a longer-lived refresh token (HTTP-only cookie, rotated on use). On invalid credentials: show a generic "invalid credentials" message — never reveal whether the email exists.

### Authentication/session invariants

- When `is_active=true`, account moderation still applies: `ACTIVE` receives normal access subject to other gates; `SUSPENDED` receives the existing restricted case mode; `BANNED` receives only the ban notice, appeal, and logout. Existing refresh sessions must recover into the same restricted experience.

- Access tokens are short lived. Refresh tokens are hashed at rest, stored in `HttpOnly` cookies, rotated on every successful refresh, and revoked on logout/password reset. Cookie `Secure`, `SameSite`, domain, and path settings must match the deployed same-site/cross-site architecture.
- CORS uses an exact environment allowlist with credentials enabled only for trusted origins. Never reflect arbitrary Origin values.
- The frontend resolves authentication once before firing protected dashboard queries. Concurrent `401` responses share one refresh request; after one failed refresh, clear local auth, disconnect Socket.IO, cancel/disable protected queries, and redirect to login. Never create a refresh/request retry storm.
- `401` means missing/expired/invalid authentication. `403` means authenticated but not authorized, unverified, suspended, or ownership-restricted. Clients must not attempt token refresh for ordinary `403` responses.
- Rate-limit login, signup, OAuth, refresh, password-reset, and verification-email endpoints by an appropriate combination of IP and account identifier without revealing account existence.

### Optional CAPTCHA protection

Google reCAPTCHA v2 is implemented behind `RECAPTCHA_ENABLED`, with backend site/secret keys and an allowed-hostname list. `GET /api/auth/captcha-config` supplies public configuration. When enabled, registration and forgot-password require a server-verified CAPTCHA token; password login challenges after three recorded failed logins per IP within a 15-minute single-process window. Verification checks hostname and challenge age with a five-second upstream timeout. Disabled CAPTCHA does not remove the existing authentication rate limits. Do not describe it as enabled on a target deployment without checking configuration, or as a distributed risk engine.

### Self-service account deletion

- Account deletion belongs to the account owner in Account Settings. Admin must
  not receive deletion approval requests or offer an account-finalization queue.
- Show a server-authoritative checklist with counts and links to Service Manager,
  Request Manager, both Activity pages, and Help Center. Published provider
  listings must be paused; open seeker requests must be paused or closed.
- Block deletion while either role has unfinished bookings, waiting/serving queue
  jobs, held funds, pending payment or refund processing, failed refunds, or
  unresolved booking/content reports, cancellations, completion reviews, appeals,
  retryable case-resolution operations, or explicit verification-document holds.
  A historical declined cancellation stops blocking once its booking is terminal.
- After the checklist clears, the user types exact `DELETE`, then verifies the
  current account password. If configured, fresh Google verification may be used
  for the same verified email, with a short-lived nonce challenge bound to the
  account and authenticated session. Neither the typed word nor the current
  signed-in session alone authorizes deletion. Rate-limit verification attempts.
- Recheck identity, session validity, credentials, and every blocker inside the
  account lifecycle transaction. Concurrent publication or new engagements must
  not escape this check. A blocked attempt returns an updated checklist.
- Successful deletion physically deletes the User row and associated database
  data in one transaction: credentials and sessions, verification/proof records,
  listings, requests, offers, closed bookings, queues, payments/refunds, reviews,
  chats, notifications, case records, trust/audit history, summaries, and previous
  deletion receipts. Do not keep a `Deleted account` placeholder or create a new
  user-linked deletion receipt. Remove legacy string references as well as FKs.
- Deleting shared closed bookings also removes their history from the other
  participant's views. Explain this permanent consequence before `DELETE`.
  Other accounts and unrelated engagements must survive. Existing obligations
  and explicit holds still block deletion. Storage-provider files and backups
  are separate from live database records; do not claim they are erased by SQL.

### Restricted marketplace mode for moderation

- A suspended user cannot create a listing, service request, offer, booking, payment, review, or any other new marketplace relationship.
- Suspended users cannot Start Job on `PENDING_APPROVAL` or `ACCEPTED` work. They may view the details and booking-scoped messages of existing engagements, respond to a cancellation, file a legitimate report, confirm completed work, and respond to an Admin case.
- A suspended provider may Mark Completed only for work already in `ONGOING`. Either participant may perform the required resolution actions for `AWAITING_CONFIRMATION`, `DISPUTED`, an active `CancellationRequest`, or an active `CompletionEscalation` when ownership and lifecycle checks allow it.
- When suspension or banning affects `PENDING_APPROVAL` or `ACCEPTED` work that has not started, Admin MUST use an idempotent cancellation/reconciliation workflow. Banning itself takes effect first; booking and payment records are preserved for Admin to resolve. Canceling an online-paid booking refunds it, closes/reindexes its Queue row, and notifies both parties; cash creates no platform refund.
- Existing `ONGOING`, `AWAITING_CONFIRMATION`, `DISPUTED`, CancellationRequest, CompletionEscalation, refund, and reconciliation records remain resolvable through Admin action while either participant is banned. Suspended participants retain only the previously defined restricted resolution access. Booking transfer is not part of the capstone; Admin uses the existing cancel, refund, release, complete, dismiss, or restore outcomes.
- For a banned participant's `ONGOING` or `AWAITING_CONFIRMATION` booking with no active case, Admin may cancel and refund held online funds with a reason. An online-paid `AWAITING_CONFIRMATION` booking may instead be completed and released after Admin reviews the work. Admin must not claim an on-site cash payment was confirmed without the seeker's confirmation. The decision reserves a durable booking resolution, rechecks conflicting cases, updates the queue, notifies both parties, and leaves an audit record; interrupted financial effects must be retryable without duplication.
- A banned user may submit one appeal per ban decision. Admin reviews the appeal, current moderation state, relevant history, and open obligations; a reasoned approval restores `ACTIVE`, while rejection leaves `BANNED`. Manual unban requires an Admin reason and resolves a pending appeal. Neither path bypasses email or residency requirements.
- Suspension, banning, restoration, appeal decisions, and related booking/payment decisions require a reason, server-side authorization, transactionally safe and idempotent effects, an immutable AdminAuditLog, and participant notifications. Historical records are never silently deleted.

### Email-verification gate

- A user with `email_verified=false` may authenticate, but is restricted to the dedicated Email Verification gate. They cannot enter the Seeker or Provider dashboard, including through a direct URL, browser history, or workspace switching. The gate shows the destination email and supports resend, server-authoritative status check, and logout.
- After the backend confirms `email_verified=true`, the dashboard becomes available. Identity/residency verification status determines Limited Mode versus transactional access; email and document verification are separate gates. The member's municipality does not decide eligibility.
- They MUST NOT submit residency proofs or initiate new marketplace relationships: create a request/listing/offer/booking, accept an offer, initiate payment.
- If a legacy account or later email change leaves an existing engagement active, the user may still view/message it and perform the actions needed to resolve it safely (accept/decline an existing obligation, cancel, Start Job, Mark Completed, confirm, report, or respond to a cancellation). Never trap held funds merely because email verification changed. New engagements remain blocked.
- This email-verification resolution exception does not override moderation: a suspended provider cannot Start Job, and a banned user cannot access any normal engagement route.
- The frontend redirects normal workspace entry to **"Verify your email to continue"**. Backend-gated actions return `403 EMAIL_NOT_VERIFIED`; authorization never relies on a hidden button.
- Email verification is checked before residency verification. Marketplace transactions require both `email_verified=true` and `verification_status=APPROVED`, plus all normal account/ownership/status rules.
- A Google identity whose ID token contains a verified email may set `email_verified=true` after successful backend token verification; it does not approve residency.

### Optional Google OAuth

- Google OAuth is Tier 1, never the only login path. If either frontend or backend client configuration is missing, hide/disable the Google button with a configuration message; do not render a knowingly invalid Google client ID.
- Configure every real development/deployment origin in Google Cloud (for example the exact `http://localhost:3000` origin during local development). Origin errors are configuration failures, not authentication vulnerabilities.
- The backend verifies the Google ID token signature, issuer, audience/client ID, expiry, and verified email. Never trust profile data sent separately by the browser.
- OAuth may link to an existing account only when the verified email matches under a documented safe linking rule. It must never promote an account to Admin or automatically approve identity/residency verification.
- Google does not supply a dependable phone number. A Google-created account may therefore begin with an incomplete phone/location profile and must receive a clear profile-completion prompt; the UI must never invent placeholder contact data.

### First-time orientation

- A new normal user begins with `onboarding_status: PENDING`. On the first authenticated Seeker or Provider workspace visit, the application shows a short orientation explaining the unified account, marketplace flows, access gates, trust/queue/payment/messaging/review basics, and profile next steps.
- Onboarding is never a marketplace authorization gate. The user may complete or skip it; either choice is persisted on the User as `COMPLETED` or `SKIPPED` so the prompt does not repeat across devices.
- Help Center may reopen the orientation without resetting the persisted choice. Detailed rules remain in Help Center rather than being duplicated in the short first-time flow.
- Existing users at the time this feature is introduced are migrated to `COMPLETED`; only accounts created afterward are automatically prompted.

### The Residency Access-Gating Rule (Hybrid Model — applies only after the email gate)

```
verification_status: UNVERIFIED or REJECTED
   → User can log in and reach the dashboard in "Limited Mode"
   → CAN: browse services, view provider profiles, read Community Hub, search
   → CANNOT: book a provider, post a request, accept an offer, create a
     service listing
   → Every blocked action shows a clear prompt: "Complete identity and
     residency verification to continue" with a button to the verification
     upload screen — NEVER a silent failure or generic error

verification_status: PENDING_REVIEW
   → Same restrictions as above, different message: "Verification under
     admin review. Marketplace actions unlock after approval."

verification_status: APPROVED
   → Verification-gated marketplace actions are enabled
   → All other authorization, ownership, moderation, availability, queue,
     self-transaction, and account-status rules still apply
```

The diagram above assumes `email_verified=true`. An email-unverified account stays at the Email Verification gate, even if a legacy residency record says `APPROVED`. Narrow existing-engagement resolution APIs remain available under participant ownership and lifecycle checks so held funds or disputes are not stranded; they do not grant normal dashboard access or permission to initiate new work.

**Implementation requirement:** the email and residency gates must be enforced on BOTH frontend and backend for every route that initiates a new marketplace relationship or submission. Existing-engagement resolution routes must instead verify participant ownership, account safety, and allowed status while honoring the narrow resolution exception above. Do not attach one broad middleware in a way that traps an accepted obligation or held payment. The backend is authoritative. Authentication failures use `401`; authenticated users lacking email verification, residency verification, or permission use `403` with distinct stable machine-readable codes.

```typescript
// Backend middleware example — apply only to gated routes
export const requireVerification = (req, res, next) => {
  if (req.user.verification_status !== 'APPROVED') {
    return res.status(403).json({
      error: 'VERIFICATION_REQUIRED',
      message: 'Please complete identity and residency verification to perform this action.'
    });
  }
  next();
};

// Apply requireEmailVerification, then requireVerification, to marketplace mutations.
// Examples: POST /requests, POST /bookings, POST /services, POST /offers
// Do NOT apply to: GET /services, GET /community-hub, GET /providers (browsing stays open)
```

### Forgot Password
Password-enabled user requests reset by email → send a time-limited link (~30 min expiry) → enter and confirm a strong new password → invalidate all sessions. Unknown emails and Google-only accounts receive the same generic acknowledgement. Google-only accounts create their first password in Settings after fresh Google verification.

### Sign-in methods and password management

- Password availability is explicit (`passwordState`: NONE, SET, or LEGACY_UNCONFIRMED); a stored hash alone never proves that the owner created a password. New email registrations are SET. New Google registrations are NONE and retain an unusable random hash only for storage compatibility.
- Store the verified Google `sub` as a unique account identity. Google and email/password are separate sign-in methods on the same account. Google connection never approves residency or changes the account role.
- Google-only: Settings → Password & Security → No password set → Set Password → fresh Google verification → New Password + Confirm New Password → password created; both Google and email/password then work. Never ask for Current Password in this path.
- Password-enabled: Change Password → Current Password → New Password + Confirm New Password → password changed; revoke every session and display a success notice at sign-in. Incorrect current passwords appear on that field.
- New passwords require at least 8 characters, uppercase, lowercase, number, and special character. Enforce the same Zod/regex rules on client and server, including bcrypt's 72-byte bound. Confirm password is required and must match.
- Google setup challenges and grants last five minutes, are bound to the authenticated account/session and Google identity, use a nonce and a separate signing purpose, and cannot authenticate ordinary API calls. Password creation is atomic, rejects replay/concurrent creation, invalidates reset tokens, and revokes other sessions while retaining the freshly verified current session.
- Migrate legacy accounts only using positive evidence (email registration verification records, used password resets, or established admin credentials). Ambiguous hashes remain unconfirmed. Successful existing-password comparison confirms SET without breaking older passwords; verified Google setup recovers older Google accounts directly in Settings. Do not infer signup origin from an avatar, email domain, profile completeness, or hash format.

---

## PART 5 — COMMUNITY VERIFICATION WORKFLOW (IDENTITY + RESIDENCY)

Verification supports trust: administrators review identity and evidence of current residence under the same rules across participating communities and cities. It is not membership in a particular municipality and must not reject an otherwise valid applicant merely for living in a different city.

Every marketplace member must complete email verification and receive Admin approval of submitted proof before initiating verification-gated interactions: publishing a service, posting a request, submitting/accepting an offer, booking or joining paid work. One account approval applies to both Seeker and Provider workspaces. Uploading a file, selecting a document label or setting a map pin never grants approval. Limited browsing/profile/submission access and the narrow existing-engagement recovery rules in Part 4 remain distinct from new marketplace participation. Admin accounts are separately provisioned platform accounts, not ordinary marketplace members.

The uploader validates file/submission rules rather than deciding whether the document is genuine or sufficient. The current API accepts one or two private proof images categorized as `GOVERNMENT_ID`, `BARANGAY_ID`, or `PROOF_OF_RESIDENCE`; JPG/JPEG, PNG and WebP images up to 5 MB each are supported. Admin must inspect the submitted content and approve or reject it with a reason. These broad categories are not a municipality-specific document list and do not establish automatic identity/document recognition or acceptance of every file format.

Before selecting or submitting verification files, an email-verified user MUST be shown the current verification privacy notice and must actively acknowledge it. Opening the page, choosing a file, or continuing to use ServiceHub is not acknowledgement.

```
States: UNVERIFIED → PENDING_REVIEW → APPROVED
                          ↓
                       REJECTED (user can resubmit, returns to PENDING_REVIEW)
```

### Flow
1. An email-verified user opens the profile Verification tab and submits the allowed identity/residency proof with the current privacy acknowledgement. Derive document requirements from the implemented schema and UI. Evidence establishes identity and current residence rather than a prescribed city.
2. Submits → `verification_status: PENDING_REVIEW`.
3. Admin reviews in Admin → Users & Trust → Verification Queue, checking:
   - Is the document a valid, real ID/proof type?
   - Does the name match the account name?
   - Does the evidence support the account holder's identity and stated current residence? Do not impose a fixed-city address requirement.
4. **Approve** → `verification_status: APPROVED`, "Verified Resident" badge granted, one-time `trust_score: +5`, user notified.
5. **Reject** → `verification_status: REJECTED`, admin must include an actionable reason (e.g. "Document unreadable, please resubmit" or "The name does not match your account"), user notified, can resubmit under the existing workflow.

### Data model
Actual Prisma models are `ServiceVerification` and `VerificationProof`, mapped to `service_verifications` and `verification_proofs`. A submission stores `privacyNoticeVersion`, server-recorded `privacyAcknowledgedAt` and `privacyAcknowledgedBy`, `retentionUntil`, and `legalHold`, in addition to review metadata. Proof metadata includes `storageKey`, `mimeType`, `sizeBytes`, and `documentType`; a nullable legacy `fileUrl` remains. APIs expose authorized short-lived access, not reusable public proof URLs. Part 26 lists the actual persisted field names.

### Privacy notice and recorded acknowledgement

- Before document upload/submission, the UI MUST explain what identity/residency information is collected, why it is collected, that authorized Admins may review it, that files are private, which external storage/infrastructure providers process it when applicable, the stated retention period, when deletion may be requested, why unresolved disputes/security investigations/audit holds may delay deletion, and how to contact the project administrators.
- Submission requires affirmative `privacyAcknowledged: true` and the current `privacyNoticeVersion`. The backend records acknowledgement time and actor; clients do not supply a trusted `consented_at` timestamp. The current notice version is `2026-10-09-v3`, with a normal 365-day retention deadline.
- The notice version and timestamp are immutable for that verification submission. A new submission after a material notice change requires acknowledgement of the new version. These fields record the capstone's notice acknowledgement; they do not claim legal certification or complete production compliance.

### Verification-document security

- Proofs MUST use private storage. Never expose a permanent public object URL.
- Only the owner and authorized admins may retrieve a short-lived signed URL.
- The current verification upload accepts JPEG, PNG and WebP base64 data URLs with a 5 MB estimated-byte limit and private storage handling; PDF is unsupported. `upload.controller.ts` validates the declared data-URL type, base64 shape and estimated size. It does not implement magic-byte/content-signature inspection or malware scanning. Treat deeper file inspection/scanning as a hardening gap, not an implemented guarantee.
- Never log document bytes, signed URLs, access tokens, or full ID numbers.
- Every admin view/download and every approval/rejection MUST be audit logged.
- Retention and deletion behavior MUST be stated in the privacy notice. The implementation records a 365-day deadline (refreshed at review), legal holds, and active-case retention checks. Permanent account deletion purges the relevant database records after blockers are resolved. **External proof-file deletion is a remaining operational gap:** a Cloudinary deletion helper exists, but the reviewed application has no caller or scheduled retention purge connecting it to account deletion. Do not claim automatic deletion of storage-provider files or complete retention enforcement. The current notice explicitly distinguishes database deletion from separately managed provider files. Non-document audit metadata must not contain document images, full ID numbers, or reusable signed URLs.

---

## PART 6 — THE TWO MARKETPLACE FLOWS (BOTH MUST EXIST, NEVER MERGE THEM)

### Flow A — Browse & Book (provider sets the price)

The seeker opens "Seek Services," chooses a search location/radius, combines search/category/quick filters, and views a matching published `ACTIVE` listing. Providers publish after content/eligibility checks; there is no listing approval queue. Current bookable types are fixed, hourly, daily and per-project. The booking modal uses accepted payment methods and requires the actual job location. Hourly/daily quantities and a one-time transportation fee produce a server-calculated total. Legacy starts-at/custom records require the owner to set a supported exact price before nearby discovery/direct booking; they do not introduce another hiring flow.

For Flow A cash, a `DirectRequest` records the provider-approval request and is linked to the `PENDING_APPROVAL` Booking created by the same logical workflow. `Booking` remains authoritative for lifecycle, messaging, cancellation, payment state, and completion. Flow A online originates directly from the active service listing and verified payment success; it does not require a DirectRequest.

- **Cash:** creates a `PENDING_APPROVAL` booking. The provider must accept or decline because the provider did not personally respond to this seeker beforehand.
- **Online:** the active listing is the provider's published commitment. After authoritative payment success, the booking becomes `ACCEPTED`; the provider does not approve it again, but work still does not start until the provider clicks **Start Job**.

### Flow B — Post Request & Receive Offers (seeker sets a budget)

**Request urgency and Offer availability are separate fields.** Request urgency describes how soon the seeker needs help. New public requests and urgency edits must use the controlled values `ASAP / Today`, `Needs Tomorrow`, `Next 1-2 Days`, `This Week`, or `Flexible Schedule`, selected through a dropdown and enforced by backend enum validation. Exact dates/times can be described in the request description. Existing free-text urgency values remain readable and may be retained when unrelated details are edited; they are not new selectable options. Provider Offer availability describes when that provider can work. Preserve it in the saved Offer, API responses, Incoming Offers, provider offer details, and the resulting Booking details; never replace it with Request urgency.

Activity must derive its outcome from the authoritative Booking or Offer state. Being terminal or appearing in History does not imply completion. A `CANCELED` Booking must say Canceled throughout its card, badge, situation, history, and workroom, with neutral gray status styling. `DECLINED`, `REMOVED`, withdrawn Offers and offers not selected retain their distinct outcomes. Only genuinely `COMPLETED` Bookings may use successful-completion presentation or a linked CompletedService; a stale completion record must not override another Booking state.

After the existing backend gates and the local content checks below pass, a public Post Request becomes `OPEN` and is visible to eligible providers. A provider submits one offer containing price, expected duration, availability, and message. For public requests, `service_id` is optional: an active, category-compatible listing may prefill the offer form, but the provider may submit and customize an offer with zero listings. The accepted offer's price and duration are snapshotted for the booking. An optional listing link is not an acceptance or queue dependency; both On-site Cash and GCash Test Mode are available for public-request offers.

The provider's offer is their commitment:

- **Cash selection:** in one transaction, selected offer → `ACCEPTED`, sibling pending offers → `REJECTED`, request → `IN_PROGRESS`, and Booking → `ACCEPTED`. There is no second provider acceptance.
- **Online selection:** selected offer → `PENDING_PAYMENT`, request → `PAYMENT_PENDING`, and an expiring payment attempt is created. Sibling offers remain unchanged until payment succeeds. On authoritative payment success, one transaction changes selected offer → `ACCEPTED`, sibling pending offers → `REJECTED`, request → `IN_PROGRESS`, and creates the paid Booking. On payment failure, cancellation, or expiry, the selected offer returns to `PENDING` and the request returns to `OPEN`; no Booking or Queue row is created.

When sibling offers become `REJECTED`, create one durable, idempotent notification per losing offer in the same committed transaction, then emit realtime updates. Cash selection does this immediately on the committed booking; online selection does it only after verified payment success. Failed, expired, or abandoned payment attempts do not notify losing providers.

The payment-pending hold SHOULD expire after 15 minutes. Only one offer on a request may be `PENDING_PAYMENT` or `ACCEPTED` at a time; enforce this transactionally.

### Flow B request terminal behavior

- Payment failure/abandonment before a Booking exists: selected offer returns to `PENDING`, request returns to `OPEN`, and sibling offers remain `PENDING`.
- Booking creation from the selected offer: request becomes `IN_PROGRESS`; selected offer remains `ACCEPTED`; siblings become `REJECTED`.
- Linked Booking completion: request becomes `CLOSED` in the same idempotent completion workflow.
- Linked Booking cancellation after matching: request becomes `CANCELED`. Previously rejected sibling offers are never resurrected because their price and availability commitments may be stale. The seeker may create a new request, optionally referencing the canceled request for UI convenience.
- A ServiceRequest may have at most one nonterminal Booking. Request, offer, payment, and booking transitions must be locked and committed atomically where they change together.

### Local content checks for Seeker Post Requests

- Posting remains a single submit action; there is no mandatory Gemini call or separate client-side "approved" step. Authentication, marketplace permissions, verified email/residency, active Admin-managed category, Zod field and budget validation, and abuse/duplicate controls remain authoritative backend gates. A category ID supplied by the client never defines or approves a new category.
- Before creating an `OPEN` request or broadcasting it, the backend applies the shared, versioned ServiceHub local content policy to the submitted title and description. Its narrowly scoped profanity and prohibited-service rules may require revision or reject clearly disallowed content. A failed check creates no public request, offer, booking, payment, or queue row. Return a safe, understandable reason and let the seeker revise; never return the complete rule list or evasion patterns.
- The same checks run before any edit to a published request's moderation-sensitive fields, including title, description, and category if category editing is later supported. An edit must not mutate public text first and check afterward. Existing matched/payment-pending request restrictions remain intact. A local check failure leaves the previously published content and status unchanged. Pause/reopen and retry paths must not bypass the checks.
- An ambiguous match is not proof of a violation. Prefer a narrowly tuned rule that passes uncertain text for later reporting/Admin review over a broad automatic rejection; do not claim the local filter detects semantic category mismatch or every prohibited service. Admin must retain a path to inspect and remove reported public requests and review contested check failures, independent of booking-scoped reports.

### Naming rules

- The seeker-side tab is **"Incoming Offers."**
- Use **offer**, **submit offer**, and **offer-based matching**. Never call Flow B bidding or an auction.
- Keep both flows in separate workspace tabs because they represent different user intent.

---

## PART 7 — PAYMENT METHODS AND THE PAYMENT GATE

Supported capstone methods are:

| Payment type | PayMongo? | FCFS Queue? | Settlement behavior |
|---|---:|---:|---|
| GCash (online, Test Mode) | Yes | Yes | `PAID_HELD` after verified success, then `RELEASED`, `FROZEN_HELD`, or `REFUNDED` |
| Onsite Cash | No | Never | `UNPAID` until seeker confirms completion, then `CASH_CONFIRMED`; no platform wallet credit |

These are the only accepted payment methods. Do not add or imply other online or offline payment options in product flows, checkout, or provider listings.

The provider-wide FCFS queue is reserved for successfully paid online bookings. Cash never enters Queue or receives a numbered paid position. Every Booking is one independent engagement; a Service listing remains reusable and is optional for offer-based work.

### Price-type eligibility and exact amount

- `FIXED` and `PER_PROJECT` use the exact listing price for direct cash or online booking. `PER_HOUR` and `PER_DAY` multiply the listed rate by a seeker-selected whole number of hours or days; the server calculates and snapshots the exact total into `Booking.agreedAmount` or `PaymentAttempt.amount`.
- New/edited listings support `FIXED`, `PER_HOUR`, `PER_DAY`, and `PER_PROJECT`. Legacy `STARTS_AT`/`CUSTOM` records require revision to a supported exact price and are excluded from bookable nearby discovery until corrected. Existing historical listing-linked inquiries retain their stored participant/payment restrictions; do not advertise a new quote-based Flow A.
- Bookable listings use their accepted payment methods. No charge is authorized for an unavailable or non-exact legacy price.
- `Booking.agreedAmount` is an immutable Decimal/integer-centavo snapshot after creation. Refund, release, transaction history, admin case files, and CompletedService use this snapshot—not the current listing price and never a client-submitted amount.

### Online payment invariants

1. The server calculates the price from the service or accepted offer. Never trust a client amount.
2. Payment initiation stores a `PaymentAttempt` bound to seeker, provider, optional service, optional offer, amount, currency, method, and an idempotency key. Direct listing checkout has a service; a listing-free accepted offer does not.
3. Only a server-to-server PayMongo verification or authenticated webhook may declare success. Browser redirects are informational, never authoritative.
4. Signature verification MUST use the raw webhook body. Processing MUST be idempotent by PayMongo event/payment identifier.
5. The payment confirmation must exactly match the stored seeker, optional service, optional offer, amount, currency, and method.
6. Only after verified success may the system create a `PAID_HELD` Booking and its Queue row.
7. Work MUST NOT start automatically after payment. `started` remains false until the provider clicks Start Job.
8. If payment fails or is abandoned, no Booking or Queue row is created. The durable PaymentAttempt records the failure without exposing sensitive provider data.
9. Provider waiting capacity is checked before payment and rechecked under the provider queue lock during success handling. If a captured payment cannot safely become a booking, persist it as `REFUND_REQUIRED` and start an idempotent refund/reconciliation path; never lose the payment or silently exceed the configured capacity.
10. A provider's profile phone number is contact information, not a PayMongo payout destination. Tier 0 creates an internal provider earning after completion and does not transfer money to a personal GCash number, bank account, or wallet.

### Cash invariants

- Cash creates no PayMongo intent, Queue row, held funds, refund record, or online-wallet credit.
- The platform may create a non-wallet cash earning/history entry only after seeker confirmation; it must be labeled as externally settled cash.
- Flow A cash requires provider acceptance. Flow B cash does not, because the selected offer was already the provider's commitment.
- Cash arrangements remain visible in the provider workload but never consume a numbered paid waiting place. A provider may not start a cash job while paid jobs are waiting; the one-ongoing-job guard applies across payment methods. A cash job already underway can finish before the next paid job starts.
- A Flow A cash request MAY include a plain-language preferred schedule. It is a proposal only: it does not reserve time, claim calendar availability, or become authoritative until the provider accepts and the parties coordinate through booking-scoped messaging.
- A provider who is unavailable SHOULD pause the listing. Offline delivery uses durable database notifications; Socket.IO is only a realtime convenience.

---

## PART 8 — FCFS QUEUE LOGIC

Each Provider account represents one worker and has one online-paid waiting queue with a provider-level capacity of 1–10 waiting jobs. Flow A listings and Flow B offers enter the same order after verified GCash success. A service listing supplies normal/default price and duration, not another work queue.

**Canonical fairness rule:** paid waiting order is FCFS across the provider's actual workload, independent of which listing or seeker request originated each booking.

- When no job is ongoing, the provider may start only the first eligible paid waiting job. They cannot skip it to start another paid job or a new cash arrangement.
- Queue positions are comparable across the same provider's paid jobs. A cash job that was already underway remains outside the numbered queue but contributes to approximate wait until it ends.
- User-facing queue help MUST say: **“Your position is in this provider's paid work queue. The provider can perform only one service at a time.”**

### Provider-wide concurrency (Tier 0)

- A provider may have at most one `ONGOING` Booking across all service listings.
- Start Job MUST acquire a provider-scoped database/advisory lock as well as the provider queue lock, then recheck for another `ONGOING` Booking before changing any state.
- Prefer a database-level partial unique index that permits only one `ONGOING` Booking per provider as a final race-condition backstop; the transactional check remains required for a clear domain error.
- If another ongoing job exists, return `409 PROVIDER_ALREADY_SERVING` and leave Booking/Queue unchanged.
- For paid queued work, Start Job must verify that the target is the eligible first waiting row of the provider's paid queue. For cash work, reject Start Job while paid jobs wait.
- The UI must show the provider's current active job and disable other Start Job actions while it is ongoing. Frontend disabling is advisory; the transaction is authoritative.

### Authoritative queue model

- Queue is the sole authoritative source of position. `Booking.queuePosition`, if retained for legacy compatibility, is a transactionally synchronized mirror and MUST NOT be independently edited or used as the locking authority.
- At most one row per provider may be `SERVING`. The next eligible `WAITING` row has the lowest provider-wide position.
- When no row is serving, the first waiting row is position 1. When a row is serving at position 1, waiting rows begin at position 2.
- `estimatedWait` sums the snapshotted durations of active jobs actually ahead, including a cash job already in progress when applicable. It is explicitly approximate, not a guaranteed appointment time.
- Provider capacity counts `WAITING` paid rows. The currently `SERVING` job and historical `DONE`, `CANCELLED`, and `REMOVED` rows do not consume waiting places. Lowering capacity below existing occupancy blocks new admissions without ejecting already-paid jobs.
- All join, start, cancel, complete, remove, and reindex operations MUST run server-side in a database transaction protected by a provider-scoped queue lock. Positions must remain positive, contiguous, and unique among active rows.

### Queue transitions

| Event | Booking | Queue |
|---|---|---|
| Verified online payment succeeds | `ACCEPTED`, `started=false` | create `WAITING` at next position |
| Provider starts eligible first row | `ONGOING`, `started=true` | same row becomes `SERVING`, position 1 |
| Provider marks work completed | `AWAITING_CONFIRMATION` | same row becomes `DONE`; recalculate waiting rows |
| Cancellation before start | `CANCELED` | `CANCELLED`; recalculate waiting rows |
| Admin removal | `REMOVED` or the admin decision's terminal status | `REMOVED`; recalculate waiting rows |

The retained historical Queue row preserves payment/refund traceability. Starting a job does not delete it.

### Notify Me When Open

When active queue size reaches the limit, disable online booking and offer **Notify Me When Open**. `QueueNotify` is not a reservation and contains no Booking or payment. When capacity opens, notify the oldest waiter and remove that notification request only after delivery is durably recorded. The user must still complete the normal payment flow, and another user may take the slot first.

---

## PART 9 — CANCELLATION POLICY

`Booking.started` defaults to false and may change to true only in the provider Start Job transaction. Once true, it remains true for audit purposes even if the booking later becomes completed, canceled, or disputed.

### Before start

- Either participant may cancel eligible not-started work through the cancellation endpoint with a required reason. Separately, a provider may accept or decline a pending Flow A cash request through the direct-response endpoint; that endpoint accepts an `accept` boolean and does not require a decline reason. Do not combine these two contracts in the SRS or STD.
- Online `PAID_HELD` work receives an idempotent full refund; cash has no platform refund.
- Any active Queue row becomes `CANCELLED`, positions are recalculated, and the waitlist notification rule runs.
- A provider cannot silently delete a paid booking or remove it without the cancellation/refund workflow.

### After start

- Neither party may directly cancel the Booking.
- Either seeker or provider may submit one active `CancellationRequest` with a required reason.
- The other party may approve with an optional note; declining requires a responder note of at least three characters under the current API schema.
- Approval cancels the booking. Online payment is fully refunded; cash requires the parties to settle externally and the platform records no PayMongo refund.
- A decline may be escalated to Admin. Admin either approves cancellation/refund or rejects it and returns the Booking to `ONGOING`.
- Trust penalties apply only to the party explicitly found at fault by an admin or an unambiguous policy rule; never penalize both parties merely because a cancellation occurred.
- When approving an escalated cancellation of started work, Admin explicitly chooses no fault, seeker at fault, or provider at fault, with a required explanation. A supported fault finding deducts 5 from only that participant once. Mutual approval, denial, and pre-start cancellation do not deduct trust. Retries retain the same fault finding and cannot deduct again.
- Every resolution is transactional, idempotent, notified to both parties, and audit logged when an admin acts.

### Data model
`CancellationRequest` (id, bookingId, requestedBy, responderId, reason, status: PENDING/APPROVED/DECLINED/ESCALATED/RESOLVED, responderNote, adminId, adminNote, createdAt, resolvedAt). Only the other booking participant may respond; the requester cannot approve their own request.

### UI requirement
At booking confirmation and Start Job, show this short disclaimer:
> "Either party may cancel before work starts. After Start Job, cancellation must be requested and reviewed by the other party or Admin."

---

## PART 10 — PAYMENT HOLD, JOB COMPLETION, DISPUTES, AND REFUNDS

### Online hold-and-release — money direction is critical

```
PayMongo Test Mode confirms payment → Booking.paymentStatus = PAID_HELD
  ↓
Provider performs the work → clicks "Mark Completed"
  ↓
Booking.status = AWAITING_CONFIRMATION (seeker MUST act — never auto-approve)
  ↓
Seeker chooses ONE path:

  PATH A — Confirm & Release:
    → The simulated hold releases to the PROVIDER's application ledger
      (Available Balance increases in the test ledger)
    → In the normal user path, this is the moment CompletedService is created.
      The only other allowed creation path is an admin decision of
      RELEASE_PROVIDER_AND_COMPLETE from a dispute or CompletionEscalation.
      Never create it earlier.
    → Create the provider's `+3` completed-service TrustScoreEvent defined
      in Part 15, exactly once per CompletedService
    → Booking.status = COMPLETED
    → Seeker prompted to leave a review

  PATH B — Report Issue:
    → Booking.status = DISPUTED
    → Booking.paymentStatus = FROZEN_HELD (neither released nor refunded)
    → Seeker fills a Report form: reason (dropdown), description, optional
      evidence upload
    → Proceeds to Admin Dispute Resolution (Part 12)
```

For onsite cash, the lifecycle is the same from Start Job through confirmation, but no funds are held or released by the platform. Confirmation sets `paymentStatus = CASH_CONFIRMED` and may add a clearly labeled cash-history entry; it MUST NOT increase the provider's online Available Balance.

**Critical money-direction rule:** the seeker's application wallet is never credited during normal confirmation. For online work, only the provider's test ledger increases. A seeker receives value back only through an approved refund.

### No-response completion escalation

Completion is never auto-confirmed and funds are never auto-released.

- If the Booking remains `AWAITING_CONFIRMATION` for 72 hours after Mark Completed, the provider may create one active `CompletionEscalation`. The server—not a client clock—enforces eligibility.
- Creating an escalation while one is active returns the existing escalation instead of creating a duplicate.
- After Admin resolves an escalation with `KEEP_AWAITING`, another escalation is allowed only after an additional 72 hours measured by the server from the previous escalation's `resolved_at`.
- Creating the escalation does not change Booking/payment state: online funds remain `PAID_HELD`, and the Booking remains `AWAITING_CONFIRMATION` until a seeker or admin action wins a booking-row lock.
- While Admin has not resolved it, the seeker may still confirm completion or file a completion dispute. That action atomically resolves/dismisses the pending escalation.
- Admin reviews booking-scoped messages/evidence and chooses exactly one outcome: `KEEP_AWAITING`, `REFUND_SEEKER`, or `RELEASE_PROVIDER_AND_COMPLETE`. The latter two reuse the idempotent settlement rules in Part 12.
- `REFUND_SEEKER` and `RELEASE_PROVIDER_AND_COMPLETE` are terminal for completion escalation and prevent another escalation. Escalation creation, dismissal, and settlement are idempotent.
- No-response alone never changes trust. A penalty requires a separately validated policy violation.
- Both participants are notified and every admin decision is audit logged.

`COMPLETION_ESCALATIONS` — id, booking_id, requested_by_provider_id, status (`PENDING|UNDER_REVIEW|RESOLVED|DISMISSED`), admin_id?, resolution?, admin_note?, created_at, resolved_at. Enforce at most one active escalation per Booking; `resolved_at` is the authoritative cooldown anchor after `KEEP_AWAITING`.

---

### Provider Payment Records

The Provider workspace Payment Records page tracks previous provider bookings and all-time recorded earnings; it is not an available balance, withdrawal or payout interface. `GET /api/transactions/provider-records` reads only the authenticated member's provider history. Confirmed `CASH_CONFIRMED` and `RELEASED` CompletedService snapshots count as recorded earnings, including retained legacy confirmations. Current Booking-linked completions must also have consistent completed/payment states. Seeker wallet refunds and cancelled/declined/unsettled amounts do not count. The page separates on-site cash from GCash Test Mode, marks refunded/cancelled records with zero earnings, links current bookings to Activity, and filters/paginates on the server. Lifetime totals stay independent of the selected recording date/status/page; dates use Asia/Manila. Loading, retry and refresh preserve honest known data. This read-only projection does not modify settlement or wallet behavior.

## PART 11 — MESSAGING UNLOCK

- A chat thread unlocks only when a Booking reaches `ACCEPTED`, `ONGOING`, `AWAITING_CONFIRMATION`, or `DISPUTED`. A queued online booking remains `ACCEPTED`; Queue status represents waiting/serving position.
- Before that point, no thread should be creatable or visible — there's nothing to message about yet.
- Every message is stored with a `booking_id` foreign key — this is required both for the unlock rule and for dispute evidence retrieval (Part 12), so admin can pull the exact conversation tied to one specific transaction, not a tangle of every message two users have ever exchanged.
- Current messaging supports booking-scoped real-time text and read receipts, with lifecycle notifications/events for payment and work progress. Text is trimmed and limited to 2,000 characters. Image/attachment payloads are rejected by the current API; do not document file/image sharing as implemented. Terminal conversations remain readable but do not accept new messages under the current lifecycle guards.

### Realtime and notification delivery rules

- REST/database state is authoritative; Socket.IO events are invalidation hints, not the only copy of an action.
- Authenticate the socket during connection with the same active-account checks as HTTP. Join only rooms the user is authorized to access (`user:{id}` and participant/admin-authorized `booking:{id}` rooms).
- Never accept a client-supplied user ID as socket identity. Never broadcast booking data to a service/user room without server-side membership checks.
- Every persistent action commits to the database before its event is emitted. On reconnect, clients refetch canonical state so missed events do not cause drift.
- Event handlers must be idempotent or deduplicated by stable entity/event ID. The client should use one socket instance and clean up listeners on unmount to prevent duplicated requests and lag.
- Important notifications are stored in `Notification` before emission. If realtime delivery fails, the notification remains available through the REST inbox.
- If message attachments are introduced in a separately authorized future change, they must follow private-storage, type, size, randomized-name and participant-authorization rules. Existing historical attachment fields do not establish a supported upload feature.

---

## PART 12 — REPORTS AND ADMIN DISPUTE RESOLUTION

- A report can only be filed by a participant against the other participant of an existing Booking. Completion disputes may be filed only from `AWAITING_CONFIRMATION`; other safety reports may be filed from an allowed active/terminal status but MUST NOT automatically freeze money unless an online payment is still held.
- A Booking may have at most one unresolved completion dispute. Repeating the same completion-dispute request returns the existing Report instead of creating another. The transition from `AWAITING_CONFIRMATION` to `DISPUTED` and Report creation MUST occur under the same booking-row lock.
- Once a Booking is `DISPUTED`, another completion-dispute submission is rejected with a stable conflict response or returns the current case. A database uniqueness rule where practical, plus a transactional application invariant, MUST prevent duplicate unresolved completion disputes.
- Genuinely different safety incidents may be reported separately even while a completion dispute exists. Rate-limit report creation and deduplicate repeated identical safety reports from the same reporter for the same Booking without suppressing a distinct safety concern.
- Report form: reason (dropdown: Poor Service Quality / Incomplete Service / Scam or Fraud / Inappropriate Behavior / Overpricing / No-show), description (required), evidence (optional photo/screenshot).
- Admin has a booking-scoped case workspace containing the following information. Detail, message, evidence and financial data use their authorized endpoints and pagination; do not describe the entire workspace as one unbounded Prisma query:
  - Reporter's name, trust score, verification status
  - Reported user's name, trust score, verification status
  - The linked booking: service, dates, amount, payment status
  - The chat history between the two parties **scoped to this specific booking_id only**, loaded through paginated access
  - The report's reason, description, evidence
- `Booking`, not `CompletedService`, is the case-file anchor. A CompletedService may be included only if one already exists.
- A completion dispute changes Booking → `DISPUTED`, online payment → `FROZEN_HELD`, and Report → `PENDING`. Admin opening the case changes Report → `UNDER_REVIEW`; Booking remains `DISPUTED`.
- For a completion dispute that changed the Booking to `DISPUTED`, Admin must choose exactly one booking-resolution outcome:
  - `DISMISS_AND_RESTORE` → Report `DISMISSED`; Booking returns to its recorded `statusBeforeDispute` (normally `AWAITING_CONFIRMATION`); online payment returns to `PAID_HELD`.
  - `REFUND_SEEKER` → online payment `REFUNDED`, Booking `CANCELED`, no CompletedService; cash creates no platform refund.
  - `RELEASE_PROVIDER_AND_COMPLETE` → online payment `RELEASED` or cash `CASH_CONFIRMED`, Booking `COMPLETED`, and CompletedService is created exactly once.
- Warn, trust adjustment, posting suspension, account suspension, and ban are separate moderation consequences. They do not substitute for one of the required booking-resolution outcomes.
- A safety report filed outside the completion-confirmation path is resolved or dismissed as a moderation case. It does not reopen an already settled payment or rewrite a terminal Booking unless a separately authorized refund/dispute process is created.
- Every admin decision requires a reason and an immutable AdminAuditLog entry. Refund/release actions must be idempotent.
- `CompletionEscalation` reuses the same `REFUND_SEEKER` and `RELEASE_PROVIDER_AND_COMPLETE` settlement operations but is not a Report and does not imply wrongdoing. `KEEP_AWAITING` resolves only the escalation and leaves the Booking/payment unchanged.
- Both parties notified of the final outcome.
- The same admin queue should also handle escalated `CancellationRequest`s (Part 9) — one moderation inbox, not two separate hidden ones.

---

## PART 13 — THE `BOOKING` VS `COMPLETEDSERVICE` STRUCTURAL RULE (DO NOT VIOLATE)

This is a deliberate architectural decision, fixed after an earlier version of this system incorrectly conflated these two concepts.

```
Booking = represents an engagement from the moment of acceptance/payment
          through to its resolution. Statuses: PENDING_APPROVAL, ACCEPTED,
          ONGOING, AWAITING_CONFIRMATION, DISPUTED, COMPLETED, DECLINED,
          CANCELED, REMOVED. Waiting is a Queue status, not Booking status.

CompletedService = represents a GENUINELY FINISHED job. It is the anchor
          for completion history and reviews. It is created exactly once
          when the seeker confirms completion OR when an admin resolves a
          dispute/CompletionEscalation with RELEASE_PROVIDER_AND_COMPLETE. It is never created
          by accepting a booking, paying, joining a queue, or unlocking chat.
```

- Chat unlock (Part 11), queue display (Part 8), and the Activity tab's "in progress" section all read from `Booking`, never from `CompletedService`.
- `CompletedService` appears in Activity history, reviews, aggregates, and completed-job details. Admin may include it in a case file only when it already exists.
- Creating CompletedService, setting the terminal Booking/payment state, writing ledger/trust events, closing a linked ServiceRequest, and completing any Queue row MUST be one idempotent transaction or a safely retryable workflow with unique constraints preventing duplicates.

---

## PART 14 — REVIEWS AND RATINGS

- Triggered when a Booking reaches `COMPLETED` and a CompletedService record exists, whether completed by seeker confirmation, dispute resolution, or CompletionEscalation resolution.
- Both participants may leave one review of the other participant for that CompletedService. This supports the shared-account trust model; a user may be reviewed as a provider or seeker depending on the completed job.
- Rating is 1–5 stars; written review and allowed tags are optional. Enforce one review per `(completed_service_id, author_id)` and derive the target from the CompletedService participants — never trust a client-supplied target ID.
- Reviews attach permanently to CompletedService and may be edited by their author for exactly 24 hours. Editing must adjust the earlier review trust event by the net difference, not add a second full rating event. Reviews are not hard-deleted through normal UI; moderation hides abusive content with an audit trail.
- Provider aggregates, AI provider summaries, Seek Services ranking, and the Community Hub leaderboard use only reviews from CompletedServices where that target participated as the provider. Reviews received while acting as seeker remain visible on the user's profile/trust history but do not affect provider-service ranking.

---

## PART 15 — TRUST SCORE SYSTEM

- Range 0–100, default 50. Bands: 90–100 Highly Trusted, 70–89 Trusted, 50–69 Average, below 50 Needs Attention.
- All score changes MUST pass through one transactional trust service that row-locks the user, clamps 0–100, and creates an immutable `TrustScoreEvent`. Each business event needs a unique idempotency key so retries cannot change trust twice.
- The private, implementation-authoritative event table is:

| Event | Target | Delta |
|---|---|---:|
| Account baseline | new user | starts at 50 |
| First verification approval | verified user | +5 once |
| Service completed and confirmed | provider | +3 once per CompletedService |
| 5-star review | review target | +2 |
| 4-star review | review target | +1 |
| 3-star review | review target | 0 |
| 2-star review | review target | -3 |
| 1-star review | review target | -5 |
| Started booking canceled, user found at fault | at-fault user | -5 |
| Report validated by admin with trust deduction selected | reported user | -10 once per report |

- Listing checks that require revision and repeated failed publication attempts do not change trust. The old second-listing-rejection penalty is retired with listing pre-approval. A supported public-content report may receive the separately documented warning, suspension, or ban; it does not automatically apply a trust deduction.
- Review edits and hiding reconcile the review's actual recorded contribution, including clamped events. Never reverse theoretical points that were not applied at a 0/100 boundary. Restoring a review reapplies its eligible rating contribution under the same boundary and retry rules.

- The completed-service `+3` event uses the existing unique `booking-completion:<bookingId>:provider` key for the Booking linked one-to-one to its CompletedService and is created exactly once. Seeker-confirmed cash/online completion and Admin `RELEASE_PROVIDER_AND_COMPLETE` use the same event; retries cannot award it twice. Refund and cancellation outcomes never create it.
- Do not add a separate “successful payment” bonus; completion already represents the successful undisputed transaction and a second bonus would double count it.
- No-show penalties require an admin-confirmed report; do not infer a no-show from elapsed time alone.
- Always visible: provider cards, offer cards, profile pages, admin views.
- Admin can manually adjust trust only with a required reason, re-authenticated admin authority, clamping, TrustScoreEvent, and AdminAuditLog entry.
- **Do not publish the exact point-value formula to end users.** Instead, build a "How Trust Score Works" guide (Settings page + landing page FAQ) that explains the *principles* (what helps, what hurts) without exact numbers — publishing exact math invites gaming the score rather than genuinely earning it.

---

## PART 16 — SELF-TRANSACTION PREVENTION (ANTI-ABUSE — MUST BE ENFORCED SERVER-SIDE)

**Hard rule:** a booking, offer, or direct request can never be created where the seeker and provider resolve to the same underlying user account (since one account can hold both roles).

```typescript
// Apply this check at EVERY entry point that creates a transaction
const createBooking = async (seekerId, providerId, serviceId) => {
  if (seekerId === providerId) {
    throw new Error("SELF_TRANSACTION_NOT_ALLOWED");
  }
  // ... proceed
};
```

Apply this check to: direct bookings (Flow A), sending an offer (Flow B, provider side), accepting an offer (Flow B, seeker side — verify the offer's provider_id doesn't match the accepting seeker's own id as a second-layer check).

**Optional UI layer:** exclude a user's own listings/requests from their own browse results entirely.

**Documented but not required to build:** admin-side pattern flagging for suspected two-account collusion (unusually frequent mutual transactions between the same two accounts, near-zero payment amounts, near-instant repetitive reviews) — describe this as a known limitation and future safeguard in system documentation, does not need actual implementation for the capstone.

---

## PART 17 — SERVICE LISTINGS (PROVIDER SIDE) — CREATION, VALIDATION, MODERATION

### Fields
Category (admin-managed list), title, description, exact price/rate, supported price type, normal estimated duration, operating base/area label, optional coverage radius/transportation fee, and accepted methods (GCash and On-site Cash — at least one). Provider paid waiting capacity (1–10) is configured once in Provider Activity across listings/offers; the legacy `Service.queueLimit` is not operational. GCash is the only online Test Mode method.

### Reusable one-time booking model (Version 2.3)

Every new or edited listing uses `serviceType=ONE_TIME`. The listing itself is reusable; `ONE_TIME` describes each Booking, not the lifetime of the listing. Plumbing, cleaning, tutoring, coaching, and similar services all use the same model.

- Each request creates a new independent Booking with its own acceptance/payment, messaging, cancellation, completion, dispute, and review lifecycle.
- A seeker may request the same listing/provider again after that seeker's previous Booking for the listing becomes terminal (`COMPLETED`, `DECLINED`, `CANCELED`, or `REMOVED`).
- A seeker may not create a duplicate request while a nonterminal Booking for that listing already exists.
- Flow A cash requires provider acceptance. The provider may decline when busy or offline and may pause the listing to stop new requests.
- A preferred schedule is free-text coordination only; ServiceHub does not claim calendar reservation or external provider availability.
- `SESSION_BASED` and `PER_SESSION` remain database enum values only for safe historical migration. They MUST NOT be selectable or advertised. Existing records migrate to `ONE_TIME` and `FIXED` respectively.

### Pricing Unit (added August 2026)
Every service listing has a `priceType` field that controls how the price is displayed to seekers:
- `FIXED` (default) — fixed price, no unit label displayed
- `PER_HOUR` — "₱X / hour"
- `PER_DAY` — "₱X / day"
- `PER_PROJECT` — "₱X / project"

Existing listings without an explicit `priceType` default to `FIXED` and are fully backward-compatible.

Display units do not by themselves authorize direct payment. Fixed/project prices are exact; hourly/day prices require a selected quantity and server-calculated total. `STARTS_AT` and `CUSTOM` are retained database enum values for historical compatibility, not supported new/edited listing choices.

### Validation (both frontend instant feedback AND backend Zod re-validation — never trust client input alone)
```
Title:              required, 10–100 characters, no symbols outside basic punctuation
Description:         required, 30–1000 characters
Price:               required numeric ₱50–₱50,000
Operating location:  required validated pin and area label for a new listing
Coverage radius:     optional, 1–30 km when supplied
Transportation fee:  optional, ₱0–₱5,000, at most two decimal places
Provider waiting capacity: integer 1–10, configured in Provider Activity, not per listing
Estimated duration:   required, 15 minutes–8 hours
Payment methods:      at least one required
Preferred schedule:   optional free text on Flow A cash requests; never a reservation
```

The legacy `queueLimit` input still defaults to 3 for compatibility, but does not control operational capacity. Request validation differs from listing validation: title 3–100 characters, description 10–2,000, budget endpoints ₱50–₱50,000 with minimum ≤ maximum, controlled urgency, and at least one payment method. Offers use ₱50–₱50,000, an integer duration of 15–480 minutes, optional availability up to 500 characters and optional message up to 2,000. Flow A quantity is an integer 1–40, with supported-unit totals computed by the server. Review stars are integers 1–5, text is at most 2,000 characters, and up to ten tags of at most 50 characters are accepted. Derive any additional exact bounds from `src/schema`, not from unrelated form labels.

### Duplicate and volume limits
- No two active listings (`ACTIVE`; indexes may retain legacy `PENDING_REVIEW` compatibility) from the same provider may have the same trimmed, case-folded title. Enforce this transactionally and preferably with a PostgreSQL partial unique index on `(provider_id, LOWER(title))` for those statuses. A normal `(provider_id, title)` constraint is not sufficient because it is case-sensitive and also blocks safe title reuse after archival.
- **Standard volume limit:** Maximum **3 active listings** per provider at any time. This limits marketplace clutter/spam and does not multiply the provider's paid waiting capacity. To publish another service, pause or archive an existing listing.

### Provider-controlled publication and content checks

**Provider service listings never require Admin pre-approval.** After authentication, posting privilege, residency/email verification, active category, exact pricing, duplicate, and volume checks, the backend runs the shared local content policy. A pass publishes immediately as `ACTIVE` with `isAvailable: true` and a first-publication `published_at`. Failed content returns an actionable revision error without creating a listing.

The only publication outcomes are Published or Needs changes. Members must select a suitable active category; the local policy does not perform semantic category-mismatch detection. Recognized prohibited-service rules require revision. No new submission or edit enters `PENDING_REVIEW`, and Admin has no approve/reject listing endpoint. Admin may investigate reports and appeals, remove public content with a recorded reason, or restore content previously removed by Admin. Local check failures do not deduct trust points or suspend posting.

Local filtering does not prove category relevance, legality, or absence of abusive content. Do not advertise it as comprehensive moderation or rely on a profanity list alone. Maintain risk-based rules, provider-level submission limits, abuse monitoring, report handling, and review capacity appropriate to actual flag/report volumes; do not claim Admin workload savings without measurements. Gemini is not required in the publication path.

Failed local content checks require revision and do not automatically warn, deduct trust, or suspend the owner. Reports require a separate, supported Admin finding before any account consequence.

Edits rerun the applicable validation and local checks before committing. A failed edit preserves the last saved content and visibility. Passing edits remain live, while paused listings remain paused. The first-publication timestamp does not reset. Legacy unpublished records are shown as Needs changes and can be edited/saved by their provider to publish after validation. Existing Booking/Queue obligations remain intact. Price, unit, duration, payment methods, and pause/resume retain backend validation. Provider waiting capacity belongs in Activity, not individual listings.

### Shared local content-policy requirements

- Keep ServiceHub-owned prohibited-service rules centrally maintained, versioned, server-side, and covered by tests. Use precise whole terms, phrases, or context-dependent combinations rather than a blanket substring blacklist. A profanity library is optional and must be evaluated against local English, Cebuano, and Filipino wording, false positives, maintenance, TypeScript compatibility, and dependency risk before adoption; it is not itself the marketplace policy.
- Apply bounded normalization for case, whitespace, punctuation separation, control/zero-width characters, and carefully selected character substitutions. Preserve the original submitted text for display and authorized review. Do not over-normalize ordinary names, trade terms, or non-English text, and do not claim complete resistance to obfuscation or semantic evasion.
- Local checks are synchronous and do not depend on Gemini or another external moderation service. If the policy engine cannot run, do not silently mark unchecked content as passed; return a safe retryable error or hold it for authorized review without publishing. Limit repeated submissions, avoid duplicate records, and record a minimal policy version/outcome/reason-code audit without exposing the full rule set or unnecessary personal text in logs.
- One failed content check is not an account offense. Only authorized Admins can decide contested cases, remove reported public content, and impose trust or account sanctions under the existing audit and moderation rules. Public-content reports and submission appeals must be available without misusing booking-scoped financial/safety dispute records.

---

## PART 18 — CATEGORY MANAGEMENT

- Administrators create, rename, activate, and deactivate marketplace categories through Admin → Categories. The database catalog is the single source for Seeker search, Provider listings, and service requests; users choose existing active categories.
- Admin creation and changes require a recorded reason and audit entry. Duplicate names are rejected after case-insensitive normalization. Categories cannot be deactivated while non-deleted listings or open/in-progress requests depend on them; historical records retain their category relation.
- New active categories appear in Community Hub using the real Admin creation timestamp from the audit log, within the recent-content window. Renaming or reactivating an old category does not make it a new addition.
- Expand the catalog directly through Admin category management as new service types are needed. Both marketplace hiring flows remain intact.

### Default catalog and safe fallback

The default broad service families are:

- Aircon Service
- Appliance Repair
- Automotive Services
- Beauty & Personal Care
- Carpentry & Woodwork
- Cleaning Services
- Computer / IT Services
- Delivery & Moving
- Electrical Repair
- Event Services
- Handyman Services
- Home Improvement
- Lawn & Garden
- Painting Services
- Pest Control
- Pet Services
- Photography / Videography
- Plumbing
- Repair & Maintenance
- Tutoring & Education
- Other Services

The existing `Category` table remains the single source of truth for both workspaces. Default seeding adds only missing names after case/whitespace normalization. It MUST retain existing IDs, names, references and Admin activation decisions. Legacy categories such as House Cleaning, Lawn Care and Tutoring remain available according to their current active status; they are not silently merged or renamed. Existing listing/request foreign keys MUST NOT be rewritten by catalog expansion.

**Other Services** is the official system fallback and MUST remain active. Admin mutation endpoints reject renaming or deactivating it; there is no category deletion endpoint. Seeding restores this fallback if a legacy database has it inactive. Normal categories retain existing Admin management and dependency guards. Members MUST NOT create arbitrary categories, and there are no AI category suggestions or member category-submission flows.

Post Request and Provider service creation both display **Other Services** as the last category in the dropdown, using its official database ID. Helper text explains that members should choose it when no named category fits and describe the specific work in the title/description. Both forms retain the existing title, description, budget/pricing, location and other required inputs. Broad categories describe service families; specific work belongs in title and description, for example Computer / IT Services → Laptop motherboard repair, or Other Services → Repair aquarium pump. The fallback does not bypass verification, publication validation or content policy.

Seeker Seek Services and Provider Browse Service Requests obtain category filters dynamically from the active Admin catalog. Keep **All Categories** first and put **Other Services** last in the horizontal badge row, after every named category. **All Categories** includes Other Services records; **Other Services** restricts results to that category. Title/description/category text search remains available and combines with category, search location, radius and existing quick filters. Searching `aquarium` can find an Other Services aquarium request or listing. The row's scrollbar is 6px thick in browsers supporting custom scrollbar sizing, with a native thin fallback elsewhere. Its thumb shares the sidebar active-button navigation token: Seeker orange / Provider green. Darken the thumb only slightly (6% black) while the user hovers over or drags it; return to the sidebar color afterward. Both discovery pages show the total filtered result count beside the location summary: Services Available for Seek Services and Service Requests Available for Browse Service Requests, including zero after a successful load; do not show an availability count while loading or when the initial request fails. Existing proximity calculations, Provider coverage and the two hiring flows MUST remain unchanged.

Expanded dropdowns use the existing scrollable, keyboard-accessible menu. Marketplace category chips stay in one horizontal row with a scrollbar below them; every category remains reachable by horizontal scrolling or keyboard focus, while vertical scrolling continues to move the page. Admin catalog pagination remains in place. Category expansion requires additive data seeding only, without a new table, schema migration, database reset or unrelated business-logic changes. Development operations MUST validate the selected development database target before writing.

---

## PART 19 — COMMUNITY HUB (ADMIN/SYSTEM CONTENT ONLY — NO USER-GENERATED FEED)

Deliberately scoped out: no user photo posts, no public scrollable social feed, no likes/comments system — this avoids moderation overhead unrelated to the core marketplace purpose.

- **Announcements** — admin-posted only.
- **Platform guides** — short, undated explanations of current ServiceHub capabilities and rules. They are informational content, not fabricated historical events.
- **Top Providers leaderboard** — computed when the stats endpoint is requested, for the current Monday-to-Monday week in Philippine time (UTC+8), rather than by a scheduled weekly job. Eligible public providers must have at least one completion in that week. Rank by trust score, weekly completion count, then visible-review rating; return at most eight. There is no manual curation.
- **Community Stats** — actual response keys are `totalCompleted`, `verifiedUsers`, `activeProviders`, and `activeListings`. These represent all-time completions and current eligible-account/listing counts. There is no implemented “active seeker” counter. A member can participate in both workspaces; these are not exclusive persisted user roles.
- **Newly Added Categories** — shows up to six recent active categories, using real `CATEGORY_CREATED` audit events; `Category` itself has no creation timestamp. The recency window is 30 days.
- **Recently Added Services** — currently public listings ordered by the first-publication `published_at` timestamp, after providers publish them directly. Availability changes or ordinary edits must not make an old listing appear newly published.
- “Recently added” content uses a defined recency window and displays only real database timestamps. An API failure must render an error state, never fabricated zero statistics or false empty-state content.
- The endpoint returns up to six public service additions within 30 days and up to three published announcements. See `src/controllers/community.controller.ts` for the exact eligibility and aggregation rules.

---

## PART 20 — ADMIN PANEL

- **Overview** — platform-wide stats dashboard.
- **Users & Trust** — verification queue (Part 5), manual trust score overrides, suspensions/bans.
- **Marketplace** — Admin-managed category catalog (Part 18), published service-listing oversight, public-content reports, appeals, and sampled quality review (Part 17). Admin does not approve service listings before publication.
- **Moderation** — reports queue and dispute resolution (Part 12), escalated cancellation requests (Part 9), and CompletionEscalations (Part 10).
- **Marketplace content** — review contested local-check failures and reports about public listings or requests, including requests with no Booking. Content review is distinct from booking-payment disputes; removal and any account-level consequence require an authorized, reasoned, audited Admin decision.

### Unified public-content workspace

The Admin sidebar has one **Content Reports & Appeals** entry for provider service listings, seeker public requests, content reports, and publication appeals. The former Service Listings and Public Requests pages redirect here, preserving exact content links. Booking **Disputes & Reports** remains separate.

- **Needs review:** incoming reports and owner appeals, filterable by content type and case type. A report alone never removes content or bans the owner.
- **All content:** searchable service listings and public requests, including content with no report. Show current visibility and allow reasoned removal or restoration when eligible. Private booking inquiries and engaged requests are handled through their booking/payment workflow.
- **History:** completed cases with the actual content outcome, owner consequence, and explanation. Historical explanation-only resolutions must not be interpreted as applied actions.

Case lifecycle: save original content and its owner when submitted → inspect the exact content, submitter, owner, current visibility, owner history, and outstanding obligations → select a content outcome → independently select a supported owner consequence → explain the finding → review impact and confirm → apply actions, notifications, and audit records in one database transaction → close the case only after success. Concurrent retries must not duplicate actions; stale content/account state requires reloading.

Reports allow dismissal with no penalty, removal, or keeping already removed content hidden. Supported removal findings can independently warn, temporarily suspend (1–30 days), or ban the content owner. Penalties apply to the owner, never the reporting person. Unstarted provider bookings block temporary suspension until handled in Disputes & Reports. Banning preserves bookings and payment obligations for existing Admin reconciliation; it does not cancel work or settle money automatically.

Owner appeals allow keeping a removal, restoring eligible content, or guidance without an account penalty. Restoration checks owner verification and access, active category, local policy, pricing, volume/duplicate limits, and linked obligations. A restored request returns to OPEN; previously rejected offers stay rejected. Voluntarily canceled requests are not eligible for Admin restoration. Guidance on a failed publication check explains revision and does not publish unsaved content.
- **Account moderation** — suspension uses Part 4 restricted resolution; banning immediately removes all normal user access and requires Admin resolution of outstanding obligations. Admin cannot delete historical obligations or funds.
- Every mutation requires server-side admin authorization. High-impact actions (suspension, ban, trust adjustment, refund/release, verification-document access) require a reason and immutable audit log; destructive financial actions must be idempotent and display the resulting state rather than relying on an optimistic UI.
- Suspending or banning an account MUST surface its affected engagements and payment obligations to Admin. The system uses existing lifecycle outcomes to resolve them; it does not silently delete or transfer a Booking to another provider.
- Admin list endpoints MUST paginate, filter, and select only required fields. Never return password hashes, refresh/reset tokens, private storage keys, raw payment secrets, or unnecessary verification-document URLs.

---

## PART 21 — AI INTEGRATION (GEMINI API — INSTRUCTOR-REQUIRED)

Exactly one dependable AI feature is defense-critical: the Review Summarizer. Other AI features are optional and MUST NOT block a marketplace transaction, admin decision, profile render, or modal opening.

### Priority 1 — Review Summaries (implemented; Gemini is configuration-dependent)
Provider and seeker role-context summaries are implemented, using eligible reviews of completed transactions. A provider summary covers the provider's eligible feedback across listings; the compatibility `serviceId` parameter does not make it per-listing. Profile and listing/offer previews request these digests through the shared summary UI.

The backend uses the newest 20 eligible reviews and computes the factual digest locally. With a configured Gemini key and at least five eligible written reviews, Gemini may select grounded review IDs/excerpts from that supplied set. It does not freely invent a new factual narrative or approve marketplace activity. The response identifies `computed`, `gemini`, or `empty` source. Fast requests can return the computed/cached result immediately while refinement runs. Content fingerprints, request deduplication, a five-second upstream timeout, and fallback prevent AI availability from blocking the page. Provider summaries are persisted in `AiReviewSummary`; seeker-role summaries use memory caching. A computed result may retry refinement after the cache interval rather than calling Gemini every render.

Defense acceptance still requires at least one provider with five realistic eligible written reviews, each attached through a valid completed Booking and CompletedService, plus a recorded demonstration of Gemini refinement and fallback. This is an acceptance requirement, not proof that the current seed/database already supplies that dataset or that a live Gemini request has passed.

### Priority 2 — AI Service Matching (backend-only; no active user flow)
`POST /api/ai/match-providers` and a frontend API wrapper exist. The reviewed frontend has no caller that automatically triggers matching after Post Request and no completed matching interface. The backend authorizes the seeker's request and builds up to ten category-compatible, eligible active-service candidates within 30 km, respecting listing coverage. Gemini can return additive suggestions/rationales; absent configuration or failure yields a fallback result. Document this as backend support awaiting UI integration, not a shipped recommendation flow. Ordinary nearby discovery uses deterministic database/geographical filtering, not Gemini.

### Priority 3 — AI Listing/Report Assist (future; not implemented)
No current listing-assist, report-assist, AI moderation decision, or category-assistant user flow is implemented. These must be labeled future proposals if discussed. Publication uses the local policy; Admin owns contested decisions. Member category suggestions were removed and are excluded from current scope.


---

## PART 22 — PAYMONGO INTEGRATION NOTES

- **ServiceHub uses PayMongo Test Mode only during development and defense.** Test activity does not move real money.
- **ServiceHub does not use or implement a PayMongo escrow product.** `PAID_HELD` is only the application's simulated ledger state; UI and documentation MUST NOT imply that ServiceHub, PayMongo, or a regulated escrow institution legally holds real funds for this capstone.
- Real provider payouts, withdrawal, revenue splitting, and commission collection are not implemented in the capstone integration. Available Balance is a simulated application ledger and includes only released online test earnings, never onsite-cash history.
- In the current adapter, test keys/test execution produce an internal refund identifier and `simulated_test_mode` status. The capstone persists the idempotent reversal in its ledger and must not claim that PayMongo moved money. This describes ServiceHub's adapter behavior, not a verified claim about PayMongo's entire current product catalog. Any future Live Mode integration requires current official provider guidance, verified capabilities, and a separate production-readiness review.
- Required env vars: `PAYMONGO_PUBLIC_KEY` (pk_test_…), `PAYMONGO_SECRET_KEY` (sk_test_…), and `PAYMONGO_WEBHOOK_SECRET`. Startup outside explicit test mocks must fail with a clear configuration error when a required payment secret is missing.
- Secret keys are backend-only, validated at startup outside test mocks, never prefixed `NEXT_PUBLIC_`, never returned to clients, and never committed. Webhook secrets must be rotated if exposed.
- Payment creation, confirmation, refund, and reconciliation MUST use unique provider identifiers and idempotency. A retry may return the prior result but must never create a second Booking, Queue row, release, refund, or ledger credit.
- Before any future Live Mode deployment, current PayMongo documentation, account capabilities, payment-method activation, fees, payout support, and applicable requirements MUST be reviewed again. This specification makes no permanent claim about PayMongo's complete product catalog or pricing.

---

## PART 23 — MONETIZATION (DOCUMENTED FUTURE PLAN — NOT REQUIRED FOR CAPSTONE BUILD)

Not required for the defense itself; describe as a future sustainability plan if asked.

- **Primary model:** a possible future transaction commission (for example 5%) deducted from a released online payment only after confirmed completion. This is not implemented for the capstone.
- **Secondary options:** optional featured/boosted listing placement for seasonal promotions, paid local business announcements in Community Hub.
- **Hard rule:** never monetize anything that affects trust accuracy, safety, or AI matching quality — only neutral visibility perks are appropriate.
- Recommended launch phase: fully free to build trust/adoption before introducing any commission.

---

## PART 24 — LANDING PAGE (PUBLIC, PRE-LOGIN)

Public, unauthenticated explainer page. Current component order in LandingPage.tsx: Header, Hero, Services ticker, Benefits, How It Works (the original three cards and service-rule shortcuts), Booking Progress (an illustrative Activity walkthrough), Workspaces (with a short Community summary), Comparison, combined Trust and Reviews, FAQ, the orange profile CTA and the original cinematic Footer. The header exposes six section shortcuts: Why ServiceHub, How it works, Booking progress, Workspaces, Compare and FAQ. Both desktop and mobile menus link Booking progress to #booking-progress. Queue, Community and Reviews retain their old anchor IDs inside the related sections. Detailed rules link to local Help Center articles. Illustrative landing content must not be presented as live platform statistics or genuine transaction evidence. The queue explanation applies only to successfully online-paid work; on-site cash requests do not join it.

The hero puts Get started and Explore the workspaces directly below its description, with optional Help Center guidance underneath. Help Center articles and search use bundled local guide data, not a guide-data API. Help navigation has no full-page marketplace-style route loader; the search server page resolves URL parameters and passes a query string into the local results component. Shared account/session/status checks may still run in the background, without requiring the public guide page to wait for success. Framework route/code loading and on-demand development compilation still exist.

The Comparison section uses a compact semantic feature table with Facebook and ServiceHub columns, crosses for the ordinary posts/messages workflow and checks for built-in ServiceHub capabilities. Rows cover nearby category/radius discovery, structured requests/offers, booking progress/history, reviews tied to confirmed completed services and booking-linked dispute records. Explain the posts/messages scope next to the table; do not claim that Facebook has no marketplace, reviews or moderation, or promise guaranteed safety or real online payouts. Both desktop and mobile header menus include Compare linking to #comparison. The table presents implemented capabilities, not measured platform performance.

The Queue Explainer MUST include: **“Your position is in this provider's paid work queue. The provider can perform only one job at a time.”** It must label wait times as estimates and explain that cash arrangements do not receive numbered paid positions.

Landing visual refinements use the existing brand assets and code-native Motion/CSS. How It Works retains the original three-card layout, with numbered steps, category labels, icons and a Seeker/Provider role switch next to the heading. The selected role uses Seeker orange or Provider green. Three shortcuts below the cards link to payment/queue, verification/messaging and review Help Center articles; the legacy queue anchor points to this shortcut area. A separate Booking Progress section follows How It Works. On desktop viewports at least 1024px wide, including shorter windows, a vertical timeline advances a sticky Activity preview as the page scrolls. A full-height right track bounds the pinned card to this timeline; the final row reserves enough viewport space to keep the completed view pinned before leaving the section. Landing-only html/body overflow uses clip rather than hidden, so the viewport remains the scroll container. Its five walkthrough stages are ready to start (queued), work underway (in_progress), the Provider waiting on Seeker approval (awaiting_seeker_approval), the Seeker reviewing that submitted work (the same awaiting_seeker_approval state), and Seeker-confirmed completion (completed). The confirmation stage shows the Seeker workspace in orange; Provider stages use green. The preview reuses ActivityDetailLayout, ActivityWorkroomSituation and ActivityDetailActions with isolated sample data, not screenshots or live account data. Start Job, Mark Work Finished, See Seeker confirmation, Confirm Completion and Restart advance only this local demo. Keyboard-accessible stage buttons also select each state. Viewports narrower than 1024px use stage buttons with a normal-flow preview. Motion values animate the timeline without continuous React state updates; stage selection changes only at stage boundaries. Desktop rows reserve 320 to 360px per stage for a slower scroll cadence. Booking content enters with a subtle 4px movement and gentle 0.6-second opacity easing; measured content height animates the frame over the same interval without stretching text. Role colors and stage markers transition softly. ResizeObserver measures actual row offsets for stage selection, including the final hold space; resize and initial scroll restoration also refresh the selected view. The sample card supplies the shared workspace surface and border tokens locally, giving it subtle theme-aware borders without changing authenticated cards. Reduced motion removes card movement and makes frame height changes immediate. No API, socket, booking, payment or database mutations occur in the demo, and no fixed completion times are promised. Workspace headers and completion/review steps use the same role colors. The connected workspace identity and restrained comparison-table reveals remain. Reduced-motion preferences disable the movement. Do not add AI-generated image assets for this redesign. The large workspace screenshot lightbox is not rendered. The original orange profile CTA and cinematic footer remain, including the service-category ticker near the hero and the locality ticker in the footer. Public actions remain session-aware and all public content is readable before account bootstrap succeeds.

Copy rules: use ServiceHub consistently, explain nearby location/radius discovery across communities, preserve both hiring flows, use "offers" rather than "bidding," and do not imply a queue for cash payments. Logos, browser titles, footers, authentication, Help Center, profiles and notifications must not impose a fixed municipal identity. Actual member-selected places remain valid location data. Do not invent statistics, a working support address, or claims of production deployment.

---

## PART 25 — KNOWN LIMITATIONS (DOCUMENT, NOT NECESSARILY BUILD FURTHER MITIGATION)

- Two-account collusion for trust score farming — mitigated by self-transaction blocking (Part 16); full prevention needs admin pattern-monitoring, documented as future work.
- Cold-start problem (marketplace needs both seekers and providers to have value) — addressed via a phased rollout plan (recruit verified providers in high-demand categories within specific barangays first), not a technical fix.
- Creative/digital services stretch the onsite mental model. They may use project pricing and booking-scoped text coordination, but the 15-minute–8-hour estimated-duration field remains a work estimate rather than a multi-day delivery guarantee. File sharing and richer milestone delivery are future scope. Longer turnaround expectations belong in the listing and agreed schedule.
- The paid work queue is provider-wide. Approximate waits use job-specific duration snapshots, not a live listing duration; actual service time can still vary, and this is not a reserved appointment calendar.
- Listings are reusable, but every Booking is independent. Repeat requests do not create subscriptions or guaranteed calendar reservations.
- Service radius does not decide who travels. There is no required Provider visits / Visit provider / Both selector; participants coordinate through booking chat.
- Review-summary Gemini refinement, Google sign-in, CAPTCHA, SMTP delivery, Cloudinary files, PayMongo checkout/webhooks, tiles and place search depend on configuration and upstream availability. Source support alone does not prove a working deployment.
- Verification retention metadata/holds and database deletion are implemented; automatic external-file deletion, scheduled document purging, deep upload content inspection and malware scanning are not established (Part 5).
- AI matching is backend-only; listing/report/category AI assistants, image/file messaging, external calendars, withdrawals, commissions and real payouts are outside the current completed feature set.
- The October 10 alignment review did not execute the full browser/database/payment acceptance suite or verify the deployed database migration state. Removed screenshots/reports are not current test evidence. Document actual execution separately.

---

## PART 26 — DATA MODEL SUMMARY

This snapshot lists every current Prisma model, its mapped SQL table, and scalar/enum field names. A trailing ? marks schema nullability. Relation object/list fields are omitted; derive the actual ERD, foreign keys, types, defaults, unique indexes and checks from SERVICEHUB-BACKEND/prisma/schema.prisma plus migration SQL. Nullable legacy columns are not permission to omit fields required by current services.

```text
User -> users
  id, name, email, passwordHash, passwordState, googleSubject?, googleConnectedAt?, phone, location, avatarUrl?, bio?, facebookUrl?, instagramUrl?, websiteUrl?, role, trustScore, verificationStatus, isActive, moderationStatus, suspendedUntil?, moderationReason?, postingSuspended, postingSuspendedAt?, postingSuspendReason?, onlineQueueLimit, emailVerified, onboardingStatus, deactivatedAt?, createdAt, updatedAt

RefreshToken -> refresh_tokens
  id, token, userId, expiresAt, createdAt

EmailVerificationToken -> email_verification_tokens
  id, token, userId, expiresAt, used, createdAt

PasswordResetToken -> password_reset_tokens
  id, token, userId, expiresAt, used, createdAt

ServiceVerification -> service_verifications
  id, userId, status, submittedAt, reviewedAt?, adminId?, adminNotes?, privacyNoticeVersion, privacyAcknowledgedAt, privacyAcknowledgedBy, retentionUntil, legalHold

VerificationProof -> verification_proofs
  id, verificationId, fileUrl?, storageKey?, mimeType?, sizeBytes?, documentType, uploadedAt

Category -> categories
  id, name, isActive

Service -> services
  id, providerId, categoryId, title, titleNormalized, description, price?, priceType, latitude?, longitude?, locationLabel?, coverageRadiusKm?, transportationFee?, serviceType, estimatedDurationMins, queueLimit, paymentMethods, status, isAvailable, rejectionCount, adminNotes?, reviewedById?, reviewedAt?, publishedAt?, moderationPolicyVersion?, moderationReasonCode?, createdAt, updatedAt

ServiceRequest -> service_requests
  id, seekerId, targetProviderId?, targetServiceId?, preferredPaymentMethod?, paymentMethods?, categoryId, title, description, budgetMin, budgetMax, latitude?, longitude?, locationLabel?, privateAddress?, transportationFee?, urgency, status, moderationPolicyVersion?, moderationReasonCode?, adminNotes?, reviewedAt?, reviewedById?, createdAt, updatedAt, archivedAt?

ContentModerationEvent -> content_moderation_events
  id, actorId, contentType, resourceId?, outcome, reasonCode, policyVersion, createdAt

ContentModerationCase -> content_moderation_cases
  id, submitterId, caseType, contentType, resourceId?, reason, status, adminId?, resolution?, contentOwnerId?, contentSnapshot?, decision?, penalty?, decisionResult?, decidedAt?, createdAt, updatedAt

Offer -> offers
  id, requestId, providerId, serviceId?, offeredPrice, estimatedDuration, availability?, message?, status, paymentHoldExpiresAt?, createdAt

DirectRequest -> direct_requests
  id, seekerId, providerId, serviceId, quantity, selectedPaymentMethod, agreedPrice, schedule?, message?, status, createdAt, updatedAt

Queue -> queue
  id, providerId, serviceId?, seekerId, offerId?, paymentId, paymongoPaymentId?, paymentStatus, position, status, estimatedWait, joinedAt, updatedAt, bookingId?

QueueNotify -> queue_notify
  id, serviceId, seekerId, requestedAt

Booking -> bookings
  id, seekerId, providerId, serviceId?, offerId?, directRequestId?, originType?, paymentAttemptId?, paymentMethod, agreedAmount?, jobLocation?, transportationFee?, estimatedDurationMins?, paymentStatus, status, statusBeforeDispute?, queuePosition?, started, scheduledDate?, scheduledTime?, hiddenBySeeker, hiddenByProvider, createdAt, updatedAt

BookingProgressEvent -> booking_progress_events
  id, bookingId, kind, actorRole, eventKey, occurredAt

CompletedService -> completed_services
  id, queueId?, directRequestId?, offerId?, bookingId?, seekerId, providerId, finalPrice, paymentStatus, completedAt

Review -> reviews
  id, completedServiceId, authorId, targetId, rating, text?, tags?, aiSummaryUsed, visibility, moderationReason?, moderatedById?, moderatedAt?, contentVersion, createdAt, editableUntil

Report -> reports
  id, bookingId, reporterId, reportedUserId, reason, description, evidenceUrl?, evidenceStorageKey?, reportType, dedupeKey?, status, adminId?, adminNotes?, resolvedAt?, createdAt

Message -> messages
  id, bookingId, senderId, receiverId, content, imageUrl?, isRead, isSystem, createdAt

Transaction -> transactions
  id, walletOwnerId, type, amount, status, relatedBookingId?, paymongoRefId?, description?, idempotencyKey?, settlementSource?, createdAt

Notification -> notifications
  id, userId, title, body, isRead, link?, createdAt

Announcement -> announcements
  id, title, body, authorId, isPublished, publishedAt?, createdAt, updatedAt

TrustScoreEvent -> trust_score_events
  id, userId, delta, requestedDelta?, reason, scoreBefore, scoreAfter, actorAdminId?, eventKey?, createdAt

AiReviewSummary -> ai_review_summaries
  id, providerId, summary, reviewCount, contentVersion, source, generatedAt

CancellationRequest -> cancellation_requests
  id, bookingId, requestedBy, responderId?, reason?, status, providerNote?, responderNote?, adminNote?, adminId?, reportId?, resolutionOutcome?, createdAt, resolvedAt?

AdminAuditLog -> admin_audit_logs
  id, actorId, targetUserId?, action, resourceType, resourceId?, reason, metadata?, createdAt

BanAppeal -> ban_appeals
  id, userId, banAuditLogId, message, status, decisionReason?, decidedById?, createdAt, decidedAt?

AccountDeletionRequest -> account_deletion_requests
  id, userId, status, blockers?, requestedAt, updatedAt, completedAt?

PaymentRefund -> payment_refunds
  id, bookingId?, paymentAttemptId?, paymentId, paymongoRefundId?, amount, status, reason, requestedById, failureReason?, createdAt, updatedAt

PaymentAttempt -> payment_attempts
  id, idempotencyKey, seekerId, providerId, serviceId?, quantity, offerId?, providerIntentId?, providerPaymentId?, providerClientKey?, redirectUrl?, amount, jobLocation?, transportationFee?, estimatedDurationMins?, currency, paymentMethod, status, failureReason?, expiresAt, createdAt, updatedAt

ProcessedWebhookEvent -> processed_webhook_events
  id, provider, eventId, eventType, status, failureReason?, processedAt?, createdAt, updatedAt

CompletionEscalation -> completion_escalations
  id, bookingId, requestedBy, reason, status, adminId?, resolution?, createdAt, resolvedAt?

AdminResolutionOperation -> admin_resolution_operations
  id, operationKey, caseType, caseId, bookingId, requestedByAdminId, requestedOutcome, requestedPenalty?, notes, status, stage, lastError?, result?, startedAt, updatedAt, completedAt?

```

Physical-model clarifications:

- Persisted account roles are lowercase user and admin in a String column. Seeker/Provider are workspace contexts, not separate User tables or roles.
- Google sign-in fields are on User; there is no OAuthIdentity table. Token models use a token column containing a hash, not separate token_hash/revoked_at/replaced_by_token_id columns. Refresh rotation atomically replaces that hash; revocation deletes session rows.
- Queue has a required providerId and nullable serviceId: it is provider-wide. User.onlineQueueLimit is operational; Service.queueLimit is retained compatibility data.
- Booking.serviceId, originType and agreedAmount remain nullable in the schema for legacy rows. Current business services enforce valid commercial origins and positive immutable totals for new bookings. Listing-free accepted offers are supported.
- ContentModerationCase/Event are distinct from booking Report. BookingProgressEvent supplies lifecycle history; AdminResolutionOperation supplies durable admin-operation retry state. BanAppeal and AccountDeletionRequest also exist; a legacy model does not imply an Admin account-deletion approval feature.
- Review visibility uses visibility/moderation metadata, not hidden_at. AiReviewSummary stores summary/contentVersion/source, not separate deterministic/refined columns. Notification has no eventKey field. ProcessedWebhookEvent stores eventId/failureReason, not payloadHash/attemptCount.
- PaymentAttemptStatus includes EXPIRED. Schema enums additionally retain compatibility values such as Booking WAITING/UNDER_REVIEW, ServiceType SESSION_BASED, PriceType PER_SESSION/STARTS_AT/CUSTOM, and TransactionType WITHDRAWAL; these do not prove current selectable product features.

### Canonical enums and invariants

- Current application Booking lifecycle: `PENDING_APPROVAL | ACCEPTED | ONGOING | AWAITING_CONFIRMATION | DISPUTED | COMPLETED | DECLINED | CANCELED | REMOVED`. The actual Prisma enum additionally retains legacy `WAITING` and `UNDER_REVIEW`; show those in the physical schema/legacy migration discussion, not as newly selectable workflow stages. Operational waiting position belongs to Queue.
- Queue status: `WAITING | SERVING | DONE | CANCELLED | REMOVED`.
- Online payment status: `PAID_HELD | FROZEN_HELD | RELEASED | REFUNDED`. Cash uses `UNPAID | CASH_CONFIRMED` only.
- A Booking has exactly one commercial origin: `DIRECT_LISTING` or `OFFER`. Flow A uses `DIRECT_LISTING`, requires a `service_id` but no `offer_id`, and may have one `direct_request_id` only for the cash provider-approval path. Flow B uses `OFFER`, requires `offer_id`, may have a null `service_id`, and has no `direct_request_id`. A DirectRequest never replaces the Flow A service link or Booking lifecycle.
- Account moderation is `ACTIVE | SUSPENDED | BANNED`. `BANNED` denies every normal authenticated route and socket regardless of `is_active`; only identity status, appeal, and logout remain available. Admin retains ownership of unresolved obligations.
- Google identity is stored on `User.googleSubject`/`googleConnectedAt`, with `passwordState` tracking password availability. There is no `OAuthIdentity` model/table. `passwordHash` remains a required schema string; its presence alone does not prove a usable password on a Google-only account. Password setup/change follows the implemented reauthentication and challenge rules in Part 4.
- A Booking may have at most one active Queue row, CompletedService, and PaymentRefund. A PaymentAttempt/provider payment may produce at most one Booking.
- A Booking may have at most one active CancellationRequest and one active CompletionEscalation. Only its provider may create the latter after the server-calculated 72-hour threshold. A duplicate active escalation returns the existing row; after `KEEP_AWAITING`, the next eligibility threshold is 72 hours from the previous `resolved_at`.
- A Booking may have at most one unresolved `COMPLETION_DISPUTE` Report. Duplicate submissions return the current case; distinct `SAFETY` reports remain possible subject to authorization, rate limits, and identical-incident deduplication.
- A PayMongo webhook event identifier may be processed once. Retrying a failed handler resumes/reconciles the same ProcessedWebhookEvent rather than applying its business effects again.
- Every new Booking is an independent `ONE_TIME` engagement. A listing remains reusable after a terminal Booking. Historical `SESSION_BASED`/`PER_SESSION` records are migration inputs, not supported product choices.
- Direct Booking implies an eligible price type from Part 7. Every Booking has a positive immutable `agreed_amount`; `CUSTOM` and other quote-required listing values never become payment amounts without an accepted Offer.
- `started=false` for `PENDING_APPROVAL` and `ACCEPTED`; only Start Job produces `ONGOING, started=true`.
- A provider may have at most one `ONGOING` Booking globally. Enforce Start Job and the provider-wide paid FCFS order under provider-scoped locks; listing links do not create separate queue positions or capacities.
- New marketplace relationships require `email_verified=true` and `verification_status=APPROVED`; existing engagements remain resolvable as defined in Part 4.
- `COMPLETED` implies exactly one CompletedService. `DISPUTED` implies an unresolved Report. Online `DISPUTED` implies `FROZEN_HELD`.
- Each CompletedService produces exactly one provider `+3` completed-service TrustScoreEvent. The unique event key prevents duplicate awards across seeker, Admin, cash, online, or retry paths; refunds/cancellations produce none.
- A Flow B Booking in a nonterminal state implies ServiceRequest `IN_PROGRESS`; completed implies `CLOSED`; canceled after matching implies `CANCELED`. Rejected sibling offers remain terminal.
- Database foreign keys, unique/check constraints where supported, and transactional application checks MUST enforce these invariants. Frontend hiding is never sufficient.

### Account moderation lifecycle table

| From | Admin event | To | Required side effects |
|---|---|---|---|
| `ACTIVE` | suspend with reason | `SUSPENDED`, `is_active=true` | enter restricted mode; block new relationships/Start Job; audit and notify; reconcile unstarted obligations safely |
| `ACTIVE` or `SUSPENDED` | ban with reason | `BANNED`, `is_active=true` for appeal login | immediately deny normal access and sockets; show ban notice; audit and notify; surface obligations for Admin |
| `SUSPENDED` | restore with reason | `ACTIVE`, `is_active=true` | restore normal eligibility subject to all other gates; audit and notify |
| `BANNED` with outstanding obligations | Admin resolves cases | unchanged | cancel/refund/release/complete/dismiss through existing idempotent outcomes; never transfer or delete history |
| `BANNED` | approve appeal or manual unban with reason | `ACTIVE`, `is_active=true` | notify user and restore normal access subject to verification gates; preserve obligations and history |
| `BANNED` | reject appeal with reason | `BANNED` | notify user of decision; normal access remains blocked |

### Booking lifecycle table

| From | Actor/event | To | Required side effects |
|---|---|---|---|
| no Booking | Flow A cash confirmation | `PENDING_APPROVAL` | create/link DirectRequest; price snapshot; no Queue/PayMongo |
| `PENDING_APPROVAL` | provider accepts | `ACCEPTED` | unlock chat |
| `PENDING_APPROVAL` | provider declines | `DECLINED` | notify seeker; refund only if a legacy paid record exists |
| no Booking | Flow B cash selection | `ACCEPTED` | accept selected offer/reject siblings/advance request atomically |
| no Booking | verified online success | `ACCEPTED` | immutable `agreedAmount`; `PAID_HELD`; add Queue; finalize offer/request atomically for Flow B |
| `ACCEPTED` | eligible `ACTIVE` provider Start Job | `ONGOING` | reject suspended/banned provider; provider-global guard; `started=true`; Queue `SERVING` when applicable |
| pre-start nonterminal | permitted cancellation/decline | `CANCELED` or `DECLINED` | refund online hold; close/reindex Queue; linked Flow B request → `CANCELED` after matching |
| `ONGOING` | provider Mark Completed | `AWAITING_CONFIRMATION` | Queue `DONE`; next waiting row becomes eligible |
| `AWAITING_CONFIRMATION` for 72h | provider escalates no response | unchanged | create one active CompletionEscalation or return the existing active row; keep payment held |
| `AWAITING_CONFIRMATION` + escalation | admin keeps awaiting | unchanged | resolve escalation `KEEP_AWAITING`; next escalation only 72h after `resolved_at`; no trust/payment change |
| `AWAITING_CONFIRMATION` + escalation | admin refunds | `CANCELED` | refund once; no CompletedService; linked Flow B request → `CANCELED` |
| `AWAITING_CONFIRMATION` + escalation | admin releases/completes | `COMPLETED` | settle once; create CompletedService; linked Flow B request → `CLOSED` |
| `AWAITING_CONFIRMATION` | seeker confirms | `COMPLETED` | settle payment, create CompletedService/trust/ledger once; linked Flow B request → `CLOSED`; resolve pending escalation |
| `AWAITING_CONFIRMATION` | seeker disputes | `DISPUTED` | store previous status; freeze online hold; create one completion-dispute Report; resolve pending CompletionEscalation |
| `DISPUTED` | admin dismisses/restores | prior status | restore corresponding held state |
| `DISPUTED` | admin refunds | `CANCELED` | refund once; no CompletedService; linked Flow B request → `CANCELED` |
| `DISPUTED` | admin releases/completes | `COMPLETED` | release/confirm cash, create CompletedService once, linked Flow B request → `CLOSED` |
| terminal Booking | seeker requests same listing again | new independent Booking | permitted only when no nonterminal Booking exists for the same seeker/listing; preserve prior history and review separately |

### Historical migration rules and deployment verification

These rules describe required reconciliation and existing migration intent; they are not proof that every target database has been migrated. Check the actual versioned SQL and target migration status. Do not reapply destructive backfills merely because they are listed here.

- Existing Booking `WAITING` rows with an active Queue `WAITING` row migrate to Booking `ACCEPTED`; the Queue retains `WAITING`.
- Existing Booking `UNDER_REVIEW` rows tied to unresolved reports migrate to Booking `DISPUTED`; Report may be `UNDER_REVIEW`.
- Existing cash completions recorded as payment `RELEASED` migrate to `CASH_CONFIRMED`, and cash earnings must not count toward online Available Balance.
- Existing Flow B offers/bookings may retain a valid provider-owned service link when present, but listing-free offers and their paid bookings need no service backfill. Preserve historical links without making them a queue or payment precondition.
- Reconcile any provider who currently has multiple `ONGOING` Bookings before enabling the provider-global Start Job guard.
- Normalize legacy `SESSION_BASED` listings to `ONE_TIME` and `PER_SESSION` prices to `FIXED`; preserve existing Booking amounts and legacy schedule columns as immutable historical data.
- Backfill Flow B terminal requests from their linked Booking where determinable; ambiguous records require an audited manual decision rather than automatic offer resurrection.
- Add hashed auth-token records, processed-webhook deduplication, and CompletionEscalation with the uniqueness/expiry rules above.
- Preserve the implemented DirectRequest relation for Flow A cash and document it consistently. Do not remove `direct_request_id` or its records without a separate audited migration that first replaces every active read/write path and preserves history.
- Reconcile existing suspended/banned accounts before adopting the ban notice. Do not blindly reactivate an account: establish `moderation_status`, inspect outstanding obligations, and preserve records for audited Admin resolution.
- Existing verification submissions without recorded notice acknowledgement remain historical; do not fabricate consent timestamps. Require the current notice acknowledgement for every new or resubmitted verification after the v2.2 migration.
- Add transactional/unique protections for one active CompletionEscalation, one unresolved completion dispute, and one completed-service trust event. Backfill or resolve duplicates through an audited reconciliation before enabling constraints.
- Deploy enum/schema migrations, transactional service changes, and regression tests together. Do not partially deploy a new state machine.


---

## PART 27 — CAPSTONE SCOPE AND STABILIZATION PRIORITY

Stabilize the current scope before adding major subsystems. Existing secondary features remain supported, but must not distract from broken or untested core flows. Audit existing implementation before rebuilding it. Tier placement expresses priority, not completion or a passing-test claim; use Part 30 for current status. The actual project duration is an owner-supplied SPMP fact, not an assumed three-month schedule.

### Tier 0 — defense-critical and release-blocking

1. Authentication, hashed refresh rotation, logout/session invalidation, enforced email-verification gate, password reset, suspended restricted-resolution behavior, and banned notice/appeal with Admin-owned obligation resolution.
2. Residency verification, private proof handling, current privacy-notice acknowledgement, limited-mode gating, and admin decision/access audit logs. Retention metadata/database deletion exist; external-file cleanup and deeper upload inspection remain explicit gaps in Part 5.
3. Service creation, deterministic/local-policy checks, direct publication for passing listings, revision failures, post-publication reports, and safe browsing. Passing Seeker requests become `OPEN` only after the same checks.
4. Flow A and Flow B, exact-price eligibility, immutable agreed amount, and complete ServiceRequest terminal behavior.
5. PayMongo Test Mode webhook verification/deduplication, idempotency, simulated hold, release, refund, and reconciliation.
6. Provider-wide paid `ONE_TIME` FCFS invariants, one-ongoing guard, Start Job, Mark Completed, cancellation, queue recalculation, and honest estimated-wait wording.
7. Completion confirmation/report deduplication, no-response CompletionEscalation cooldown/idempotency, and all explicit admin settlement outcomes.
8. Booking-scoped text messaging and durable notifications with secure realtime invalidation.
9. CompletedService separation, bilateral reviews, and deterministic trust events.
10. Admin authorization, pagination, redaction, moderation, and recorded auditing. Application audit entries must not be represented as cryptographically immutable or protected from a database administrator; account deletion also purges relevant user-linked database history.
11. One instructor-required AI Review Summarizer with a fast deterministic fallback; Gemini latency or failure must not block the surrounding page.
12. Nearby services/requests across city boundaries, independent search locations, combined filters, validated job coverage, private-location redaction, and immutable job/price snapshots for both flows and payment methods.

Any known Tier 0 failure must be fixed before visual polish or bonus AI work.

### Tier 1 — supported when stable, not required in the primary defense path

- QueueNotify waitlist
- Admin-managed category catalog (implemented and required by listing/request selection, even if not central to the defense demonstration)
- Text messaging read receipts
- Community announcements, statistics, and weekly leaderboard
- Google OAuth, provided credentials/origins are correctly configured; password login remains the dependable fallback
- Public landing page and help content

### Tier 2 — optional/future; may be hidden or documented instead of demonstrated

- AI Service Matching UI integration (backend support exists); listing/report AI assistants remain unimplemented. Member category suggestions are excluded current scope, not an existing feature.
- Message images and file attachments (not supported by the current text-only API)
- Wallet withdrawal, commissions, subscriptions, paid boosts, or real-money operation
- Provider-wide scheduling forecasts beyond the required one-ongoing-job safety guard
- Automatic recurring contracts, third-party calendar integration or calendar synchronization
- Automated two-account collusion detection
- Region-specific administrative partitions/policies, regional administrators, international onboarding/payment support, road routing and shared multi-instance geocoding infrastructure. Cross-city nearby discovery is implemented and is not a future-only feature.

### Defense release gate

Before claiming “production ready” or using a release build for defense:

- frontend and backend production builds pass;
- database migrations apply cleanly to a fresh database and the target database;
- Tier 0 unit/integration tests pass, including unauthorized and duplicate-event cases;
- one manual end-to-end test passes for Flow A cash, Flow A online, Flow B cash, Flow B online, cancellation before/after start, completion/release, no-response escalation, and dispute/refund;
- tests prove unverified-email mutation blocking, direct-booking price-type restrictions, Flow B payment rollback/terminal states, and rejection of a second simultaneous Start Job for one provider;
- moderation/privacy/lifecycle tests additionally prove:
  1. a suspended user cannot create a new marketplace relationship;
  2. a suspended participant can safely resolve an existing eligible engagement;
  3. a suspended provider cannot Start Job;
  4. suspension or banning cannot strand a `PAID_HELD` payment;
  5. banning takes effect immediately while nonterminal Bookings and held payments remain preserved for Admin resolution;
  6. paid FCFS order cannot be skipped across one provider's listings and accepted request offers;
  7. listing-free paid offers share that provider's waiting order, while different providers retain independent queues;
  8. duplicate CompletionEscalation requests return one active record;
  9. a second escalation must wait another 72 hours after `KEEP_AWAITING`;
  10. duplicate completion disputes do not create multiple Reports;
  11. verification submission fails without recorded current privacy-notice acknowledgement; and
  12. repeated completion processing awards the provider's `+3` trust event only once;
- defense seed data includes one provider with at least five valid written reviews and the AI panel demonstrates an actual Gemini refinement plus fallback;
- no secrets or private documents are committed or logged;
- browser console and server logs contain no unexplained 4xx/5xx loops, duplicate socket listeners, or unhandled rejection;
- production-like rate limits, CORS/origin allowlists, cookie flags, webhook verification, upload limits, and environment validation are enabled;
- backup/recovery and known limitations are documented.

---

## PART 28 — SECURITY, RELIABILITY, AND PERFORMANCE BASELINE

These are cross-cutting requirements, not optional features. They are acceptance targets, not a blanket security certification. Validate each claim against its implementation and execution evidence; Part 5 and Part 30 record known gaps. “Audit logged” means recorded application audit entries, not a cryptographically append-only store.

- **Authorization:** authenticate and authorize every protected route and socket action server-side. Verify role, `moderation_status`, `is_active`, verification gate, resource ownership/participation, and allowed current status before mutation. Restricted moderation access is an explicit allowlist of safe resolution actions, not general marketplace access. Return only fields the caller is entitled to see.
- **Input/output safety:** validate params, query, body, file metadata, and pagination with shared schemas. Use allowlisted update objects to prevent mass assignment. Prisma/parameterized queries are required; never concatenate untrusted SQL. Render user/AI text as text, not executable HTML.
- **External events:** payment webhooks, OAuth callbacks, email links, uploads, and AI responses are untrusted inputs. Verify signatures/tokens, apply expiry and replay protection, validate response shape, and use timeouts plus bounded retries.
- **Secrets and privacy:** environment secrets stay server-side and out of Git/logs. Redact tokens, cookies, authorization headers, passwords, payment identifiers when unnecessary, private document URLs, and sensitive personal data from errors and telemetry. Verification submission also requires the current recorded privacy-notice acknowledgement and respects authorized retention/deletion holds.
- **Errors:** production responses use stable codes and safe messages, never stack traces or raw provider/database errors. Server logs include a request/correlation ID and enough sanitized context to investigate.
- **Abuse controls:** rate-limit authentication, uploads, AI, reports, reviews, messaging, payment initiation, and waitlist actions. Add sensible body/file limits. Uniqueness, idempotency, and authorization remain required even when rate limits exist.
- **Database correctness:** use transactions and row/advisory locks for lifecycle races. Add indexes for foreign keys and common status/date queries. Monetary values use Decimal/integer centavos, never floating-point equality. Store timestamps as UTC and interpret user schedules in `Asia/Manila`.
- **Frontend request discipline:** do not fire protected dashboard queries until auth bootstrap resolves. Deduplicate shared queries, cancel obsolete requests, prevent retry loops, paginate large lists, lazy-load noncritical panels, and clean up timers/socket listeners.
- **Availability:** email, Gemini, Socket.IO, and optional OAuth failures must degrade to a documented fallback without corrupting core state. PayMongo success/failure must use durable reconciliation rather than an in-memory-only retry.
- **Dependencies and deployment:** use lockfiles, review production dependency advisories, run builds/tests/migrations in CI, set security headers and exact CORS origins, and run the same compiled start command that will be used for defense.

---

## PART 29 — GENERATING SRS, SDD, SPMP AND STD

### Evidence and terminology

Use specification version 3.0 and Part 30 for the current concept, implementation status and evidence boundaries. Check the current Prisma schema/migrations, API routes/services/schemas, frontend pages/components/help articles, package/configuration files, and actual test results before assigning implementation or validation status. Older documents that describe a single-city pilot or real escrow/payouts are superseded. Part 26 is a scalar-field snapshot, not a complete ERD or SQL definition: derive relationships, types, persisted role values, nullability, defaults, indexes and checks from `SERVICEHUB-BACKEND/prisma/schema.prisma` and migration SQL. Some SQL partial indexes/checks are not expressible in the Prisma model alone.

Use **ServiceHub — Location-Based Service Marketplace and Queue Management System** as the descriptive title. Use Seeker, Provider, Administrator, service listing, service request, offer, booking, provider-wide paid queue, and identity/residency verification consistently. Preserve the separate Flow A and Flow B narratives. The marketplace analogy concerns nearby discovery, not a copy of another platform's entire feature set.

### SRS — Software Requirements Specification

- Define purpose/scope, stakeholders, user characteristics, assumptions/dependencies, functional requirements, data/interface requirements, security/privacy, reliability/usability/performance constraints, and acceptance criteria.
- Give stable requirement IDs and distinguish implemented, planned and excluded behavior. Cover account/email/document gates; publication; nearby location/radius/search/category/quick filters; coverage/private job details; both flows with Cash/GCash; payment verification; queue/concurrency; Activity/messages/notifications; completion/reviews/trust; cancellation/disputes/admin; and informational Community Hub.
- Include independent profile/search/service/job locations, cross-city discovery, legacy records without coordinates, and public-versus-participant location privacy. Do not require a fixed-city address or municipality membership.
- Write measurable acceptance criteria grounded in current validation bounds and documented test scenarios. Do not invent uptime, throughput, legal guarantees, support SLAs or real-money functionality.

### SDD — Software Design Document

- Describe the actual Next.js/React frontend, Express/TypeScript API, Prisma/PostgreSQL persistence, Socket.IO delivery, private document/media storage, PayMongo Test Mode, Gemini integration, Leaflet/maps and backend-mediated place search.
- Include deployment/component diagrams, actual schema/relationships, access boundaries, frontend state/cache behavior, API request/response/error contracts, transaction/locking/idempotency rules, and lifecycle diagrams.
- Show separate sequences for Flow A Cash, Flow A GCash, Flow B Cash and Flow B GCash, followed by shared start/finish/confirmation/cancellation/dispute stages. Diagram the provider-wide queue without adding Cash entries or per-listing queues.
- Explain bounding-box/Haversine discovery, coverage checks, transport totals, immutable job snapshots and coordinate redaction. Derived diagrams must agree with implemented status mappings; browser labels need not equal backend enum strings.

### SPMP — Software Project Management Plan

- Describe scope, deliverables, work breakdown, roles/responsibilities, schedule/dependencies, resources/budget, risks, quality/configuration management, change control, deployment/migration planning and acceptance.
- Obtain actual team members, dates, costs and commitments from the project owner. Use explicitly marked TBD fields when absent; do not turn estimates into established project history.
- Separate implemented work from remaining validation/deployment and future features. Include cross-city/coverage tests, geocoder/map availability and quotas, private documents/job locations, payment webhooks, concurrent queue actions, and database migration/rollback risks.
- Retain versioned migrations and isolated test/development database practices. A source-code feature or successful build does not establish production deployment.

### STD — Software Test Document

- Include test objectives/scope, environments/accounts/data, entry/exit criteria, test IDs/preconditions/steps/expected results, negative/security/concurrency/recovery cases, traceability, defect reporting and evidence.
- Cover the four transaction variants, outside-city members, nearby radius/category/search combinations, out-of-coverage job pins, transportation calculations, draft Apply/Cancel, tab-focus refresh, public location redaction, old records without coordinates, and immutable booked terms.
- Retain payment failure/expiry/replay, competing offer outcomes, provider-wide queue/start guards, cancellation by either participant, disputes/admin settlement, reviews, notification/chat reconnect and access-denial cases.
- Use Not Run, Passed, Failed or Blocked according to recorded execution. Do not prefill every test as Passed, recycle historical totals as current results, or describe mocked gateway/socket tests as live browser/payment verification.

Cross-link the same requirement IDs across the SRS, design sections, SPMP deliverables and STD cases. Part 30 supplies subsystem IDs that may be subdivided into measurable requirements. The previous standalone manual checklist/reports were removed during cleanup; derive current cases from this baseline and the retained test sources. A test file proves a scenario was specified, not that it passed. State unresolved evidence gaps explicitly.

---

## PART 30 — IMPLEMENTATION STATUS AND DOCUMENTATION TRACEABILITY

### Review boundary and evidence rules

This baseline reflects a static source review on October 10, 2026 of the current working tree, including uncommitted changes. It covers the concept, persisted models, API access/validation, service logic, user-facing components and retained tests. No application code or database was changed for this review. The complete database schema has 35 Prisma models, represented in Part 26.

Status meanings: **I** = implemented source/UI path; **C** = implemented but external configuration/service is required; **B** = backend support without a completed frontend flow; **G** = known implementation/operational gap; **X** = excluded or future. These are implementation statuses, not test outcomes. A row marked I/C may still have bugs or unverified edge cases. File references are repository-relative: **B:** = SERVICEHUB-BACKEND, **F:** = SERVICEHUB-FRONTEND.

Use these stable subsystem IDs across the four documents; subdivide them into atomic requirements and tests where necessary. The source and test references below are representative entry points, not an assertion that a single file implements an entire subsystem.

| ID | Capability and current boundary | Status | Implementation entry points | Retained verification sources |
|---|---|---|---|---|
| SH-01 | One member account, Seeker/Provider workspaces, separate Administrator access | I | `B:src/middlewares/auth.middleware.ts`; `F:src/app` | `B:src/schema/authorization-contracts.test.ts`; `F:src/app/workspaceRedirects.test.tsx` |
| SH-02 | Password registration/login, hashed session rotation, logout/revocation | I | `B:src/services/auth/authentication.service.ts`; `B:src/routes/auth.routes.ts` | `B:src/schema/session-contracts.test.ts` |
| SH-03 | Email verification/resend and password reset; delivery requires SMTP | C | `B:src/services/auth/authentication.service.ts`; `B:src/schema/auth.schema.ts` | `B:src/integration/email-gate-login.test.ts` |
| SH-04 | Google sign-in, password setup/change and reauthentication challenges | C | `B:src/services/auth/password-management.service.ts`; `B:src/routes/auth.routes.ts` | `B:src/integration/password-management.test.ts` |
| SH-05 | Optional reCAPTCHA on registration/reset and progressive password login | C | `B:src/lib/captcha.ts`; `B:src/middlewares/captcha.middleware.ts` | `B:src/schema/captcha.test.ts`; `B:src/schema/captcha-routes.test.ts`; `F:src/schema/auth/useAuthForm.captcha.test.tsx` |
| SH-06 | Independent profile/contact/social edits, account settings and first-time orientation; generated display label is not a username | I | `B:src/services/auth/profile.service.ts`; `F:src/components/profile/AccountSettingsView.tsx`; `F:src/schema/profileValidation.ts`; `F:src/features/onboarding` | `B:src/schema/profile-update.test.ts`; `F:src/hooks/useUserProfile.save.test.tsx`; `F:src/hooks/useUserProfile.test.tsx`; `F:src/features/onboarding/components/OnboardingDialog.test.tsx` |
| SH-07 | Identity/residency proof submission, current acknowledgement, Admin decision and private signed access | C | `B:src/services/verification.service.ts`; `B:src/config/cloudinary.ts`; `B:src/config/privacy.ts` | `B:src/integration/privacy-deletion.test.ts`; `B:src/integration/trust-mechanics-audit.test.ts` |
| SH-08 | Self-service account deletion with obligations/identity checks and database purge | I | `B:src/services/account-deletion.service.ts`; `F:src/components/profile/AccountSettingsView.tsx` | `B:src/integration/self-service-deletion.test.ts` |
| SH-09 | External proof-file cleanup, scheduled retention purge, deep file inspection/scanning | G | `B:src/config/cloudinary.ts`; `B:src/services/data-retention.service.ts`; `B:src/controllers/upload.controller.ts` | Part 5 documents the gap; metadata/helper existence does not prove automatic file erasure or scanning |
| SH-10 | Admin-managed category catalog, protected Other Services fallback last in dropdowns/badges | I | `B:src/routes/categories.routes.ts`; `F:src/lib/category-catalog.ts`; `B:prisma/seed.ts` | `B:src/integration/category-source-of-truth.test.ts`; `B:src/integration/category-expansion.test.ts`; `F:src/components/ServiceCategoryDropdowns.test.tsx` |
| SH-11 | Reusable provider listings, four supported price types, duration/payment/base/coverage terms, pause/edit/management | I | `B:src/services/services.service.ts`; `B:src/schema/services.schema.ts`; `F:src/components/provider/OfferServices.tsx`; `F:src/components/provider/ServiceManager.tsx` | `B:src/integration/listing-correctness.test.ts`; `F:src/components/provider/OfferServices.test.tsx` |
| SH-12 | Shared deterministic publication policy, revisions, public-content reports/appeals | I | `B:src/services/content-moderation.service.ts`; `B:src/services/content-moderation-cases.service.ts` | `B:src/services/content-moderation.service.test.ts`; `B:src/integration/automated-content-moderation.test.ts` |
| SH-13 | Nearby service/request search, independent radius/preferences, category/quick filters, redacted location/distance | I | `B:src/services/nearby.service.ts`; `B:src/routes/services.routes.ts`; `B:src/routes/requests.routes.ts`; `F:src/hooks/useNearbyMarketplace.ts` | `B:src/integration/proximity-marketplace.test.ts`; `F:src/hooks/useNearbyMarketplace.test.tsx`; `F:src/components/location/MarketplaceDiscovery.flow.test.tsx` |
| SH-14 | Pin selection, coverage/search circles, optional full-screen map, explicit device location and place search | C | `F:src/components/location/LocationMap.tsx`; `F:src/components/location/LocationEditor.tsx`; `B:src/routes/locations.routes.ts` | `F:src/components/location/LocationMap.test.tsx`; `F:src/components/location/LocationEditor.test.tsx` |
| SH-15 | Flow A cash provider approval and direct online booking; quantity/transport/job snapshots | I/C | `B:src/services/bookings/direct-bookings.service.ts`; `B:src/services/bookings/direct-listing-pricing.ts`; `F:src/components/seeker/RequestServiceModal.tsx` | `B:src/integration/booking-flows.test.ts`; `B:src/services/bookings/direct-listing-pricing.test.ts`; `F:src/components/seeker/RequestServiceModal.test.tsx` |
| SH-16 | Flow B public requests, budget/urgency/payment choices, optional listing-linked offers and selection | I/C | `B:src/schema/marketplace.schema.ts`; `B:src/routes/requests.routes.ts`; `B:src/routes/offers.routes.ts`; `F:src/components/seeker/IncomingOffers.tsx` | `B:src/integration/post-request-flow.test.ts`; `B:src/integration/offer-lifecycle.test.ts`; `B:src/integration/request-payment-selection.test.ts` |
| SH-17 | Request management, archive/delete eligibility and repost template; no offer resurrection | I | `B:src/routes/requests.routes.ts`; `F:src/components/seeker/RequestManager.tsx`; `F:src/components/seeker/RepostRequestForm.tsx` | `B:src/integration/request-deletion.test.ts`; `B:src/integration/public-trust-request-archive.test.ts`; `F:src/components/seeker/RepostRequestForm.test.tsx` |
| SH-18 | GCash Test Mode intents, verified/deduplicated callbacks, durable attempts/expiry and return reconciliation | C | `B:src/services/payment-attempt.service.ts`; `B:src/services/paymongo.service.ts`; `B:src/server.ts`; `F:src/components/seeker/PaymentReturn.tsx` | `B:src/integration/payment-webhook.test.ts`; `B:src/integration/payment-return-reconciliation.test.ts`; `B:src/integration/payment-failure-return.test.ts` |
| SH-19 | Provider-wide online-paid FCFS waiting capacity, one ongoing job, start/finish/reindex/wait estimates | I | `B:src/services/queue.service.ts`; `B:src/services/bookings`; `F:src/components/provider/ProviderActivity.tsx` | `B:src/integration/provider-wide-workload.test.ts`; `B:src/integration/queue-concurrency.test.ts` |
| SH-20 | Notify Me waitlist: listing-linked subscription, oldest provider-wide eligible notification; no reservation | I | `B:src/services/bookings/waitlist.service.ts`; `B:src/services/queue.service.ts` | `B:src/integration/provider-wide-workload.test.ts` |
| SH-21 | Seeker/Provider Activity, booking details and progress history | I | `F:src/components/seeker/SeekerActivity.tsx`; `F:src/components/provider/ProviderActivity.tsx`; `B:prisma/schema.prisma` | `B:src/integration/booking-progress.test.ts`; `F:src/components/seeker/SeekerActivity.test.tsx`; `F:src/components/provider/ProviderActivity.test.tsx` |
| SH-22 | Booking-scoped text chat, contact eligibility/read state, durable notifications and realtime invalidation | I/C | `B:src/services/messages.service.ts`; `B:src/routes/notifications.routes.ts`; `F:src/lib/socket.ts`; `F:src/hooks/useMessagesPage.ts` | `B:src/integration/communication-concurrency.test.ts`; `B:src/schema/text-only-messages.test.ts`; `F:src/lib/socket.test.ts` |
| SH-23 | Seeker completion confirmation, separate CompletedService, online test release/cash confirmation and earnings history | I | `B:src/services/bookings/completion.service.ts`; `B:src/routes/transactions.routes.ts`; `B:src/services/provider-payment-records.service.ts`; `F:src/components/provider/TransactionHistory.tsx` | `B:src/integration/booking-flows.test.ts`; `B:src/schema/provider-payment-records.test.ts`; `B:src/integration/provider-payment-records.readonly.test.ts`; `F:src/components/provider/TransactionHistory.test.tsx` |
| SH-24 | Pre-start cancellation, started mutual requests/declines/escalation, refund and explicit fault outcome | I | `B:src/services/cancellation.service.ts`; `B:src/services/cancellation-report-finalization.service.ts`; `B:src/services/payment-refund.service.ts` | `B:src/integration/cancellation-report-finalization.test.ts`; `B:src/integration/high-priority-case-workflows.test.ts` |
| SH-25 | Booking safety/completion reports, optional private evidence, no-response escalation and Admin settlement/retries | I/C | `B:src/services/admin-report.service.ts`; `B:src/services/admin-case-workspace.service.ts`; `B:src/services/completion-escalation.service.ts`; `B:src/services/admin-resolution-operation.service.ts` | `B:src/integration/high-priority-case-workflows.test.ts`; `B:src/schema/admin-case-workspace.test.ts`; `B:src/schema/admin-booking-resolution.test.ts` |
| SH-26 | Completed-transaction bilateral reviews, edit/visibility rules, role-context ratings and event-based trust | I | `B:src/controllers/reviews.controller.ts`; `B:src/services/trust.service.ts`; `B:src/routes/reviews.routes.ts` | `B:src/integration/trust-mechanics-audit.test.ts`; `B:src/schema/seeker-review-stats.test.ts` |
| SH-27 | Grounded provider/seeker review digests, deterministic fallback and optional Gemini excerpt selection | I/C | `B:src/services/ai.service.ts`; `B:src/lib/review-summary.ts`; `F:src/components/ui/ReviewSummaryPanel.tsx` | `B:src/integration/review-summaries.test.ts`; `B:src/schema/review-summary.test.ts`; `F:src/components/ui/ReviewSummaryPanel.test.tsx` |
| SH-28 | AI provider matching endpoint and wrapper; no Post Request trigger/interface | B | `B:src/services/ai.service.ts`; `B:src/routes/ai.routes.ts`; `F:src/api/ai.api.ts` | Verify endpoint fallback separately; no completed matching UI acceptance claim |
| SH-29 | Community announcements, guides, real counters, current-week leaderboard and recent additions | I | `B:src/controllers/community.controller.ts`; `F:src/components/community/CommunityHub.tsx` | `F:src/components/community/CommunityHub.test.tsx` |
| SH-30 | Admin overview/users/verification/categories/announcements/reviews/audit and unified content cases | I | `B:src/routes/admin.routes.ts`; `B:src/services/content-workspace.service.ts`; `F:src/app/admin` | `B:src/integration/content-workspace.test.ts`; `B:src/integration/admin-user-profile.test.ts`; `B:src/schema/admin-contracts.test.ts` |
| SH-31 | Suspended restricted resolution, banning, appeals, restoration and Admin-owned outstanding obligations | I | `B:src/middlewares/auth.middleware.ts`; `B:src/services/admin-moderation.service.ts`; `B:src/services/admin-booking-resolution.service.ts` | `B:src/integration/authorization-lifecycle.test.ts`; `B:src/integration/safety-admin-guards.test.ts` |
| SH-32 | Public landing/help/legal pages, workspace themes, responsive UI, listing detail dialogs and refresh recovery | I | `F:src/components/landing/LandingPage.tsx`; `F:src/features/help`; `F:src/app/brand.css`; `F:src/app/globals.css` | `F:src/app/help/search/page.test.tsx`; `F:src/context/AppContext.sessionRecovery.test.tsx`; `F:src/test/background-refresh.integration.test.tsx`; `F:src/components/seeker/seek-services/ServiceDetailsModal.test.tsx`; `F:src/components/provider/browse-jobs/JobRequestDetailsModal.test.tsx` |
| SH-33 | Live money/payouts/withdrawal/commission, calendar reservations/recurrence, travel-mode selector, message attachments, AI moderation and member category suggestions | X | Parts 21, 23, 25 and 27 define exclusions/future ideas; retained enum/legacy fields do not implement them | Do not create passing current-feature tests for these capabilities |

### What each generated document may claim

- **SRS:** use I/C rows for current functional scope with their access rules, dependencies and measurable constraints. B/G rows must be explicitly partial or remaining requirements; X rows belong in exclusions/future work. Split broad subsystem IDs into atomic acceptance criteria without inventing new scope.
- **SDD:** describe the actual component/routes/service/schema architecture and provider-wide queue. Include the current nullable/legacy storage representation and transactional constraints, rather than drawing an imagined OAuth table or per-listing operational queue.
- **SPMP:** separate completed source work, outstanding implementation gaps, and remaining verification/deployment. Team names, owners, start/end dates, milestones, actual costs and commitments are owner inputs; mark them TBD until supplied.
- **STD:** retained tests are inputs for cases and traceability. Record the command, revision, isolated database/configuration, expected/actual result and evidence for each execution. Until executed, mark cases Not Run; mocked/pure tests do not prove browser, SMTP, storage, Gemini or payment integration.

### Unverified acceptance and operational items

This review did not rerun the full application test suites, production builds, live external calls, browser journeys, or database migrations. Confirm the four Cash/GCash flow variants, race/idempotency/security cases, all release-gate scenarios in Part 27, and configured external services in an isolated documented environment. Verify the real five-written-review AI dataset and actual Gemini/fallback demonstration. Resolve or explicitly retain the proof-file lifecycle and upload-inspection gaps. Do not reuse removed screenshots/reports, historical success totals or this static audit as execution evidence.

The two master prompt copies must remain identical. Recheck this matrix whenever code changes; it is a dated baseline, not automatic synchronization with the application.

---

## INSTRUCTIONS FOR THE AI READING THIS DOCUMENT

1. Read this entire document fully before writing or modifying any code.
2. Treat specification version 3.0 as the current documentation baseline. Older comments/documents lose when they conflict with its current scope, state tables and implementation-status qualifications. Never turn an unimplemented requirement into an as-built claim.
3. If the current codebase violates a rule above, report the affected flow and migration/test impact. When the user's request authorizes implementation, fix it without weakening another invariant. Schema/state-machine changes require migrations and regression tests; never silently reinterpret persisted states.
4. If a request from the user conflicts with this document, point out the conflict. If the user confirms the new decision, update this document in the same change so it remains the source of truth.
5. For new behavior, separate lifecycle stages, enforce authorization and invariants server-side, make external-event handling idempotent, and prefer the smallest approach that satisfies Tier 0.
6. Do not claim “production ready” solely because builds pass. Use Part 27's defense release gate and report any unverified item honestly.
7. This specification does not prove a target deployment has passed every workflow. Audit schema, authorization, lifecycle and test evidence before claiming alignment; preserve the DirectRequest flow unless an authorized migration replaces it safely. For document generation follow Part 29, including evidence-based test status and explicitly marked unknown project-management details.

### Version 2.0 foundation decisions

- Retained Next.js instead of mandating a high-risk Vite migration.
- Defined `USER`/`ADMIN` account roles and Seeker/Provider workspaces.
- Replaced real-escrow wording with an accurate PayMongo Test Mode simulated hold.
- Made provider Start Job the only transition that starts work.
- Made Queue status/position authoritative and retained historical rows for traceability.
- Historically separated one-time queueing from scheduled session bookings; Version 2.3 supersedes that design with reusable one-time listings.
- Added a safe Flow B payment-pending state so failed payments do not reject sibling offers.
- Historically required offers to reference a service listing; Version 2.6 removes that requirement.
- Defined explicit dispute outcomes, money direction, cash settlement, and idempotency.
- Defined bilateral reviews, private trust values, realtime fallback rules, sensitive-upload rules, and capstone scope tiers.

### Version 2.1 correctness amendments

- Added a provider-global one-`ONGOING` guard; Version 2.6 also makes the queue and capacity provider-wide.
- Defined which pricing types can produce an exact direct payment and made `Booking.agreedAmount` immutable.
- Added an enforced email-verification gate without trapping existing engagements or held funds.
- Defined Flow B request behavior after failed payment, booking creation, completion, and cancellation; rejected offers are never resurrected.
- Made after-start cancellation explicitly available to either participant with the other participant as responder.
- Added a neutral CompletionEscalation record and 72-hour admin workflow for seeker non-response.
- Added auth-token, OAuth identity, processed-webhook, and then-proposed session-slot records plus `PAYMONGO_WEBHOOK_SECRET`; the session-slot proposal is superseded by Version 2.3.
- Required a valid five-review defense dataset so the instructor-required Gemini integration is actually demonstrated.

### Version 2.2 correctness amendments

- Defined `ACTIVE|SUSPENDED|BANNED`, suspended restricted resolution, banned notice/appeal, and Admin resolution without booking transfer or trapped held funds.
- Historically scoped FCFS within each listing; Version 2.6 supersedes this with provider-wide paid FCFS.
- Preserved and canonically documented the implemented DirectRequest relation for Flow A cash rather than removing it from the specification.
- Defined CompletionEscalation duplicate behavior and the additional 72-hour cooldown after `KEEP_AWAITING`.
- Prevented duplicate unresolved completion disputes while preserving genuinely distinct safety reports.
- Replaced ambiguous completion trust wording with the existing provider `+3` event exactly once per CompletedService.
- Added current privacy-notice acknowledgement, immutable submission metadata, and private-proof retention/deletion rules.
- Replaced broad PayMongo product/fee claims with capstone-specific Test Mode, simulated-ledger, and future Live Mode review requirements.

### Version 2.3 scope simplification

- Removed session-based scheduling and `PER_SESSION` pricing from the supported product surface.
- Defined every Booking as one independent engagement while keeping its published Service listing reusable.
- Added repeat-request behavior after terminal bookings without introducing subscriptions or calendar reservations.
- Defined provider acceptance and optional non-reserved schedule proposals for Flow A cash requests.
- Retained legacy enum/column values only for backward-compatible migration and historical reads.

### Version 2.4 orientation and community clarity

- Added a persistent, skippable first-time orientation for normal users, with a Help Center path for reopening it later.
- Kept onboarding informational rather than turning it into a new authorization gate or a duplicate Help Center.
- Required Community Hub to distinguish undated platform guides from dated database events and to show genuinely recent category additions and public service listings.

### Version 2.5 geographic scope boundary — superseded by 2.7

- Historically described a single-municipality pilot. Version 2.7 replaces that geographic restriction with implemented location/radius discovery across communities and cities.
- Cross-city discovery/geospatial search are current functionality. Region-specific administration/policies remain future work.

### Version 2.6 risk-based local content moderation

- Replaced mandatory Admin pre-approval of every Provider listing with backend-controlled publication after existing gates and a versioned local policy pass. Superseded on September 30: listing exception approval was also retired; failed submissions require revision.
- Added the same pre-publication and pre-edit local checks to Seeker requests while keeping passing requests immediately `OPEN` and offerable.
- Kept Admin authority over flagged cases, reports, appeals, removals, sanctions, and categories; a local check failure alone never changes account trust or posting privilege.
- Separated first-publication `published_at` from human-review `reviewed_at`. Gemini remains optional and nonblocking, not a required moderation dependency.

### Version 2.6 provider-wide work queue and optional offer listings

- Flow B providers may send a custom price, duration, and message with no Service listing. A category-compatible active listing is only an optional prefill shortcut.
- `Queue.providerId` is authoritative for one provider-wide paid order; `Queue.serviceId` and `PaymentAttempt.serviceId` may be null for listing-free offers. Active positions are unique per provider, with at most one provider-wide `SERVING` row.
- `User.onlineQueueLimit` controls paid **waiting** capacity across all listings and offers. The retained `Service.queueLimit` column is legacy compatibility data, not an operational cap.
- `Booking.estimatedDurationMins` snapshots accepted terms. Estimated wait adds the expected durations of jobs ahead; the actual duration can differ.
- Cash stays outside the numbered queue, but a provider cannot start new cash work while paid jobs wait. The one-active-job guard applies across both methods.
- Verified GCash success creates an accepted, unstarted booking plus one waiting row. Provider Start Job alone begins service. Failed/expired attempts create neither; duplicate callbacks remain idempotent.

### September 30, 2026 — service listing approval retired

Provider listings publish after automatic validation or return a correction to make. Removed Admin pending-listing counters, listing approve/reject routes and UI, provider Under Review tabs, and obsolete socket events. Legacy unpublished pending listings become revision-required records and are never blindly published. Help, landing, onboarding, and community copy use plain wording and no longer describe listing pre-approval. Residency verification, category management, booking acceptance, reports, and disputes retain their own existing review workflows.

### Version 2.7 — nearby marketplace concept and documentation alignment

- Adopted ServiceHub branding throughout the website, metadata, Help Center, account/profile views, notifications and emails.
- Replaced single-municipality eligibility with identity/current-residence verification and implemented nearby discovery across city boundaries.
- Documented separate profile/search/service/job locations, coverage/travel rules, private directions, radius filtering, maps/geocoding, legacy record handling and transaction snapshots.
- Preserved both hiring flows and the existing Cash/GCash, provider-wide paid queue, Activity, messaging, completion, cancellation, dispute, review and trust lifecycle.
- Aligned supported exact-price listing types and backend module configuration with the current source.
- Added evidence-based SRS/SDD/SPMP/STD instructions and a complete root-level copy for documentation use.

### Version 2.8 — administrator-managed category catalog

- Category creation belongs exclusively to administrators; members choose existing active catalog entries for requests and listings.
- Admin category management retains creation, renaming, activation, deactivation guards, and recorded reasons. Community Hub uses actual category-creation audit timestamps for new additions.
- Both marketplace hiring flows and account-verification requirements remain intact.

### Version 2.9 — expanded service families and protected fallback

- Added the 21-family default catalog with Other Services as the protected fallback for both requests and listings.
- Preserved legacy category IDs, references, names and normal Admin activation choices through idempotent additive seeding.
- Clarified Seeker fallback wording, dynamic discovery filters, title/description search and responsive category controls without changing either transaction lifecycle.

### Version 3.0 — source-aligned documentation baseline

- Reviewed current application source, routes, validation, configuration, schema/migrations and retained tests for SRS/SDD/SPMP/STD preparation; no application functionality changed.
- Replaced the outdated conceptual data listing with all 35 actual Prisma models and scalar fields, including content cases, progress, appeals, deletion and durable resolution operations. Corrected Google identity storage, provider-wide Queue fields, payment expiry and legacy-nullability descriptions.
- Corrected nearby endpoint access, CAPTCHA support, validation/cancellation contracts, Community Hub calculations, current landing sections and workspace tokens.
- Distinguished grounded review summaries from backend-only provider matching and unimplemented AI assistants; retained deterministic discovery and both hiring flows.
- Recorded proof-file retention/deletion and upload-inspection gaps instead of claiming automatic provider-file erasure or scanning. Clarified recorded auditing and account-deletion consequences.
- Added Part 30's 33 traceable subsystem entries and implementation/configuration/partial/future status. Removed reliance on deleted manual-report files; actual test execution, deployment facts and SPMP owner inputs remain evidence-dependent.
- Subsequent October 10 profile correction: preserve the owner's session phone when loading public details, send only edited profile fields, validate those fields with readable errors, and handle cleared/malformed links without throwing. Clarified blank general-area and generated @ display-label behavior. Targeted regression tests and type checks are separate from the full release gate.

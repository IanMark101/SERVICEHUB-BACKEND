# SERVICEHUB MASTER PROMPT

**Specification version:** 2.3
**Effective date:** September 6, 2026
**Status:** Authoritative capstone specification

This is the single source of truth for **ServiceHub Cordova** — a hyperlocal two-sided service marketplace and queue-management system for Cordova, Cebu, Philippines. Read this document before changing application behavior.

### How to interpret this document

- **MUST / MUST NOT** means a required security, data-integrity, or capstone behavior.
- **SHOULD / SHOULD NOT** means the default design unless there is a documented technical reason to differ.
- **MAY** means optional behavior.
- If prose conflicts with a status table or invariant in this document, the **status table or invariant wins**.
- An explicit new user decision may supersede this document, but the same change MUST update this file before related implementation is considered complete. Do not allow code and this specification to evolve separately.
- Existing code is not automatically correct merely because it predates this version. Conversely, internal package names and historical migration names do not need cosmetic renaming when they are not user-visible.
- This document defines product behavior. Secrets, local credentials, live access tokens, and real identity documents MUST NOT be copied into this file.

---

## PART 1 — SYSTEM IDENTITY

- **Name:** ServiceHub Cordova (use this exact name in user-facing UI and current documentation; historical/internal package names may remain until a safe maintenance migration)
- **Geographic scope:** Cordova, Cebu, Philippines, only
- **Core purpose:** A community-based marketplace where people can browse local services and verified Cordova residents can transact, with fair queue management, a simulated online-payment hold in PayMongo Test Mode, and visible trust scoring.
- **One-sentence description:** ServiceHub Cordova lets verified residents offer and request services, coordinate online-paid one-time work through listing-specific First-Come-First-Served queues, arrange onsite-cash work directly, and build trust through verification, completed work, and reviews.
- **Account roles:** `USER` and `ADMIN`. A normal `USER` can switch between the Seeker and Provider workspaces; these are operating modes, not separate database roles or accounts. `ADMIN` is elevated and cannot switch into marketplace workspaces while acting as admin.
- **FCFS product rule:** FCFS order is guaranteed within each individual service listing. It is not a single global FCFS order across all services offered by the provider.

---

## PART 2 — TECH STACK

- **Frontend:** React through the existing **Next.js App Router** application. Do not migrate frameworks during capstone stabilization unless the user explicitly authorizes a separate migration project. Client/server component boundaries must remain deliberate, and browser-only authentication or Socket.IO code must run only in client components.
- **Backend:** Express + TypeScript
- **TypeScript config:** `strict: true` and `noImplicitAny: true` for frontend and backend. The backend may retain its compatible `module: "esnext"` / `moduleResolution: "bundler"` toolchain while it is validated by `tsx` and the production build. `module`, `moduleResolution`, package `type`, emitted files, and the Node start command MUST remain mutually compatible; both `npm run build` and `npm start` are release gates. Do not weaken type safety or switch module systems as an unrelated fix.
- **ORM:** Prisma
- **Database:** PostgreSQL, hosted on Neon (free tier is sufficient for this project)
- **Payments:** PayMongo, **Test Mode only** for the entire build and defense period. No real money is needed. The application simulates a payment hold in its own ledger; it is not PayMongo escrow.
- **AI:** Gemini API
- **Backend path aliases:** if the backend emits unresolved TypeScript `paths` aliases, run `tsc-alias` after `tsc`. This requirement does not apply when emitted imports are already directly resolvable.

---

## PART 3 — USER ROLES AND ACCOUNT BEHAVIOR

- One `USER` account can act as both Seeker and Provider, switching via a workspace toggle in the UI. Switching workspaces resets the active tab to that workspace's default (Seeker → "Seek Services", Provider → "Browse Jobs").
- Trust score, verification status, and profile data are shared across both roles — one identity, two dashboards, never two separate accounts.
- Admin accounts are provisioned directly or promoted by an existing admin — never created through normal public signup. Promotion MUST require re-authentication, an audit-log reason, and confirmation that the target has no active booking, unresolved report, or held payment. Promotion changes account authority; it MUST NOT delete historical marketplace records.
- **Default state on account creation:** `verification_status: UNVERIFIED`, `trust_score: 50`, `moderation_status: ACTIVE`, `is_active: true`, `email_verified: false`.
- **Canonical account moderation statuses:** `ACTIVE | SUSPENDED | BANNED`.
  - `ACTIVE` permits normal behavior subject to email/residency verification, role, ownership, availability, and lifecycle rules.
  - `SUSPENDED` blocks every new marketplace relationship and Start Job, but keeps narrowly restricted access to existing engagements that must be resolved safely.
  - `BANNED` permanently blocks new marketplace activity. While nonterminal obligations or a held payment remain, the account retains only the same restricted case access as a suspended account. Final authentication deactivation occurs only after those records are resolved.
- `moderation_status` controls marketplace restrictions. `is_active` controls whether authentication is finally permitted. Suspension normally keeps `is_active=true`; a banned account may be set to `is_active=false` only after no nonterminal Booking, held payment, unresolved cancellation, completion escalation, or dispute would be stranded.
- **Workspace Color & Theme Separation (UI Boundary):**
  - **Seeker Workspace:** Governed by **ServiceHub Terracotta (`#C86544` / `#D97757`)** across primary actions, active tabs, lifecycle steppers, and feedback modals. Green primary buttons should not appear in Seeker views.
  - **Provider Workspace:** Governed by **Emerald Green (`#059669` / `bg-emerald-600`)** for provider service offerings, offer submissions, and queue operations.
  - **Admin Workspace:** Governed by **Crimson / Slate (`#dc2626` / `bg-red-600`)** for administrative moderation, verification queues, and dispute files.

---

## PART 4 — AUTHENTICATION AND ACCESS GATING (CRITICAL — IMPLEMENT EXACTLY AS SPECIFIED)

### Signup
Fields: full name, email, phone number, password, location. Validate: email format, password strength (min 8 characters, at least 1 number), PH mobile phone format, duplicate email check. On success: create account with the default state above, send an email verification link.

### Login
Always succeeds if credentials are correct and `is_active` is true — **login itself is never blocked by verification status.** Verification only gates specific *actions*, never login access itself. On success: issue a short-lived JWT access token plus a longer-lived refresh token (HTTP-only cookie, rotated on use). On failure: show a generic "invalid credentials" message — never reveal whether the email exists.

### Authentication/session invariants

- When `is_active=true`, account moderation still applies: `ACTIVE` receives normal access subject to all other gates; `SUSPENDED`, or `BANNED` pending safe obligation resolution, receives restricted marketplace mode only. Final deactivation sets `is_active=false` and ends authentication.

- Access tokens are short lived. Refresh tokens are hashed at rest, stored in `HttpOnly` cookies, rotated on every successful refresh, and revoked on logout/password reset. Cookie `Secure`, `SameSite`, domain, and path settings must match the deployed same-site/cross-site architecture.
- CORS uses an exact environment allowlist with credentials enabled only for trusted origins. Never reflect arbitrary Origin values.
- The frontend resolves authentication once before firing protected dashboard queries. Concurrent `401` responses share one refresh request; after one failed refresh, clear local auth, disconnect Socket.IO, cancel/disable protected queries, and redirect to login. Never create a refresh/request retry storm.
- `401` means missing/expired/invalid authentication. `403` means authenticated but not authorized, unverified, suspended, or ownership-restricted. Clients must not attempt token refresh for ordinary `403` responses.
- Rate-limit login, signup, OAuth, refresh, password-reset, and verification-email endpoints by an appropriate combination of IP and account identifier without revealing account existence.

### Restricted marketplace mode for moderation

- A suspended or pending-deactivation banned user cannot create a listing, service request, offer, booking, payment, review, category suggestion, or any other new marketplace relationship.
- They cannot Start Job on `PENDING_APPROVAL` or `ACCEPTED` work. They may view the details and booking-scoped messages of existing engagements, respond to a cancellation, file a legitimate report, confirm completed work, and respond to an Admin case.
- A suspended provider may Mark Completed only for work already in `ONGOING`. Either participant may perform the required resolution actions for `AWAITING_CONFIRMATION`, `DISPUTED`, an active `CancellationRequest`, or an active `CompletionEscalation` when ownership and lifecycle checks allow it.
- When suspension or banning affects `PENDING_APPROVAL` or `ACCEPTED` work that has not started, Admin MUST use an idempotent cancellation/reconciliation workflow. Canceling an online-paid booking refunds it, closes/reindexes its Queue row, and notifies both parties; cash creates no platform refund.
- Existing `ONGOING`, `AWAITING_CONFIRMATION`, `DISPUTED`, CancellationRequest, CompletionEscalation, refund, and reconciliation records remain resolvable through restricted participant access or Admin action. Booking transfer is not part of the capstone; Admin uses the existing cancel, refund, release, complete, dismiss, or restore outcomes.
- Suspension, banning, restoration, final deactivation, and related booking/payment decisions require a reason, server-side authorization, transactionally safe and idempotent effects, an immutable AdminAuditLog, and participant notifications. Historical records are never silently deleted.

### Email-verification gate

- A user with `email_verified=false` may log in, browse public/marketplace read-only content, and request a new verification email.
- They MUST NOT submit residency proofs or initiate new marketplace relationships: create a request/listing/offer/booking, accept an offer, initiate payment, or suggest a category.
- If a legacy account or later email change leaves an existing engagement active, the user may still view/message it and perform the actions needed to resolve it safely (accept/decline an existing obligation, cancel, Start Job, Mark Completed, confirm, report, or respond to a cancellation). Never trap held funds merely because email verification changed. New engagements remain blocked.
- This email-verification resolution exception does not override a stricter moderation rule: a suspended or banned provider still cannot Start Job.
- Blocked frontend actions show **"Verify your email to continue"**. The backend returns `403 EMAIL_VERIFICATION_REQUIRED`; it never relies on the hidden button.
- Email verification is checked before residency verification. Marketplace transactions require both `email_verified=true` and `verification_status=APPROVED`, plus all normal account/ownership/status rules.
- A Google identity whose ID token contains a verified email may set `email_verified=true` after successful backend token verification; it does not approve residency.

### Optional Google OAuth

- Google OAuth is Tier 1, never the only login path. If either frontend or backend client configuration is missing, hide/disable the Google button with a configuration message; do not render a knowingly invalid Google client ID.
- Configure every real development/deployment origin in Google Cloud (for example the exact `http://localhost:3000` origin during local development). Origin errors are configuration failures, not authentication vulnerabilities.
- The backend verifies the Google ID token signature, issuer, audience/client ID, expiry, and verified email. Never trust profile data sent separately by the browser.
- OAuth may link to an existing account only when the verified email matches under a documented safe linking rule. It must never promote an account to Admin or automatically approve Cordova residency.

### The Access-Gating Rule (Hybrid Model — this is the locked decision, do not build a hard wall at login)

```
verification_status: UNVERIFIED or REJECTED
   → User can log in and reach the dashboard in "Limited Mode"
   → CAN: browse services, view provider profiles, read Community Hub, search
   → CANNOT: book a provider, post a request, accept an offer, create a
     service listing
   → Every blocked action shows a clear prompt: "Verify your Cordova
     residency to continue" with a button straight to the verification
     upload screen — NEVER a silent failure or generic error

verification_status: PENDING_REVIEW
   → Same restrictions as above, different message: "Verification under
     review — usually within 24 hours"

verification_status: APPROVED
   → Verification-gated marketplace actions are enabled
   → All other authorization, ownership, moderation, availability, queue,
     self-transaction, and account-status rules still apply
```

The diagram above assumes `email_verified=true`. When email is unverified, the email-verification gate applies first even if a legacy residency record says `APPROVED`. If email/residency status changes while an engagement is active, the user may still perform the minimum participant actions required to resolve that existing engagement safely; they cannot initiate a new one.

**Implementation requirement:** the email and residency gates must be enforced on BOTH frontend and backend for every route that initiates a new marketplace relationship or submission. Existing-engagement resolution routes must instead verify participant ownership, account safety, and allowed status while honoring the narrow resolution exception above. Do not attach one broad middleware in a way that traps an accepted obligation or held payment. The backend is authoritative. Authentication failures use `401`; authenticated users lacking email verification, residency verification, or permission use `403` with distinct stable machine-readable codes.

```typescript
// Backend middleware example — apply only to gated routes
export const requireVerification = (req, res, next) => {
  if (req.user.verification_status !== 'APPROVED') {
    return res.status(403).json({
      error: 'VERIFICATION_REQUIRED',
      message: 'Please verify your Cordova residency to perform this action.'
    });
  }
  next();
};

// Apply requireEmailVerification, then requireVerification, to marketplace mutations.
// Examples: POST /requests, POST /bookings, POST /services, POST /offers
// Do NOT apply to: GET /services, GET /community-hub, GET /providers (browsing stays open)
```

### Forgot Password
User requests reset by email → if the account exists, send a reset link with a time-limited token (~30 min expiry) → user sets a new password → all existing sessions invalidated. If the account does not exist, show the same generic confirmation message regardless (never leak which emails are registered).

---

## PART 5 — COMMUNITY VERIFICATION WORKFLOW (IDENTITY + RESIDENCY)

Verification is the system's core trust mechanism — it proves two things at once: the user is a real person, AND they specifically live in Cordova, Cebu.

Before selecting or submitting verification files, an email-verified user MUST be shown the current verification privacy notice and must actively acknowledge it. Opening the page, choosing a file, or continuing to use ServiceHub is not acknowledgement.

```
States: UNVERIFIED → PENDING_REVIEW → APPROVED
                          ↓
                       REJECTED (user can resubmit, returns to PENDING_REVIEW)
```

### Flow
1. An email-verified user goes to Settings → Verification and uploads an allowed identity document plus at least one document that visibly proves a Cordova, Cebu address. A single document may satisfy both requirements only when it clearly contains both identity and address information.
2. Submits → `verification_status: PENDING_REVIEW`.
3. Admin reviews in Admin → Users & Trust → Verification Queue, checking:
   - Is the document a valid, real ID/proof type?
   - Does the name match the account name?
   - **Does the address explicitly show Cordova, Cebu** — this is the residency check specifically, not just a generic identity check.
4. **Approve** → `verification_status: APPROVED`, "Verified Resident" badge granted, one-time `trust_score: +5`, user notified.
5. **Reject** → `verification_status: REJECTED`, admin must include a clear reason (e.g. "Address does not match Cordova, Cebu service area" or "Document unreadable, please resubmit"), user notified, can resubmit immediately.

### Data model
`SERVICE_VERIFICATIONS` (id, user_id, status, privacy_notice_version, consented_at, submitted_at, reviewed_at, admin_id, admin_notes) and `VERIFICATION_PROOFS` (id, verification_id, private_object_key, document_type, uploaded_at). APIs may return a short-lived authorized signed URL, never the permanent storage key as a public URL.

### Privacy notice and recorded acknowledgement

- Before document upload/submission, the UI MUST explain what identity/residency information is collected, why it is collected, that authorized Admins may review it, that files are private, which external storage/infrastructure providers process it when applicable, the stated retention period, when deletion may be requested, why unresolved disputes/security investigations/audit holds may delay deletion, and how to contact the project administrators.
- Submission fails with a stable validation error when affirmative acknowledgement, `privacy_notice_version`, or `consented_at` is missing.
- The notice version and timestamp are immutable for that verification submission. A new submission after a material notice change requires acknowledgement of the new version. These fields record the capstone's notice acknowledgement; they do not claim legal certification or complete production compliance.

### Verification-document security

- Proofs MUST use private storage. Never expose a permanent public object URL.
- Only the owner and authorized admins may retrieve a short-lived signed URL.
- Enforce an allowlist of image/PDF MIME types, extension and content-signature agreement, a configured size limit, randomized object names, and malware scanning when available.
- Never log document bytes, signed URLs, access tokens, or full ID numbers.
- Every admin view/download and every approval/rejection MUST be audit logged.
- Retention and deletion behavior MUST be stated in the privacy notice. For the capstone, proofs may be retained for the active verification record but MUST be deleted after permanent account deletion once active verification, dispute, security, and authorized audit-retention holds are resolved. Non-document audit metadata may remain when required for integrity, but it MUST NOT contain document images, full ID numbers, or reusable signed URLs.

---

## PART 6 — THE TWO MARKETPLACE FLOWS (BOTH MUST EXIST, NEVER MERGE THEM)

### Flow A — Browse & Book (provider sets the price)

The seeker browses "Seek Services," filters by category, and views an approved service listing. Direct booking is available only when the listing's price type is eligible under Part 7; otherwise the user is sent to Request a Quote/Flow B.

For Flow A cash, a `DirectRequest` records the provider-approval request and is linked to the `PENDING_APPROVAL` Booking created by the same logical workflow. `Booking` remains authoritative for lifecycle, messaging, cancellation, payment state, and completion. Flow A online originates directly from the active service listing and verified payment success; it does not require a DirectRequest.

- **Cash:** creates a `PENDING_APPROVAL` booking. The provider must accept or decline because the provider did not personally respond to this seeker beforehand.
- **Online:** the active listing is the provider's published commitment. After authoritative payment success, the booking becomes `ACCEPTED`; the provider does not approve it again, but work still does not start until the provider clicks **Start Job**.

### Flow B — Post Request & Receive Offers (seeker sets a budget)

The seeker posts a request (`OPEN`). A provider submits one offer containing price, duration, availability, message, and an immutable `service_id` pointing to one of that provider's own `ACTIVE`, category-compatible listings. This service link is required so online work has a defined queue, duration, capacity, and payment-method policy.

The provider's offer is their commitment:

- **Cash selection:** in one transaction, selected offer → `ACCEPTED`, sibling pending offers → `REJECTED`, request → `IN_PROGRESS`, and Booking → `ACCEPTED`. There is no second provider acceptance.
- **Online selection:** selected offer → `PENDING_PAYMENT`, request → `PAYMENT_PENDING`, and an expiring payment attempt is created. Sibling offers remain unchanged until payment succeeds. On authoritative payment success, one transaction changes selected offer → `ACCEPTED`, sibling pending offers → `REJECTED`, request → `IN_PROGRESS`, and creates the paid Booking. On payment failure, cancellation, or expiry, the selected offer returns to `PENDING` and the request returns to `OPEN`; no Booking or Queue row is created.

The payment-pending hold SHOULD expire after 15 minutes. Only one offer on a request may be `PENDING_PAYMENT` or `ACCEPTED` at a time; enforce this transactionally.

### Flow B request terminal behavior

- Payment failure/abandonment before a Booking exists: selected offer returns to `PENDING`, request returns to `OPEN`, and sibling offers remain `PENDING`.
- Booking creation from the selected offer: request becomes `IN_PROGRESS`; selected offer remains `ACCEPTED`; siblings become `REJECTED`.
- Linked Booking completion: request becomes `CLOSED` in the same idempotent completion workflow.
- Linked Booking cancellation after matching: request becomes `CANCELED`. Previously rejected sibling offers are never resurrected because their price and availability commitments may be stale. The seeker may create a new request, optionally referencing the canceled request for UI convenience.
- A ServiceRequest may have at most one nonterminal Booking. Request, offer, payment, and booking transitions must be locked and committed atomically where they change together.

### Naming rules

- The seeker-side tab is **"Incoming Offers."**
- Use **offer**, **submit offer**, and **offer-based matching**. Never call Flow B bidding or an auction.
- Keep both flows in separate workspace tabs because they represent different user intent.

---

## PART 7 — PAYMENT METHODS AND THE PAYMENT GATE

Supported capstone methods are:

| Payment type | PayMongo? | FCFS Queue? | Settlement behavior |
|---|---:|---:|---|
| GCash / Maya / Card (online, Test Mode) | Yes | Yes | `PAID_HELD` after verified success, then `RELEASED`, `FROZEN_HELD`, or `REFUNDED` |
| Onsite Cash | No | Never | `UNPAID` until seeker confirms completion, then `CASH_CONFIRMED`; no platform wallet credit |

The FCFS queue is reserved for successfully paid online bookings. Cash never enters Queue. Every Booking is one independent engagement, while its Service listing remains reusable.

### Price-type eligibility and exact amount

- `FIXED` is the only Tier 0 price type eligible for direct Flow A cash or online booking. The exact listing price is snapshotted server-side into `Booking.agreedAmount`.
- `STARTS_AT`, `PER_HOUR`, `PER_DAY`, `PER_PROJECT`, and `CUSTOM` require Flow B/provider quotation before booking. The selected Offer's exact `offeredPrice` becomes `Booking.agreedAmount`; descriptive units never determine a PayMongo charge by themselves.
- Unsupported direct price types display **Request a Quote**, not an active direct Book/Pay button.
- `Booking.agreedAmount` is an immutable Decimal/integer-centavo snapshot after creation. Refund, release, transaction history, admin case files, and CompletedService use this snapshot—not the current listing price and never a client-submitted amount.

### Online payment invariants

1. The server calculates the price from the service or accepted offer. Never trust a client amount.
2. Payment initiation stores a `PaymentAttempt` bound to seeker, service, optional offer, amount, currency, method, and an idempotency key.
3. Only a server-to-server PayMongo verification or authenticated webhook may declare success. Browser redirects are informational, never authoritative.
4. Signature verification MUST use the raw webhook body. Processing MUST be idempotent by PayMongo event/payment identifier.
5. The payment confirmation must exactly match the stored seeker, service, offer, amount, currency, and method.
6. Only after verified success may the system create a `PAID_HELD` Booking and its Queue row.
7. Work MUST NOT start automatically after payment. `started` remains false until the provider clicks Start Job.
8. If payment fails or is abandoned, no Booking or Queue row is created. The durable PaymentAttempt records the failure without exposing sensitive provider data.
9. Capacity is checked before payment and rechecked under the service lock during success handling. If a captured payment cannot safely become a booking, persist it as `REFUND_REQUIRED` and start an idempotent refund/reconciliation path; never lose the payment or silently exceed the configured capacity.

### Cash invariants

- Cash creates no PayMongo intent, Queue row, held funds, refund record, or online-wallet credit.
- The platform may create a non-wallet cash earning/history entry only after seeker confirmation; it must be labeled as externally settled cash.
- Flow A cash requires provider acceptance. Flow B cash does not, because the selected offer was already the provider's commitment.
- A Flow A cash request MAY include a plain-language preferred schedule. It is a proposal only: it does not reserve time, claim calendar availability, or become authoritative until the provider accepts and the parties coordinate through booking-scoped messaging.
- A provider who is unavailable SHOULD pause the listing. Offline delivery uses durable database notifications; Socket.IO is only a realtime convenience.

---

## PART 8 — FCFS QUEUE LOGIC

Each `ACTIVE` service listing has its own independent online-payment queue with limit 1–10 and an estimated duration. Queue order/capacity are listing-specific, but work concurrency is provider-wide.

**Canonical fairness rule:** FCFS order is guaranteed within each individual service listing. It is not a single global FCFS order across all services offered by the provider.

- When no job is ongoing, a provider may choose which service listing's eligible first customer to start next. Within the chosen listing, the provider may never skip an earlier eligible waiting customer.
- The provider-global one-`ONGOING` guard still applies after that listing choice.
- Queue positions from different service listings are not directly comparable. Demand in a provider's other listings can affect actual wait time, so every wait value is labeled as an estimate rather than a guarantee.
- User-facing queue help MUST say: **“Your queue position is FCFS within this specific service. Providers can offer several services but may perform only one active job at a time.”**

### Provider-wide concurrency (Tier 0)

- A provider may have at most one `ONGOING` Booking across all service listings.
- Start Job MUST acquire a provider-scoped database/advisory lock as well as the applicable service lock, then recheck for another `ONGOING` Booking before changing any state.
- Prefer a database-level partial unique index that permits only one `ONGOING` Booking per provider as a final race-condition backstop; the transactional check remains required for a clear domain error.
- If another ongoing job exists, return `409 PROVIDER_ALREADY_SERVING` and leave Booking/Queue unchanged.
- For queued work, Start Job must also verify that the target is the eligible first waiting row of its service. Provider-wide locking does not merge listing queues or allow skipping within a listing.
- The UI must show the provider's current active job and disable other Start Job actions while it is ongoing. Frontend disabling is advisory; the transaction is authoritative.

### Authoritative queue model

- Queue is the sole authoritative source of position. `Booking.queuePosition`, if retained for legacy compatibility, is a transactionally synchronized mirror and MUST NOT be independently edited or used as the locking authority.
- At most one row per service may be `SERVING`. The next eligible `WAITING` row has the lowest position.
- When no row is serving, the first waiting row is position 1. When a row is serving at position 1, waiting rows begin at position 2.
- `estimatedWait = estimatedDuration × (position − 1)`. It is explicitly an estimate, not a guaranteed appointment time.
- Queue capacity counts rows in `SERVING` plus `WAITING`. Historical `DONE`, `CANCELLED`, and `REMOVED` rows do not consume capacity.
- All join, start, cancel, complete, remove, and reindex operations MUST run server-side in a database transaction protected by a service-scoped lock. Positions must remain positive, contiguous, and unique among active rows.

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

- The seeker may cancel immediately. The provider may decline/cancel an accepted but not-started obligation; both paths require a reason for audit/notification even when approval is unnecessary.
- Online `PAID_HELD` work receives an idempotent full refund; cash has no platform refund.
- Any active Queue row becomes `CANCELLED`, positions are recalculated, and the waitlist notification rule runs.
- A provider cannot silently delete a paid booking or remove it without the cancellation/refund workflow.

### After start

- Neither party may directly cancel the Booking.
- Either seeker or provider may submit one active `CancellationRequest` with a required reason.
- The other party may approve or decline with an optional note.
- Approval cancels the booking. Online payment is fully refunded; cash requires the parties to settle externally and the platform records no PayMongo refund.
- A decline may be escalated to Admin. Admin either approves cancellation/refund or rejects it and returns the Booking to `ONGOING`.
- Trust penalties apply only to the party explicitly found at fault by an admin or an unambiguous policy rule; never penalize both parties merely because a cancellation occurred.
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

## PART 11 — MESSAGING UNLOCK

- A chat thread unlocks only when a Booking reaches `ACCEPTED`, `ONGOING`, `AWAITING_CONFIRMATION`, or `DISPUTED`. A queued online booking remains `ACCEPTED`; Queue status represents waiting/serving position.
- Before that point, no thread should be creatable or visible — there's nothing to message about yet.
- Every message is stored with a `booking_id` foreign key — this is required both for the unlock rule and for dispute evidence retrieval (Part 12), so admin can pull the exact conversation tied to one specific transaction, not a tangle of every message two users have ever exchanged.
- Features inside an unlocked thread: real-time chat, image sharing, read receipts, system messages (e.g. "Payment confirmed," "Provider marked service as completed").

### Realtime and notification delivery rules

- REST/database state is authoritative; Socket.IO events are invalidation hints, not the only copy of an action.
- Authenticate the socket during connection with the same active-account checks as HTTP. Join only rooms the user is authorized to access (`user:{id}` and participant/admin-authorized `booking:{id}` rooms).
- Never accept a client-supplied user ID as socket identity. Never broadcast booking data to a service/user room without server-side membership checks.
- Every persistent action commits to the database before its event is emitted. On reconnect, clients refetch canonical state so missed events do not cause drift.
- Event handlers must be idempotent or deduplicated by stable entity/event ID. The client should use one socket instance and clean up listeners on unmount to prevent duplicated requests and lag.
- Important notifications are stored in `Notification` before emission. If realtime delivery fails, the notification remains available through the REST inbox.
- Message image uploads follow the same private-storage, type, size, randomized-name, and authorization rules as other sensitive uploads.

---

## PART 12 — REPORTS AND ADMIN DISPUTE RESOLUTION

- A report can only be filed by a participant against the other participant of an existing Booking. Completion disputes may be filed only from `AWAITING_CONFIRMATION`; other safety reports may be filed from an allowed active/terminal status but MUST NOT automatically freeze money unless an online payment is still held.
- A Booking may have at most one unresolved completion dispute. Repeating the same completion-dispute request returns the existing Report instead of creating another. The transition from `AWAITING_CONFIRMATION` to `DISPUTED` and Report creation MUST occur under the same booking-row lock.
- Once a Booking is `DISPUTED`, another completion-dispute submission is rejected with a stable conflict response or returns the current case. A database uniqueness rule where practical, plus a transactional application invariant, MUST prevent duplicate unresolved completion disputes.
- Genuinely different safety incidents may be reported separately even while a completion dispute exists. Rate-limit report creation and deduplicate repeated identical safety reports from the same reporter for the same Booking without suppressing a distinct safety concern.
- Report form: reason (dropdown: Poor Service Quality / Incomplete Service / Scam or Fraud / Inappropriate Behavior / Overpricing / No-show), description (required), evidence (optional photo/screenshot).
- Admin sees a full case file in ONE view, assembled via a single relational query (Prisma `include`):
  - Reporter's name, trust score, verification status
  - Reported user's name, trust score, verification status
  - The linked booking: service, dates, amount, payment status
  - The full chat history between the two parties **scoped to this specific booking_id only**
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
| Report validated by admin | reported user | -10 |
| Second moderated listing rejection | provider | -5 once for that threshold |

- The completed-service `+3` event uses a unique key derived from the CompletedService and is created exactly once. Seeker-confirmed cash/online completion and Admin `RELEASE_PROVIDER_AND_COMPLETE` use the same event; retries cannot award it twice. Refund and cancellation outcomes never create it.
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
Category (admin-approved list only), title, description, price, price type, estimated duration per service, max online queue capacity (1–10), and accepted methods (GCash, Maya, Card, Onsite Cash — at least one required). Only display methods actually enabled and configured in the environment.

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
- `STARTS_AT` — "starting at ₱X"
- `PER_HOUR` — "₱X / hour"
- `PER_DAY` — "₱X / day"
- `PER_PROJECT` — "₱X / project"
- `CUSTOM` — custom pricing (no unit label)

Existing listings without an explicit `priceType` default to `FIXED` and are fully backward-compatible.

Display units do not by themselves authorize direct payment. Apply Part 7's eligibility rules: direct booking is `FIXED`; every advanced type uses an exact provider Offer before booking/payment.

### Validation (both frontend instant feedback AND backend Zod re-validation — never trust client input alone)
```
Title:              required, 10–100 characters, no symbols outside basic punctuation
Description:         required, 30–1000 characters
Price:               required numeric ₱50–₱50,000 except CUSTOM;
                     CUSTOM stores no authoritative direct-booking price
Queue limit:          required integer 1–10 for online queueing
Estimated duration:   required, 15 minutes–8 hours
Payment methods:      at least one required
Preferred schedule:   optional free text on Flow A cash requests; never a reservation
```

### Duplicate and volume limits
- No two nonterminal listings (`PENDING_REVIEW` or `ACTIVE`) from the same provider may have the same trimmed, case-folded title. Enforce this transactionally and preferably with a PostgreSQL partial unique index on `(provider_id, LOWER(title))` for those statuses. A normal `(provider_id, title)` constraint is not sufficient because it is case-sensitive and also blocks safe title reuse after archival.
- **Standard volume limit:** Maximum **3 active listings** per provider at any time. This deliberate limit prevents listing clutter and spam in Cordova, keeps search results clean, and ensures providers do not overcommit beyond manageable queue capacities. To publish a new service, a provider simply pauses or archives an existing listing.

### Admin moderation gate (the system's primary content safeguard)
**Every new listing defaults to `PENDING_REVIEW`, `isAvailable: false` — invisible to seekers until admin approves.** Admin checks: does title match category, is content appropriate, is the provider verified. Approve → `ACTIVE`, `isAvailable: true`. Reject → `REJECTED`, provider notified with a reason.

- 1st rejection: warning notification.
- 2nd rejection: `trust_score -5`.
- 3rd rejection: account flagged for manual review, posting privilege suspended.

Editing title, category, description, media, or proof re-triggers `PENDING_REVIEW` and hides the changed listing until approval. Price, pricing unit, duration, queue limit, payment methods, schedule availability, and pause/resume may remain live edits after backend validation. Admin rejection counts and penalties must be based on moderated rejection events, not repeated retries of the same request.

---

## PART 18 — CATEGORY MANAGEMENT

- Categories are admin-controlled, not freely creatable by providers — this keeps "Seek Services" filtering/browsing functional (prevents duplicate near-identical categories like "Plumbing" / "Plumber" / "Pipe Repair").
- Users (seeker or provider) can suggest a new category (name + description) contextually via the Marketplace empty search state or modal ("Can't find what you need? Suggest a category"), rather than cluttering primary sidebar navigation.
- Admin approves (adds to the official list immediately, auto-posts to Community Hub's "Newly Added Categories") or rejects (status updated, submitter notified).
- This is the mechanism that makes the category list extensible to new service types (e.g. illustration/art services, photography) without hardcoding every possible category in advance — providers still have full freedom in what they actually offer within any category; admin only controls the organizational labels, not the content of services themselves.

---

## PART 19 — COMMUNITY HUB (ADMIN/SYSTEM CONTENT ONLY — NO USER-GENERATED FEED)

Deliberately scoped out: no user photo posts, no public scrollable social feed, no likes/comments system — this avoids moderation overhead unrelated to the core marketplace purpose.

- **Announcements** — admin-posted only.
- **Top Providers leaderboard** — auto-generated weekly, ranked by trust score (primary) + completed services + rating (tiebreakers), no manual curation.
- **Community Stats** — auto-computed counters. “Active provider” means a verified user with at least one `ACTIVE` listing. “Active seeker” means a verified user who created a request or booking during the displayed reporting period. One user may count in both; label this clearly rather than pretending these are exclusive account roles.
- **Newly Added Categories** — auto-posted the moment admin approves a suggestion (Part 18).

---

## PART 20 — ADMIN PANEL

- **Overview** — platform-wide stats dashboard.
- **Users & Trust** — verification queue (Part 5), manual trust score overrides, suspensions/bans.
- **Marketplace** — category suggestion approvals (Part 18), service listing approvals (Part 17).
- **Moderation** — reports queue and dispute resolution (Part 12), escalated cancellation requests (Part 9), and CompletionEscalations (Part 10).
- **Account moderation** — suspension, banning, restoration, and final deactivation use the Part 4 restricted-resolution rules. Admin cannot finalize deactivation while a nonterminal Booking, held payment, unresolved refund, report, cancellation, or completion escalation would be stranded.
- Every mutation requires server-side admin authorization. High-impact actions (promotion, suspension, ban, trust adjustment, refund/release, verification-document access) require a reason and immutable audit log; destructive financial actions must be idempotent and display the resulting state rather than relying on an optimistic UI.
- Suspending or banning an account MUST surface its affected engagements and payment obligations to Admin. The system uses existing lifecycle outcomes to resolve them; it does not silently delete or transfer a Booking to another provider.
- Admin list endpoints MUST paginate, filter, and select only required fields. Never return password hashes, refresh/reset tokens, private storage keys, raw payment secrets, or unnecessary verification-document URLs.

---

## PART 21 — AI INTEGRATION (GEMINI API — INSTRUCTOR-REQUIRED)

Exactly one dependable AI feature is defense-critical: the Review Summarizer. Other AI features are optional and MUST NOT block a marketplace transaction, admin decision, profile render, or modal opening.

### Priority 1 — AI Review Summarizer
Trigger: a provider profile or booking preview requests a digest. If fewer than 5 eligible written reviews exist, return a fast deterministic summary or a clear “not enough feedback” result without calling Gemini. For 5+ reviews, immediately return the latest cached/deterministic digest and optionally refine it asynchronously with Gemini. Use only the newest bounded set of sanitized review text (for example 20), never user contact data. Persist or cache by provider plus review-content version; regenerate after the review version changes, not on every render. Requests must be deduplicated, time-limited, rate-limited, and able to fall back without failing the page.

Defense data MUST include at least one provider with five realistic eligible written reviews, each attached through a valid completed Booking and CompletedService. The defense should demonstrate an actual Gemini refinement as well as the nonblocking fallback; never insert orphan reviews or present fabricated production statistics.

### Priority 2 — AI Service Matching
Optional after the core system is stable. Trigger after Post Request. Input only the request and a server-generated shortlist of category-compatible active services. Output is an additive suggestion with a rationale; normal browsing and offers remain fully functional when Gemini is absent, slow, quota-limited, or wrong.

### Priority 3 (optional bonus) — AI Listing/Report Assist
(a) Listing assist: flags title/category mismatches or likely policy-violating content before admin review (Part 17) — a hint only, admin still decides. (b) Report assist: gives admin a preliminary, clearly-labeled "AI-generated, not a final decision" assessment on a filed dispute (Part 12) — admin still makes the actual call.

### Priority 4 (optional bonus) — AI Category Suggestion Assist
Trigger: a category suggestion is submitted (Part 18). Output: checks for overlap with existing categories, suggests cleaner naming if vague, flags if the suggestion doesn't fit the "local service" model at all.

**Rule for all AI features:** never build a general-purpose chatbot or any AI feature without a direct tie to a flow already defined in this document. Never gate trust- or matching-related AI behind a paid tier; when the feature is enabled, it behaves consistently for every eligible user regardless of payment status.

AI output is untrusted display data: validate its shape, escape/render it as plain text, do not execute suggested actions, do not send secrets or identity documents, and label it as AI-generated. Admin decisions remain human decisions.

---

## PART 22 — PAYMONGO INTEGRATION NOTES

- **ServiceHub uses PayMongo Test Mode only during development and defense.** Test activity does not move real money.
- **ServiceHub does not use or implement a PayMongo escrow product.** `PAID_HELD` is only the application's simulated ledger state; UI and documentation MUST NOT imply that ServiceHub, PayMongo, or a regulated escrow institution legally holds real funds for this capstone.
- Real provider payouts, withdrawal, revenue splitting, and commission collection are not implemented in the capstone integration. Available Balance is a simulated application ledger and includes only released online test earnings, never onsite-cash history.
- PayMongo's current refund API applies to live paid transactions, while this capstone is restricted to Test Mode. Therefore the capstone persists an idempotent `SIMULATED_TEST_MODE` reversal in its internal ledger and must not claim that PayMongo moved money. A future Live Mode refund would require server-side provider verification and a separate production-readiness review.
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

Public, unauthenticated explainer page. Sections in order: Navbar → Hero (what/where/why-safe) → Problem section → How It Works for Seeker → How It Works for Provider → Queue Explainer → Trust & Safety → Comparison table → Community Hub preview (illustrative, not live data) → FAQ → Dual CTA → Footer. The queue explanation must say it applies only to successfully online-paid work; onsite cash requests do not join it.

The Queue Explainer MUST include: **“Your queue position is FCFS within this specific service. Providers can offer several services but may perform only one active job at a time.”** It must label wait times as estimates and must not imply that positions in different service listings are comparable.

Copy rules: plain conversational language, no invented statistics, never say "bidding," always state "Cordova, Cebu" near the top and in the footer, never imply the queue is available for cash payments.

---

## PART 25 — KNOWN LIMITATIONS (DOCUMENT, NOT NECESSARILY BUILD FURTHER MITIGATION)

- Two-account collusion for trust score farming — mitigated by self-transaction blocking (Part 16); full prevention needs admin pattern-monitoring, documented as future work.
- Cold-start problem (marketplace needs both seekers and providers to have value) — addressed via a phased rollout plan (recruit verified providers in high-demand categories within specific barangays first), not a technical fix.
- Creative/digital services stretch the onsite mental model. They may use project pricing, messaging, and file sharing, but the 15-minute–8-hour estimated-duration field remains a work estimate rather than a multi-day delivery guarantee. Longer turnaround expectations belong in the listing and agreed schedule; richer milestone delivery is future scope.
- Queues remain per service listing, while provider-wide Start Job locking prevents simultaneous work. A provider chooses which listing's eligible first customer to serve next but cannot skip within that listing. Positions across listings are not comparable, and wait estimates remain approximate when the provider has demand across several listings; a future provider-wide scheduling forecast could improve estimates without weakening the one-ongoing-job rule.
- Listings are reusable, but every Booking is independent. Repeat requests do not create subscriptions or guaranteed calendar reservations.

---

## PART 26 — DATA MODEL SUMMARY

```
USERS — id, name, email, password_hash?, phone, location, role (USER|ADMIN),
        trust_score, verification_status,
        moderation_status (ACTIVE|SUSPENDED|BANNED), is_active,
        email_verified, created_at, updated_at

REFRESH_TOKENS — id, user_id, token_hash, expires_at, revoked_at?,
        replaced_by_token_id?, created_at
EMAIL_VERIFICATION_TOKENS — id, user_id, token_hash, expires_at, used_at?,
        created_at
PASSWORD_RESET_TOKENS — id, user_id, token_hash, expires_at, used_at?,
        created_at
OAUTH_IDENTITIES — id, user_id, provider, provider_subject,
        provider_email, created_at; unique (provider, provider_subject)

SERVICE_VERIFICATIONS — id, user_id, status, privacy_notice_version,
        consented_at, submitted_at, reviewed_at, admin_id, admin_notes
VERIFICATION_PROOFS — id, verification_id, private_object_key, document_type,
        uploaded_at

CATEGORIES — id, name, is_active
CATEGORIES_SUGGESTED — id, submitter_id, name, description, status, submitted_at

SERVICES — id, provider_id, category_id, title, description, price?,
        price_type, service_type, estimated_duration_mins, queue_limit,
        payment_methods (json), status, is_available, created_at, updated_at

DIRECT_REQUESTS — id, seeker_id, provider_id, service_id, agreed_price,
        selected_payment_method (cash), schedule?, message?,
        status (PENDING_APPROVAL|ACCEPTED|DECLINED),
        created_at, updated_at

SERVICE_REQUESTS — id, seeker_id, category_id, title, description,
        budget_min, budget_max, urgency,
        status (OPEN|PAYMENT_PENDING|IN_PROGRESS|CLOSED|CANCELED), created_at

OFFERS — id, request_id, provider_id, service_id, offered_price,
        estimated_duration, availability, message,
        status (PENDING|PENDING_PAYMENT|ACCEPTED|REJECTED|WITHDRAWN),
        payment_hold_expires_at, created_at

PAYMENT_ATTEMPTS — id, seeker_id, service_id, offer_id?, provider_intent_id,
        provider_payment_id?, amount, currency, method, status
        (PENDING|SUCCEEDED|FAILED|REFUND_REQUIRED|REFUNDED),
        idempotency_key, failure_reason?, created_at, updated_at
        unique provider_intent_id and idempotency_key

PROCESSED_WEBHOOK_EVENTS — id, provider, provider_event_id, event_type,
        payload_hash, status (PROCESSING|PROCESSED|FAILED), attempt_count,
        last_error?, processed_at?, created_at, updated_at
        unique (provider, provider_event_id)

BOOKING — id, seeker_id, provider_id, service_id,
        origin_type (DIRECT_LISTING|OFFER), offer_id?, direct_request_id?,
        payment_attempt_id?, payment_method, payment_status, agreed_amount,
        status, status_before_dispute?, started,
        scheduled_date? (legacy), scheduled_time? (legacy),
        canceled_by?, cancellation_reason?, canceled_at?, created_at, updated_at

QUEUE — id, service_id, booking_id, position, status, joined_at, estimated_wait
QUEUE_NOTIFY — id, service_id, seeker_id, requested_at

CANCELLATION_REQUESTS — id, booking_id, requested_by, responder_id, reason,
        status, responder_note, admin_note, admin_id?, created_at, resolved_at

COMPLETION_ESCALATIONS — id, booking_id, requested_by_provider_id, status,
        admin_id?, resolution (KEEP_AWAITING|REFUND_SEEKER|
        RELEASE_PROVIDER_AND_COMPLETE)?, admin_note?, created_at, resolved_at

COMPLETED_SERVICES — id, booking_id, seeker_id, provider_id, final_price,
        payment_status, completed_at

REVIEWS — id, completed_service_id, author_id, target_id, rating, text,
        tags (json), editable_until, hidden_at?, created_at, updated_at

REPORTS — id, booking_id, reporter_id, reported_user_id,
        report_type (COMPLETION_DISPUTE|SAFETY), reason, description,
        evidence_private_key?, dedupe_key?, status, resolution?, admin_id?,
        admin_notes?, resolved_at?

MESSAGES — id, booking_id, sender_id, receiver_id, content, image_private_key?,
        is_read, created_at

NOTIFICATIONS — id, user_id, title, body, link?, event_key?, is_read, created_at

TRANSACTIONS — id, type, amount, status,
        settlement_source (ONLINE_LEDGER|EXTERNAL_CASH), related_booking_id,
        wallet_owner_id, idempotency_key, created_at

PAYMENT_REFUNDS — id, booking_id, payment_attempt_id, provider_refund_id?,
        amount, status, reason, requested_by_admin_id?, idempotency_key,
        failure_reason?, created_at, updated_at

TRUST_SCORE_EVENTS — id, user_id, event_key, delta, reason, score_before,
        score_after, actor_admin_id?, created_at

ADMIN_AUDIT_LOGS — id, actor_id, action, resource_type, resource_id?,
        target_user_id?, reason, metadata?, created_at

ANNOUNCEMENTS — id, author_admin_id, title, body, is_published,
        published_at?, created_at, updated_at

AI_REVIEW_SUMMARIES — id, provider_id, review_version, review_count,
        deterministic_summary, refined_summary?, generated_at
```

### Canonical enums and invariants

- Booking status: `PENDING_APPROVAL | ACCEPTED | ONGOING | AWAITING_CONFIRMATION | DISPUTED | COMPLETED | DECLINED | CANCELED | REMOVED`. Waiting position belongs to Queue, so `WAITING` is not a Booking lifecycle state in specification v2.3.
- Queue status: `WAITING | SERVING | DONE | CANCELLED | REMOVED`.
- Online payment status: `PAID_HELD | FROZEN_HELD | RELEASED | REFUNDED`. Cash uses `UNPAID | CASH_CONFIRMED` only.
- A Booking has exactly one commercial origin: `DIRECT_LISTING` or `OFFER`. `service_id` is always present. Flow A uses `DIRECT_LISTING`, requires no `offer_id`, and may have one `direct_request_id` only for the cash provider-approval path. Flow B uses `OFFER`, requires `offer_id`, and has no `direct_request_id`. A DirectRequest never replaces the required service link or Booking lifecycle.
- Account moderation is `ACTIVE | SUSPENDED | BANNED`. `moderation_status` enforces marketplace restrictions; `is_active=false` is permitted for final deactivation only when doing so cannot strand a nonterminal obligation or held payment.
- Every User must have either a password hash or at least one verified OAuthIdentity. OAuth-only accounts may set a password only through a re-authenticated verification/reset flow.
- A Booking may have at most one active Queue row, CompletedService, and PaymentRefund. A PaymentAttempt/provider payment may produce at most one Booking.
- A Booking may have at most one active CancellationRequest and one active CompletionEscalation. Only its provider may create the latter after the server-calculated 72-hour threshold. A duplicate active escalation returns the existing row; after `KEEP_AWAITING`, the next eligibility threshold is 72 hours from the previous `resolved_at`.
- A Booking may have at most one unresolved `COMPLETION_DISPUTE` Report. Duplicate submissions return the current case; distinct `SAFETY` reports remain possible subject to authorization, rate limits, and identical-incident deduplication.
- A PayMongo webhook event identifier may be processed once. Retrying a failed handler resumes/reconciles the same ProcessedWebhookEvent rather than applying its business effects again.
- Every new Booking is an independent `ONE_TIME` engagement. A listing remains reusable after a terminal Booking. Historical `SESSION_BASED`/`PER_SESSION` records are migration inputs, not supported product choices.
- Direct Booking implies an eligible price type from Part 7. Every Booking has a positive immutable `agreed_amount`; `CUSTOM` and other quote-required listing values never become payment amounts without an accepted Offer.
- `started=false` for `PENDING_APPROVAL` and `ACCEPTED`; only Start Job produces `ONGOING, started=true`.
- A provider may have at most one `ONGOING` Booking globally. Enforce Start Job under a provider-scoped lock; service-scoped queue checks still apply.
- New marketplace relationships require `email_verified=true` and `verification_status=APPROVED`; existing engagements remain resolvable as defined in Part 4.
- `COMPLETED` implies exactly one CompletedService. `DISPUTED` implies an unresolved Report. Online `DISPUTED` implies `FROZEN_HELD`.
- Each CompletedService produces exactly one provider `+3` completed-service TrustScoreEvent. The unique event key prevents duplicate awards across seeker, Admin, cash, online, or retry paths; refunds/cancellations produce none.
- A Flow B Booking in a nonterminal state implies ServiceRequest `IN_PROGRESS`; completed implies `CLOSED`; canceled after matching implies `CANCELED`. Rejected sibling offers remain terminal.
- Database foreign keys, unique/check constraints where supported, and transactional application checks MUST enforce these invariants. Frontend hiding is never sufficient.

### Account moderation lifecycle table

| From | Admin event | To | Required side effects |
|---|---|---|---|
| `ACTIVE` | suspend with reason | `SUSPENDED`, `is_active=true` | enter restricted mode; block new relationships/Start Job; audit and notify; reconcile unstarted obligations safely |
| `ACTIVE` or `SUSPENDED` | ban with reason | `BANNED`, temporarily `is_active=true` when required | permanently block new activity; retain restricted resolution access; audit and notify |
| `SUSPENDED` | restore with reason | `ACTIVE`, `is_active=true` | restore normal eligibility subject to all other gates; audit and notify |
| `BANNED` with outstanding obligations | Admin/participants resolve cases | unchanged | cancel/refund/release/complete/dismiss/restore through existing idempotent outcomes; never transfer or delete history |
| `BANNED` with no outstanding obligation or held payment | finalize deactivation | `BANNED`, `is_active=false` | revoke sessions, deny authentication, audit final decision |

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

### Version 2.3 migration and implementation rules

- Existing Booking `WAITING` rows with an active Queue `WAITING` row migrate to Booking `ACCEPTED`; the Queue retains `WAITING`.
- Existing Booking `UNDER_REVIEW` rows tied to unresolved reports migrate to Booking `DISPUTED`; Report may be `UNDER_REVIEW`.
- Existing cash completions recorded as payment `RELEASED` migrate to `CASH_CONFIRMED`, and cash earnings must not count toward online Available Balance.
- Existing Flow B offers/bookings must be backfilled with a valid provider-owned service link before they can enter a queue or take a new payment.
- Reconcile any provider who currently has multiple `ONGOING` Bookings before enabling the provider-global Start Job guard.
- Normalize legacy `SESSION_BASED` listings to `ONE_TIME` and `PER_SESSION` prices to `FIXED`; preserve existing Booking amounts and legacy schedule columns as immutable historical data.
- Backfill Flow B terminal requests from their linked Booking where determinable; ambiguous records require an audited manual decision rather than automatic offer resurrection.
- Add hashed auth-token records, processed-webhook deduplication, and CompletionEscalation with the uniqueness/expiry rules above.
- Preserve the implemented DirectRequest relation for Flow A cash and document it consistently. Do not remove `direct_request_id` or its records without a separate audited migration that first replaces every active read/write path and preserves history.
- Reconcile existing suspended/banned accounts before adopting restricted mode. Do not blindly reactivate an account: establish `moderation_status`, inspect outstanding obligations, and choose `is_active` through an audited administrative decision.
- Existing verification submissions without recorded notice acknowledgement remain historical; do not fabricate consent timestamps. Require the current notice acknowledgement for every new or resubmitted verification after the v2.2 migration.
- Add transactional/unique protections for one active CompletionEscalation, one unresolved completion dispute, and one completed-service trust event. Backfill or resolve duplicates through an audited reconciliation before enabling constraints.
- Deploy enum/schema migrations, transactional service changes, and regression tests together. Do not partially deploy a new state machine.


---

## PART 27 — CAPSTONE SCOPE AND STABILIZATION PRIORITY

The system already contains more surface area than a typical three-month capstone. Do not add a new major subsystem while a defense-critical flow is broken, untested, or contradicted by this document. Existing stable secondary features do not need deletion; they simply must not distract from or block the core demonstration. Audit what is already stable before implementing gaps; do not blindly rebuild every Tier 0 subsystem.

### Tier 0 — defense-critical and release-blocking

1. Authentication, hashed refresh rotation, logout/session invalidation, enforced email-verification gate, password reset, and `ACTIVE|SUSPENDED|BANNED` restricted-resolution behavior that cannot strand obligations or funds.
2. Residency verification, private proof handling, current privacy-notice acknowledgement, limited-mode gating, retention/deletion handling, and admin decision/access audit logs.
3. Service creation, validation, moderation, and safe browsing.
4. Flow A and Flow B, exact-price eligibility, immutable agreed amount, and complete ServiceRequest terminal behavior.
5. PayMongo Test Mode webhook verification/deduplication, idempotency, simulated hold, release, refund, and reconciliation.
6. Listing-specific `ONE_TIME` FCFS invariants, provider-global one-ongoing guard, Start Job, Mark Completed, cancellation, queue recalculation, and honest estimated-wait wording.
7. Completion confirmation/report deduplication, no-response CompletionEscalation cooldown/idempotency, and all explicit admin settlement outcomes.
8. Booking-scoped text messaging and durable notifications with secure realtime invalidation.
9. CompletedService separation, bilateral reviews, and deterministic trust events.
10. Admin authorization, pagination, redaction, moderation, and immutable auditing.
11. One instructor-required AI Review Summarizer with a fast deterministic fallback; Gemini latency or failure must not block the surrounding page.

Any known Tier 0 failure must be fixed before visual polish or bonus AI work.

### Tier 1 — supported when stable, not required in the primary defense path

- Optional third-party calendar integration (future only; not needed for repeat requests)
- QueueNotify waitlist
- Category suggestions
- Message images and read receipts
- Community announcements, statistics, and weekly leaderboard
- Google OAuth, provided credentials/origins are correctly configured; password login remains the dependable fallback
- Public landing page and help content

### Tier 2 — optional/future; may be hidden or documented instead of demonstrated

- AI Service Matching and all AI moderation/category assistants
- Wallet withdrawal, commissions, subscriptions, paid boosts, or real-money operation
- Provider-wide scheduling forecasts beyond the required one-ongoing-job safety guard
- Automatic recurring contracts or calendar synchronization
- Automated two-account collusion detection

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
  5. final deactivation cannot occur while a nonterminal Booking or held payment remains;
  6. FCFS order cannot be skipped within a service listing;
  7. queue positions from different services are not treated as a global queue;
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

These are cross-cutting requirements, not optional features:

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

## INSTRUCTIONS FOR THE AI READING THIS DOCUMENT

1. Read this entire document fully before writing or modifying any code.
2. Treat specification version 2.3 as authoritative. Older comments or documents lose when they conflict with its state tables and invariants.
3. If the current codebase violates a rule above, report the affected flow and migration/test impact. When the user's request authorizes implementation, fix it without weakening another invariant. Schema/state-machine changes require migrations and regression tests; never silently reinterpret persisted states.
4. If a request from the user conflicts with this document, point out the conflict. If the user confirms the new decision, update this document in the same change so it remains the source of truth.
5. For new behavior, separate lifecycle stages, enforce authorization and invariants server-side, make external-event handling idempotent, and prefer the smallest approach that satisfies Tier 0.
6. Do not claim “production ready” solely because builds pass. Use Part 27's defense release gate and report any unverified item honestly.
7. Version 2.3 defines target product behavior; it does not prove the current code already implements every amendment. Audit the affected schema, authorization, lifecycle, and tests before claiming alignment, and preserve the implemented DirectRequest flow unless a separately authorized migration replaces it safely.

### Version 2.0 foundation decisions

- Retained Next.js instead of mandating a high-risk Vite migration.
- Defined `USER`/`ADMIN` account roles and Seeker/Provider workspaces.
- Replaced real-escrow wording with an accurate PayMongo Test Mode simulated hold.
- Made provider Start Job the only transition that starts work.
- Made Queue status/position authoritative and retained historical rows for traceability.
- Historically separated one-time queueing from scheduled session bookings; Version 2.3 supersedes that design with reusable one-time listings.
- Added a safe Flow B payment-pending state so failed payments do not reject sibling offers.
- Required offers to reference a service listing.
- Defined explicit dispute outcomes, money direction, cash settlement, and idempotency.
- Defined bilateral reviews, private trust values, realtime fallback rules, sensitive-upload rules, and capstone scope tiers.

### Version 2.1 correctness amendments

- Added a provider-global one-`ONGOING` guard while retaining listing-specific queue order/capacity.
- Defined which pricing types can produce an exact direct payment and made `Booking.agreedAmount` immutable.
- Added an enforced email-verification gate without trapping existing engagements or held funds.
- Defined Flow B request behavior after failed payment, booking creation, completion, and cancellation; rejected offers are never resurrected.
- Made after-start cancellation explicitly available to either participant with the other participant as responder.
- Added a neutral CompletionEscalation record and 72-hour admin workflow for seeker non-response.
- Added auth-token, OAuth identity, processed-webhook, and then-proposed session-slot records plus `PAYMONGO_WEBHOOK_SECRET`; the session-slot proposal is superseded by Version 2.3.
- Required a valid five-review defense dataset so the instructor-required Gemini integration is actually demonstrated.

### Version 2.2 correctness amendments

- Defined `ACTIVE|SUSPENDED|BANNED`, restricted engagement resolution, and safe final deactivation without booking transfer or trapped held funds.
- Clarified that FCFS is guaranteed within each service listing while provider work concurrency remains global.
- Preserved and canonically documented the implemented DirectRequest relation for Flow A cash rather than removing it from the specification.
- Defined CompletionEscalation duplicate behavior and the additional 72-hour cooldown after `KEEP_AWAITING`.
- Prevented duplicate unresolved completion disputes while preserving genuinely distinct safety reports.
- Replaced ambiguous completion trust wording with the existing provider `+3` event exactly once per CompletedService.
- Added current privacy-notice acknowledgement, immutable submission metadata, and private-proof retention/deletion rules.
- Replaced broad PayMongo product/fee claims with capstone-specific Test Mode, simulated-ledger, and future Live Mode review requirements.

### Version 2.3 scope simplification

- Removed session-based scheduling and `PER_SESSION` pricing from the supported product surface.
- Defined every Booking as one independent engagement while keeping its approved Service listing reusable.
- Added repeat-request behavior after terminal bookings without introducing subscriptions or calendar reservations.
- Defined provider acceptance and optional non-reserved schedule proposals for Flow A cash requests.
- Retained legacy enum/column values only for backward-compatible migration and historical reads.

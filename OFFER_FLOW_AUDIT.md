# Provider offer flow audit

Date: 2026-10-02

Correction, 2026-10-05: the provider-only metadata discussed below was not a
supported choice in Post Request. That form broadcasts a public job and never
assigns a provider. Treating the old door record as intentionally private was an
incorrect inference. The global public-request visibility fix clears all such
obsolete restrictions, prevents new provider-only records with a database check,
and reserves privacy restrictions for genuine selected-listing inquiries.
The historical analysis below describes the earlier state, not the current policy.

## Root cause and actual account comparison

**A provider does not need an existing service listing to submit a custom Flow B offer.** Turning off a listing must not block an offer submitted with “No listing.”

The failing door request (`cmumicjr30001v0jvhtpdeqyt`) was OPEN and assigned to Buenaflor Ian Mark, but had no assigned listing:

```text
targetProviderId = Buenaflor Ian Mark's account ID
targetServiceId = null
submitted serviceId = undefined (No listing)
```

The old condition combined the assigned-provider and assigned-listing checks:

```ts
request.targetProviderId && (
  request.targetProviderId !== providerId ||
  request.targetServiceId !== serviceId
)
```

The provider matched. However, `null !== undefined` is true, so a valid custom offer was incorrectly rejected with “This booking inquiry is reserved for its listed provider and service.”

Read-only inspection of the actual application database established:

| Check | Buenaflor Ian Mark, failing direction | John Vincent, working reverse direction |
| --- | --- | --- |
| Database display name | BUENAFLOR IAN MARK J. | john sefuesca |
| Account | Active, marketplace member | Active, marketplace member |
| Moderation | ACTIVE; no posting suspension | ACTIVE; no posting suspension |
| Email / residency | Verified / APPROVED | Verified / APPROVED |
| Relevant listing | Carpentry listing inactive and unavailable | Electrical listing inactive and unavailable |
| Request targeting | Assigned to Ian, listing absent | No assigned provider or listing |
| Offer evidence | Old comparison falsely rejected the omitted listing | Three inspected electrical offers were stored with `serviceId = null` |

Both accounts were eligible. John's electrical test bypassed the broken comparison because that request had no assigned provider. The difference was request targeting metadata, not a requirement to own or enable a listing.

The corrected target and participant checks passed against the actual failing account and request using read-only queries. No offer was submitted from either live account during this audit. An isolated regression test reproduces the failing provider-only request, including its SQL NULL listing and payment fields, and successfully creates a custom offer.

## Changes

### Submission and safeguards

- Split provider targeting and listing targeting into independent checks. An absent `targetServiceId` imposes no listing requirement.
- Keep custom price, duration, availability and message available without a listing. Add the missing optional availability field to the proposal form.
- Preserve specific-listing inquiry restrictions when the seeker actually selected a particular listing. Public and provider-only requests continue to allow custom offers without one.
- Validate a listing's owner, category and availability only when it is selected. For a public/provider-only request, an unavailable listing error explains that the provider can choose “No listing.”
- Preserve self-offer prevention, verified participant requirements, active account requirements, request lifecycle checks, fulfilled-request checks and database uniqueness constraints.
- Add clear eligibility errors for banned, suspended, inactive, admin, email-unverified and residency-unverified accounts. Preserve safe error codes through the HTTP error handler.
- Correct the offer controller's obsolete Zod `.errors` usage to Zod 4 `.issues`, with field-specific validation messages.
- Keep one active offer per provider/request. Duplicate submissions remain blocked by the request transaction lock and existing partial unique index.

### Form and confirmed updates

- Guard submission before React rerenders; disable the form and dismissal controls while sending; display the sending spinner and label.
- Keep the draft after a failed submission. Close the modal only after confirmed success.
- Update local state from the server's returned offer and refresh the submitting provider as well as the seeker through `OFFERS_CHANGED`.
- Recover an ambiguous network/server response by reading the provider's offers and confirming an exact matching pending proposal. A different existing offer is not reported as this submission's success.
- Apply confirmed decline/withdrawal responses immediately. A later background refresh failure no longer turns a successful decision or selection into a misleading failure toast.

### Explicit decline and persistent history

The old decline path changed the offer status without creating a persistent provider notification.

- Record the explicit decline and its provider notification in the same locked database transaction.
- Use `offer-declined:<offerId>` as the unique notification ID. Concurrent clicks and retries create one notification and emit one notification event.
- Notify both participants of the committed offer state. Notification storage does not depend on an online socket, so the record remains available when the provider returns.
- Keep withdrawal as `WITHDRAWN`, separate from seeker decline. Withdrawal produces no false decline notification and allows a later valid submission.
- Keep closed offers in provider activity, including offers on canceled requests. Notification links open the “All” activity view and identify the affected offer.
- Distinguish an explicit decline (`DECLINED`) from another offer being selected (`NOT_SELECTED`) in refreshed provider data and UI copy. Older rejected offers without a recorded reason retain generic declined copy.

### Payment and lifecycle states

- Preserve `PENDING_PAYMENT` instead of mapping it back to ordinary pending. Payment holds disable invalid selection, decline and withdrawal controls.
- Refresh the chosen provider and seeker after a committed hold, setup failure, payment failure or expiry. Existing cache invalidation and focus/reconnect refresh paths remain in use.
- Preserve Cash sibling rejection only when the booking transaction commits.
- Preserve GCash sibling rejection only when the authoritative successful-payment finalizer commits. Checkout initiation and a browser return alone do not declare a winner.
- Failed or expired GCash reopens the selected offer/request without producing losing-offer notifications.
- Keep `offer-not-selected:<offerId>` notifications separate from explicit decline notifications, with useful activity links. Payment replay does not duplicate sibling outcomes or notifications.

No database migration is needed for these fixes. `Offer.serviceId` is already nullable, and the existing partial unique indexes for active provider offers and selected offers remain intact.

## Verification

| Verification | Result |
| --- | --- |
| Focused frontend tests, 8 files | 62 passed |
| Backend contract/schema tests (`npm test`) | 68 passed |
| Fresh-schema offer lifecycle integration test | 19 scenarios passed; Node reports 20 tests including the parent |
| Backend TypeScript (`tsc --noEmit`) | Passed |
| Frontend TypeScript (`tsc --noEmit`) | Passed |
| ESLint for touched frontend files | Passed |

The integration runner migrated a fresh isolated schema, exercised real database transactions and constraints, then removed the schema. It left the shared application schema untouched. Final passing log: `.audit-results/audit_20260924_ad5fde047b904eb38d99568ff9ef9264.log`.

### Integration scenarios

1. Eligible provider with zero listings submits all custom offer fields.
2. Compatible active listing works as an optional shortcut.
3. Two eligible providers independently offer on the same public request.
4. Ian's provider-only request shape accepts an omitted listing.
5. Paused or unrelated listings do not prevent a listing-free offer.
6. Truly reserved listing inquiries retain provider/listing restrictions.
7. Self-offers remain blocked.
8. Banned, suspended, inactive, admin and unverified providers receive clear denials.
9. Concurrent duplicate submissions create one offer and one seeker notification.
10. Explicit decline is atomic, idempotent, durable without connected sockets and visible through both refreshed offer APIs.
11. Withdrawal remains distinct, creates no decline notification and permits resubmission.
12. Closed requests and unauthorized decisions remain blocked.
13. Cash selection produces one separate sibling losing notification.
14. GCash initiation preserves pending siblings and blocks decisions during the hold.
15. Authoritative GCash success finalizes siblings; replay is idempotent.
16. Failed GCash reopens the request without losing notifications.
17. Expired GCash reopens the request without losing notifications.
18. Invalid offer fields return readable Zod 4 validation errors.
19. New public requests have no inherited targeting and accept listing-free offers.

Frontend coverage also checks draft preservation, loading/duplicate-click behavior, optional availability, server-confirmed state updates, ambiguous-response recovery, distinct offer states/history and blocked payment-hold actions.

## Browser and realtime validation remaining

Automated payment tests stub PayMongo transport but use the real payment lifecycle and database finalizer. Socket tests verify the emitted rooms/events without connected browser clients. They establish durable storage and server emissions, not actual browser delivery.

The following end-to-end checks remain for manual review:

- Retry Ian's actual door offer with “No listing” after the running backend has loaded the updated code.
- Decline an offer while the provider is on another page, then check the toast, notification history, activity status and notification link.
- Repeat with the provider offline; reconnect and verify the stored notification and refreshed offer history.
- Exercise actual PayMongo Test Mode checkout, browser return and signed webhook delivery for success, failure and expiry.

Visual browser review was not performed. No live offer, booking or payment was created by this audit.

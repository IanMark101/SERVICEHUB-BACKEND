# Private GCash number in listing forms

Current behavior and release boundary: see CURRENT_SYSTEM.md. Dated implementation checks below retain their original scope. Generated review captures and logs removed during cleanup remain recoverable from the recorded pre-cleanup Git revisions.
Offer Services, Edit Service Listing and Post Request expose **Add GCash number** when GCash is selected. A small modal saves one account-wide number without navigating away, publishing a listing, changing the contact phone, or clearing a draft. Existing numbers are masked outside the modal and can be edited; removal is blocked while retained GCash listings or active public requests depend on them. The same account preference is available in either workspace and persists across sessions.

This field is **required when GCash is selected on a listing or public request**. Cash-only posting needs no number. It is not verified wallet ownership, a payout configuration, a public payment instruction, or a booking-specific snapshot. Hosted checkout still authenticates the paying wallet itself. Saving it does not send money or change current payment, booking, queue, refund or earnings behavior. Real provider payouts require a separate gateway integration; a mobile number alone cannot configure them.

## Storage and access

- `User.phone` remains the existing contact number, with its existing validation, active-engagement lock and password confirmation.
- `User.gcashNumber` is a nullable private scalar. No contact number is copied into it. Accepted `09…` and `+639…` inputs (with spaces/hyphens) are normalized to 11 digits starting with `09`. A database constraint enforces the stored format.
- Authenticated `GET /api/auth/gcash-number` returns `{ success: true, data: { gcashNumber: string | null } }` for the signed-in ordinary account only. `PUT` takes exactly `{ gcashNumber: string | null }`; it accepts no user ID, contact update, MPIN or OTP.
- Responses use `Cache-Control: no-store`; mutations are rate limited and recheck the active account and live session under the existing lifecycle locks.
- Public/auth profile projections deliberately omit the number. It does not enter listing, booking, payment, notification or socket payloads. The UI uses no local/session storage for it and aborts stale reads/writes on unmount/account changes.
- Removal is blocked while retained GCash listings or active public requests depend on the number. Switch them to Cash only first. Permanent account deletion removes the scalar with the user row.

## Migration and validation

Additive migration: `20261014020000_private_gcash_number`. Generate Prisma Client with `npm run db:generate`. For the recorded development endpoint, use `npm exec -- tsx scripts/migrate-development-gcash-number.ts`; it verifies both database URLs against the recorded development target and refuses unrelated pending migrations. Never reset a database for this change.

Rehearse all migrations and the preference lifecycle in an isolated disposable schema using `SERVICEHUB_GCASH_NUMBER_ONLY=1 npm run test:fresh-migrations` (in PowerShell, set `$env:SERVICEHUB_GCASH_NUMBER_ONLY='1'` first). Contract tests: `npm exec -- tsx --test src/schema/gcash-number.test.ts`. Frontend tests cover create/edit integration, validation, cancel, draft preservation, save failures/retry, duplicate prevention, removal, fresh loads, account switching and nested Escape behavior. Browser evidence uses intercepted API fixtures; it does not claim a live payment or verify ownership of a real GCash wallet.

Verified October 14, 2026: 57 frontend tests, 2 backend contract tests and 6 isolated integration tests passed. All 46 migrations replayed with no Prisma schema drift; the disposable schema was removed. The one new migration was then applied to the verified development database. Frontend targeted ESLint, frontend TypeScript, both production builds, and the scoped design detector passed. Intercepted browser checks covered both workspaces at 1440px light, 390px dark and 320px light: modal bounds, no horizontal overflow, focus trap/return, Back/Next draft preservation, a normalized preference save and zero listing writes. Browser results: `SERVICEHUB-FRONTEND/.impeccable/review/gcash-number-review.json`. A running backend may need restarting after Prisma Client regeneration. Production payout behavior was not changed or exercised.

## Required for GCash listings

Offer Services, Edit Service Listing and Post Request require a successfully loaded, valid saved number when GCash is selected. The create/update APIs repeat this check under the account lifecycle lock, using effective payment methods for edits. Cash-only listings need no number. Number removal checks retained service listings and active public requests under the same lock. No number is copied into public listing payloads or treated as a verified payout destination.

The shared listing modal uses the registration formatter with fixed +63, ten national digits starting with 9, digit grouping and input sanitization. Paste accepts national, 09 or +63 forms; saving sends the canonical 09 format to the existing strict API. Both workspaces and service editing share this control.

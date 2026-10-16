# Trust policy deployment

Current behavior and release boundary: see CURRENT_SYSTEM.md. Dated implementation checks below retain their original scope. Generated review captures and logs removed during cleanup remain recoverable from the recorded pre-cleanup Git revisions.
Policy v2 separates satisfaction ratings from trust points. Approved verification earns +5 once; eligible settled completions earn +3 per eligible participant, limited to one rewarded completion per account pair per rolling 30 days. Ratings earn zero. Documented at-fault cancellation after work starts deducts 5; documented serious misconduct deducts 10. A booking and participant can receive one trust penalty. Corrections reference an original event rather than an arbitrary delta.

The point weights and pair limit are initial policy settings, not validated probabilities or a guarantee of workmanship. Profile reviews are read-only: public replies and new review reports have been removed from the UI and API. The current member Trust History has no Appeal trust penalty button or new-appeal form. Existing cases, backend trust-event case compatibility and reasoned Admin moderation remain available; ban and content-removal appeals are separate workflows. Authors in previously submitted review disputes retain their private response opportunity; direct content moderation remains separately audited.

## Deploy together

1. Back up the database and stop the old backend while applying the policy migration. The old backend must not keep issuing review points during transition.
2. From `SERVICEHUB-BACKEND`, run `npm ci`, `npx prisma generate`, `npx prisma migrate deploy`, and `npm run build`.
3. Start the updated backend, then build and deploy the updated frontend. No new environment secrets are required.
4. Check account Trust History, an eligible completion, completed-booking review submission, read-only profile reviews, absence of new member penalty-appeal controls, existing case handling, and Admin Reviews/correction controls.

Migration `20261011120000_evidence_based_trust` adds the case/response/ledger fields. It preserves old history and records a policy adjustment by replaying non-review contributions with 0/100 clamping. Recognizable legacy review entries and duplicate booking penalties are excluded. Existing completion rewards remain recognized. Mutual completion rewards and the pair limit apply prospectively; there is no mass back-award to historical Seekers.

## Regression verification

Run `npm test` for backend contracts. In PowerShell, set `$env:SERVICEHUB_TRUST_POLICY_ONLY='1'` and run `npm run test:fresh-migrations`. The harness verifies its disposable schema target, applies the complete migration history, checks schema drift, runs the trust integration suite, and removes the schema. It does not migrate the application schema.

The frontend tests cover read-only profile reviews and retained responses, absence of the trust-penalty appeal control, existing-case responses, Admin decision controls, profile visibility and Help Center metadata. Historical appeal-form verification below describes the earlier October 12 interface. Both master prompts and Help Center articles are the corresponding policy references.

For the additional legacy-replay and 48-hour response safeguards, set `$env:SERVICEHUB_TRUST_POLICY_QUICK='1'` and repeat the fresh-migration command. Each invocation creates and removes its own isolated schema.

## Local validation ? October 12, 2026

- 170 backend contract checks and one additional correction-retry regression passed.
- 13 database integration checks passed across the main trust suite and focused security suite. Fresh deployment of all 40 migrations produced 37 tables with no Prisma schema drift.
- 37 targeted frontend checks, lint on changed UI files, and both production builds passed.
- Isolated member/admin form previews at 320px and 1280px passed in light/dark themes: no horizontal overflow, controls at least 44px tall, and mobile fields at 16px. Fictional preview data and temporary browser profiles were removed.
- At the time of these implementation checks, the application database and deployed website were not changed.

## Development database update — October 12, 2026

The configured `proximity-development` database has now received both pending migrations (`20261010003000_remove_category_suggestions` and `20261011120000_evidence_based_trust`). Prisma reports all 40 migrations applied, and the client has been regenerated. The existing `getMyEngagements` controller was verified with existing bookings, completed services, and reviews; the missing `reviews.response` error is resolved.

`npm run dev` starts the backend but does not apply database migrations. After pulling changes that include migrations, stop the backend, run `npx prisma migrate deploy` and `npm run db:generate` against the intended database, then start it again. This development database update did not deploy the production website or migrate a separate production database.

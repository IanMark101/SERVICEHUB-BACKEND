# ServiceHub Cordova Release Operations

Last updated: September 7, 2026

This runbook covers the supported capstone deployment: Next.js frontend, Express/Socket.io backend, PostgreSQL/Prisma, private Cloudinary evidence, Google OAuth, Gemini, and PayMongo Test Mode. It does not authorize Live Mode payments or real provider payouts.

## 1. Release gate

Do not deploy a release candidate unless all repository checks pass:

```powershell
# Backend
npm ci
npm run build
npm test
npm run test:booking-integration
npm run test:phase2-integration
npm run test:phase3-integration
npm run test:phase4-integration
npm run test:phase5-integration
npm run test:phase6-integration
npm run test:phase7-integration
npm run test:phase7-load
npx prisma validate
npx prisma migrate status
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
npm audit --omit=dev

# Frontend
npm ci
npx tsc --noEmit
npm run lint
npm test
npm run build
npm audit --omit=dev
```

Run `npm run test:fresh-migrations` only against a non-production database account that may create and drop a uniquely named schema. Never point fixture tests or seed scripts at production.

## 2. Environment and secrets

Keep secrets in the deployment provider's encrypted environment store, never Git. Required production-like variables are documented in each `.env.example`. Frontend `NEXT_PUBLIC_*` values are public by design; never place secret keys there.

- Use independent high-entropy access and refresh JWT secrets.
- Use PayMongo **test** public/secret keys and the webhook signing secret.
- Register the exact frontend origins in the Google OAuth web client.
- Restrict Cloudinary credentials and private verification assets to the backend.
- Remove one-time administrator bootstrap credentials after provisioning.
- Rotate a secret immediately if it appears in logs, screenshots, chat, or Git history.

## 3. Database backup and deployment

Before a migration:

1. Confirm the target database and environment aloud in the release record.
2. Stop background workers that can mutate lifecycle/payment records, or place the API in maintenance mode.
3. Create a provider snapshot or a `pg_dump` in custom format and record its timestamp, database, schema, Git commit, encryption, and retention location.
4. Run `prisma migrate status` and a schema diff. Investigate any unrecorded migration or drift before `migrate deploy`.
5. Review every pending SQL migration for table rewrites, destructive statements, locks, enum changes, and backfills.
6. Test the exact migration chain on a restored disposable database.
7. Apply `npx prisma migrate deploy` once, then require current migration status and zero drift.
8. Start the backend, check `/health`, then start the frontend and perform the smoke checklist below.

Never use `prisma db push`, `migrate reset`, or manual `_prisma_migrations` edits as a production deployment shortcut.

## 4. Restore procedure

1. Declare an incident and stop writes.
2. Preserve current logs and take a final snapshot if corruption is not spreading.
3. Create a new database/branch from the last verified backup; do not overwrite the damaged database first.
4. Restore the dump and verify row counts for users, services, bookings, queues, payment attempts, webhook events, transactions, notifications, messages, reports, and audit logs.
5. Run Prisma status/diff plus read-only lifecycle queries.
6. point a staging backend at the restored target and execute smoke tests.
7. Switch the production connection only after sign-off. Retain the previous database until the recovery window closes.

Record recovery point objective and recovery time from the exercise; neither is considered proven until a timed restore rehearsal succeeds.

## 5. Application rollback

- Prefer forward-compatible migrations and roll back application containers to the prior immutable Git commit/image.
- Do not reverse a data migration merely by deploying older code. Confirm the older application understands the current schema.
- If it does not, keep the new schema and ship a corrective migration, or restore the verified pre-migration database under the restore procedure.
- Clear no user data or payment history during rollback.
- Verify refresh sessions, Socket.io authentication, webhook processing, and administrator audit pages after rollback.

## 6. PayMongo webhook recovery

The only supported mode is Test Mode.

1. PayMongo must target a stable public HTTPS endpoint at `/api/payments/paymongo/webhook`.
2. The backend must verify the signature against the unmodified raw body and return a prompt 2xx only after safely recording/handling the event.
3. `processed_webhook_events` and unique payment-attempt/booking keys make replay idempotent. Never delete those records to force a retry.
4. On delivery failure, restore connectivity and allow PayMongo retries. For a manual replay, use the original event from the Test Mode dashboard and verify exactly one Booking and Queue row.
5. Inspect `REFUND_REQUIRED` attempts in Admin reconciliation. Retry through the explicit audited action; never edit payment status directly.
6. If signing credentials are suspected compromised, disable the endpoint, rotate the webhook secret in PayMongo and the backend environment, redeploy, then replay missed Test Mode events.

## 7. Smoke and defense rehearsal

After every deployment:

- `/health` returns 200 and includes no secret material.
- An unauthenticated protected endpoint returns one expected 401, not a retry loop.
- Password login, refresh, logout, and one Seeker/Provider workspace switch work.
- Admin overview counts link to matching database-backed inventories.
- One onsite-cash request can be accepted, started, marked complete, and confirmed.
- A message and notification arrive once in the correct participant room.
- Closed conversations are read-only and historical records remain visible.
- Browser/server logs show no unexplained 4xx/5xx loop, duplicate socket listener, unhandled rejection, or raw stack trace.

When external access is available, separately record Google OAuth authorized-origin proof and one Flow A plus one Flow B PayMongo Test Mode checkout/webhook/refund proof.

## 8. Monitoring and incident signals

Monitor request IDs, structured 5xx logs, login/refresh 401 rates, rate-limit 429 rates, Socket.io connect/disconnect churn, webhook verification failures, `REFUND_REQUIRED` counts, stale `PENDING` payment attempts, queue position anomalies, unresolved reports/escalations, and notification delivery lag. Logs must not contain tokens, cookies, passwords, private proof URLs, gateway keys, or full sensitive documents.

Single-process in-memory rate limiting and Socket.io delivery are acceptable only for the capstone's single backend instance. A multi-instance deployment requires a shared rate-limit store, shared Socket.io adapter, and durable outbox/retry processing.

## 9. Known limitations

- Google OAuth origin ownership and PayMongo Test Mode webhook configuration are external manual gates.
- Real money, Live Mode, escrow/custody, provider payouts, withdrawal, commission, and subscription features are unsupported.
- Session scheduling and recurring services are intentionally absent. Each request is an independent one-time Booking.
- A preferred onsite-cash schedule is proposal text, not a collision-safe reservation.
- Socket notifications are best-effort; durable notification records are authoritative.
- Cross-instance realtime delivery, shared throttling, disaster-restore timing, independent penetration testing, and browser performance budgets remain unproven until their dedicated deployment tests are run.
- The populated development database currently has five unrecorded migrations and real schema drift. Do not run a deployment migration until the owner explicitly approves the inspected normalization and a backup exists.

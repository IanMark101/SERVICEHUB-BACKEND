import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import app from "../app";
import { env } from "../config/env";
import { deleteOwnAccount, getAccountDeletionEligibility, purgePreviouslyDeletedAccount } from "../services/account-deletion.service";
import { Prisma } from "@prisma/client";
import { VERIFICATION_PRIVACY_NOTICE_VERSION } from "../config/privacy";
import { summarizeProviderReviews } from "../services/ai.service";
import { createService, toggleServiceAvailability } from "../services/services.service";
import { updateRequest } from "../services/requests.service";
import { lockAccountLifecycle } from "../services/account-lifecycle.service";

test("self-service hard deletion: obligations, credentials, dependent data, isolation, and races", async t => {
  const tag = `deletion-qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ids: string[] = [];
  let categoryId = "";
  const password = "Fixture-password-2026!";
  const hash = await bcrypt.hash(password, 4);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const scope = { OR: [{ seekerId: { in: ids } }, { providerId: { in: ids } }] };
    const bookings = await prisma.booking.findMany({ where: scope, select: { id: true } });
    await prisma.report.deleteMany({ where: { bookingId: { in: bookings.map(item => item.id) } } });
    await prisma.cancellationRequest.deleteMany({ where: { bookingId: { in: bookings.map(item => item.id) } } });
    await prisma.adminResolutionOperation.deleteMany({ where: { bookingId: { in: bookings.map(item => item.id) } } });
    const attempts = await prisma.paymentAttempt.findMany({ where: scope, select: { id: true } });
    await prisma.paymentRefund.deleteMany({ where: { OR: [{ requestedById: { in: ids } }, { bookingId: { in: bookings.map(item => item.id) } }, { paymentAttemptId: { in: attempts.map(item => item.id) } }] } });
    await prisma.completedService.deleteMany({ where: scope });
    await prisma.queue.deleteMany({ where: scope });
    await prisma.booking.deleteMany({ where: scope });
    await prisma.offer.deleteMany({ where: { OR: [{ providerId: { in: ids } }, { request: { seekerId: { in: ids } } }] } });
    await prisma.serviceRequest.deleteMany({ where: { seekerId: { in: ids } } });
    await prisma.service.deleteMany({ where: { providerId: { in: ids } } });
    await prisma.contentModerationEvent.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.contentModerationCase.deleteMany({ where: { submitterId: { in: ids } } });
    await prisma.paymentAttempt.deleteMany({ where: scope });
    await prisma.aiReviewSummary.deleteMany({ where: { providerId: { in: ids } } });
    await prisma.accountDeletionRequest.deleteMany({ where: { userId: { in: ids } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    if (categoryId) await prisma.category.delete({ where: { id: categoryId } });
    await prisma.$disconnect();
  });
  const user = async (name: string, role = "user") => {
    const created = await prisma.user.create({ data: { name, email: `${tag}-${ids.length}@example.test`, passwordHash: hash, phone: "", location: "Cordova", role, emailVerified: true, verificationStatus: "APPROVED" } });
    ids.push(created.id); return created;
  };
  const owner = await user("Deletion QA owner");
  const other = await user("Deletion QA partner");
  const racer = await user("Deletion QA concurrent provider");
  const admin = await user("Deletion QA admin", "admin");
  const unrelated = await user("Deletion QA unrelated participant");
  const category = await prisma.category.create({ data: { name: tag, isActive: true } }); categoryId = category.id;
  const sessions = await Promise.all([0, 1].map(index => prisma.refreshToken.create({ data: { userId: owner.id, token: `${tag}-session-${index}`, expiresAt: new Date(Date.now() + 300_000) } })));
  const bearer = (id: string, sessionId: string, role = "user") => jwt.sign({ sub: id, sid: sessionId, role }, env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${bearer(owner.id, sessions[0].id)}` };
  const send = (body: unknown) => fetch(`${base}/users/me/account-deletion`, { method: "POST", headers, body: JSON.stringify(body) });

  assert.equal((await send({ confirmation: "DELETE" })).status, 400, "the old confirmation-only API cannot delete");
  assert.equal((await send({ confirmation: "DELETE", method: "password", password: "wrong-password" })).status, 403);
  assert.equal((await send({ confirmation: "DELETE", method: "password", password, userId: other.id })).status, 400, "a target override is rejected");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).isActive, true);
  assert.equal(await prisma.refreshToken.count({ where: { userId: owner.id } }), 2);

  const listing = await prisma.service.create({ data: { providerId: owner.id, categoryId, title: "Home repair assistance", titleNormalized: "home repair assistance", description: "Help with small home repairs in Cordova.", price: 500, priceType: "FIXED", estimatedDurationMins: 30, paymentMethods: { cash: true, gcash: false }, status: "ACTIVE", isAvailable: true } });
  const request = await prisma.serviceRequest.create({ data: { seekerId: owner.id, categoryId, title: "Repair a kitchen cabinet", description: "Please repair the loose cabinet door hinge.", budgetMin: 100, budgetMax: 500, urgency: "This week" } });
  const blockedResponse = await send({ confirmation: "DELETE", method: "password", password });
  assert.equal(blockedResponse.status, 409);
  const blocked = await blockedResponse.json() as any;
  assert.equal(blocked.data.counts.activeListings, 1); assert.equal(blocked.data.counts.openRequests, 1);
  await toggleServiceAvailability(listing.id, owner.id);
  await updateRequest(request.id, owner.id, { status: "CLOSED" });
  assert.equal((await getAccountDeletionEligibility(owner.id)).eligible, true);

  const booking = await prisma.booking.create({ data: { seekerId: other.id, providerId: owner.id, originType: "DIRECT_LISTING", serviceId: listing.id, agreedAmount: 500, paymentMethod: "GCash", paymentStatus: "PAID_HELD", status: "WAITING" } });
  const queue = await prisma.queue.create({ data: { providerId: owner.id, seekerId: other.id, serviceId: listing.id, bookingId: booking.id, paymentId: `${tag}-payment`, position: 1, estimatedWait: 30, status: "WAITING" } });
  for (const status of ["PENDING_APPROVAL", "WAITING", "ACCEPTED", "ONGOING", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"] as const) {
    await prisma.booking.update({ where: { id: booking.id }, data: { status } });
    const result = await deleteOwnAccount(owner.id, sessions[0].id, { confirmation: "DELETE", method: "password", password });
    assert.equal(result.deleted, false, `${status} must block deletion`);
    const seekerEligibility = await getAccountDeletionEligibility(other.id);
    assert.equal(seekerEligibility.counts.nonterminalBookings, 1, "both participant roles are checked");
  }
  await prisma.booking.update({ where: { id: booking.id }, data: { status: "COMPLETED", paymentStatus: "RELEASED" } });
  assert.equal((await getAccountDeletionEligibility(owner.id)).counts.queueJobs, 1, "even a stale active queue prevents unsafe deletion");
  await prisma.queue.update({ where: { id: queue.id }, data: { status: "DONE", paymentStatus: "RELEASED" } });
  const cancellation = await prisma.cancellationRequest.create({ data: { bookingId: booking.id, requestedBy: other.id, reason: "Earlier cancellation request", status: "DECLINED" } });
  assert.equal((await getAccountDeletionEligibility(owner.id)).eligible, true, "a historical declined cancellation is not an unresolved obligation");
  const report = await prisma.report.create({ data: { bookingId: booking.id, reporterId: other.id, reportedUserId: owner.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "Test case only" } });
  assert.equal((await getAccountDeletionEligibility(owner.id)).counts.reports, 1);
  await prisma.report.update({ where: { id: report.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });

  const completed = await prisma.completedService.create({ data: { bookingId: booking.id, queueId: queue.id, seekerId: other.id, providerId: owner.id, finalPrice: 500, paymentStatus: "RELEASED" } });
  const review = await prisma.review.create({ data: { completedServiceId: completed.id, authorId: other.id, targetId: owner.id, rating: 5, text: "Disposable review", editableUntil: new Date() } });
  await prisma.message.create({ data: { bookingId: booking.id, senderId: owner.id, receiverId: other.id, content: "Disposable private chat" } });
  const verification = await prisma.serviceVerification.create({ data: { userId: owner.id, privacyNoticeVersion: VERIFICATION_PRIVACY_NOTICE_VERSION, privacyAcknowledgedAt: new Date(), privacyAcknowledgedBy: owner.id, retentionUntil: new Date(Date.now() + 86_400_000), proofs: { create: { storageKey: `${tag}/fake-proof-no-file`, documentType: "GOVERNMENT_ID" } }, legalHold: true } });
  assert.equal((await getAccountDeletionEligibility(owner.id)).counts.verificationHolds, 1);
  assert.equal((await deleteOwnAccount(owner.id, sessions[0].id, { confirmation: "DELETE", method: "password", password })).deleted, false);
  await prisma.serviceVerification.update({ where: { id: verification.id }, data: { legalHold: false } });
  const attempt = await prisma.paymentAttempt.create({ data: { seekerId: other.id, providerId: owner.id, serviceId: listing.id, idempotencyKey: `${tag}-attempt`, amount: 500, paymentMethod: "gcash", status: "SUCCEEDED", expiresAt: new Date() } });
  const refund = await prisma.paymentRefund.create({ data: { paymentAttemptId: attempt.id, paymentId: `${tag}-refund`, requestedById: admin.id, amount: 500, reason: "Disposable refund", status: "PENDING" } });
  assert.equal((await getAccountDeletionEligibility(owner.id)).counts.unresolvedRefunds, 1, "a refund without a booking still blocks through its payment attempt");
  await prisma.paymentRefund.update({ where: { id: refund.id }, data: { status: "SUCCEEDED" } });
  await prisma.transaction.create({ data: { walletOwnerId: other.id, type: "EARNING", amount: 500, relatedBookingId: completed.id, description: "Disposable linked ledger entry" } });
  await prisma.trustScoreEvent.create({ data: { userId: other.id, delta: 1, scoreBefore: 50, scoreAfter: 51, reason: "Disposable review event", eventKey: `review:${review.id}` } });
  await prisma.aiReviewSummary.create({ data: { providerId: owner.id, summary: "Disposable summary", reviewCount: 1, contentVersion: "fixture" } });
  await prisma.adminAuditLog.create({ data: { actorId: admin.id, targetUserId: owner.id, action: "QA_FIXTURE", resourceType: "Booking", resourceId: booking.id, reason: "Disposable audit", metadata: { participant: owner.id } } });
  await prisma.adminAuditLog.create({ data: { actorId: admin.id, action: "QA_FIXTURE", resourceType: "CancellationRequest", resourceId: cancellation.id, reason: "Disposable audit without a target user field" } });
  await prisma.contentModerationEvent.create({ data: { actorId: owner.id, contentType: "SERVICE_LISTING", resourceId: listing.id, outcome: "ALLOW", reasonCode: "FIXTURE", policyVersion: "qa" } });
  await prisma.contentModerationCase.create({ data: { submitterId: other.id, contentType: "SERVICE_LISTING", resourceId: listing.id, caseType: "REPORT", reason: "Disposable closed case", status: "RESOLVED" } });
  await prisma.notification.create({ data: { userId: other.id, title: "Disposable linked notification", body: "Fixture only", link: `/seeker/seeker-activity?booking=${booking.id}` } });
  await prisma.accountDeletionRequest.create({ data: { userId: owner.id, status: "COMPLETED" } });
  const unrelatedBooking = await prisma.booking.create({ data: { seekerId: unrelated.id, providerId: other.id, paymentMethod: "On-site Cash", agreedAmount: 250, paymentStatus: "CASH_CONFIRMED", status: "COMPLETED" } });
  await assert.rejects(purgePreviouslyDeletedAccount(other.id), /previous flow/, "operational cleanup cannot purge a live account");

  for (let index = 0; index < 5; index++) {
    const historical = await prisma.completedService.create({ data: { seekerId: other.id, providerId: owner.id, finalPrice: 500, paymentStatus: "RELEASED" } });
    await prisma.review.create({ data: { completedServiceId: historical.id, authorId: other.id, targetId: owner.id, rating: 5, text: `Disposable historical review ${index}`, editableUntil: new Date() } });
  }
  const savedFetch = globalThis.fetch;
  const savedGeminiKey = env.GEMINI_API_KEY;
  let releaseAI!: () => void; let reachedAI!: () => void;
  const aiReleased = new Promise<void>(resolve => { releaseAI = resolve; });
  const aiReached = new Promise<void>(resolve => { reachedAI = resolve; });
  env.GEMINI_API_KEY = "qa-no-external-request";
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://generativelanguage.googleapis.com/")) {
      reachedAI(); await aiReleased;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Disposable late summary" }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return savedFetch(input, init);
  };
  t.after(() => { releaseAI(); globalThis.fetch = savedFetch; env.GEMINI_API_KEY = savedGeminiKey; });
  const lateSummary = summarizeProviderReviews(owner.id);
  await aiReached;

  assert.equal((await send({ confirmation: "DELETE", method: "password", password })).status, 200);
  releaseAI(); await lateSummary;
  globalThis.fetch = savedFetch; env.GEMINI_API_KEY = savedGeminiKey;
  assert.equal(await prisma.aiReviewSummary.count({ where: { providerId: owner.id } }), 0, "an in-flight AI request cannot recreate deleted account data");
  assert.equal(await prisma.user.findUnique({ where: { id: owner.id } }), null, "there is no anonymized user row");
  assert.equal(await prisma.refreshToken.count({ where: { userId: owner.id } }), 0);
  for (const session of sessions) assert.equal((await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${bearer(owner.id, session.id)}` } })).status, 401);
  const erasedIds = [owner.id, listing.id, request.id, booking.id, queue.id, cancellation.id, report.id, completed.id, review.id, verification.id, attempt.id, refund.id];
  const remaining = await prisma.$queryRaw<Array<{ table: string; count: number }>>(Prisma.sql`SELECT data.table, count(*)::int AS count FROM (
    SELECT 'users' AS table, row_to_json(t)::text AS row FROM users t UNION ALL
    SELECT 'services', row_to_json(t)::text FROM services t UNION ALL SELECT 'service_requests', row_to_json(t)::text FROM service_requests t UNION ALL
    SELECT 'bookings', row_to_json(t)::text FROM bookings t UNION ALL SELECT 'completed_services', row_to_json(t)::text FROM completed_services t UNION ALL
    SELECT 'reviews', row_to_json(t)::text FROM reviews t UNION ALL SELECT 'messages', row_to_json(t)::text FROM messages t UNION ALL
    SELECT 'queue', row_to_json(t)::text FROM queue t UNION ALL SELECT 'cancellation_requests', row_to_json(t)::text FROM cancellation_requests t UNION ALL
    SELECT 'reports', row_to_json(t)::text FROM reports t UNION ALL SELECT 'payment_attempts', row_to_json(t)::text FROM payment_attempts t UNION ALL
    SELECT 'payment_refunds', row_to_json(t)::text FROM payment_refunds t UNION ALL SELECT 'service_verifications', row_to_json(t)::text FROM service_verifications t UNION ALL
    SELECT 'verification_proofs', row_to_json(t)::text FROM verification_proofs t UNION ALL SELECT 'admin_audit_logs', row_to_json(t)::text FROM admin_audit_logs t UNION ALL
    SELECT 'account_deletion_requests', row_to_json(t)::text FROM account_deletion_requests t UNION ALL SELECT 'notifications', row_to_json(t)::text FROM notifications t UNION ALL
    SELECT 'trust_score_events', row_to_json(t)::text FROM trust_score_events t UNION ALL SELECT 'transactions', row_to_json(t)::text FROM transactions t UNION ALL
    SELECT 'ai_review_summaries', row_to_json(t)::text FROM ai_review_summaries t UNION ALL SELECT 'content_moderation_events', row_to_json(t)::text FROM content_moderation_events t UNION ALL
    SELECT 'content_moderation_cases', row_to_json(t)::text FROM content_moderation_cases t
  ) data WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[${Prisma.join(erasedIds)}]::text[]) resource(id) WHERE strpos(data.row, resource.id) > 0) GROUP BY data.table`);
  assert.deepEqual(remaining, [], "no dependent database rows or string references remain");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: unrelatedBooking.id } })).status, "COMPLETED");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).name, other.name);
  await assert.rejects(toggleServiceAvailability(listing.id, owner.id), /not found|no longer eligible/i);

  const adminSession = await prisma.refreshToken.create({ data: { userId: admin.id, token: `${tag}-admin-session`, expiresAt: new Date(Date.now() + 60_000) } });
  const adminHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${bearer(admin.id, adminSession.id, "admin")}` };
  assert.equal((await fetch(`${base}/admin/account-deletions`, { headers: adminHeaders })).status, 404);
  assert.equal((await fetch(`${base}/admin/account-deletions/${other.id}/finalize`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ reason: "Removed endpoint test" }) })).status, 404);
  assert.equal((await fetch(`${base}/admin/users/${owner.id}/restore`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ reason: "Deletion cannot be reversed" }) })).status, 404);

  const raceSession = await prisma.refreshToken.create({ data: { userId: racer.id, token: `${tag}-race-session`, expiresAt: new Date(Date.now() + 60_000) } });
  let release!: () => void; let locked!: () => void;
  const waitForRelease = new Promise<void>(resolve => { release = resolve; });
  const hasLock = new Promise<void>(resolve => { locked = resolve; });
  const barrier = prisma.$transaction(async tx => { await lockAccountLifecycle(tx, racer.id); locked(); await waitForRelease; }, { timeout: 15_000 });
  await hasLock;
  const deleting = deleteOwnAccount(racer.id, raceSession.id, { confirmation: "DELETE", method: "password", password });
  const publishing = createService(racer.id, { categoryId, title: "Home cabinet repair", description: "Repair loose cabinet hinges and adjust kitchen doors.", price: 500, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true, gcash: false } });
  release(); await barrier;
  const [deletion, publication] = await Promise.allSettled([deleting, publishing]);
  assert.equal(deletion.status, "fulfilled");
  const afterRace = await prisma.user.findUnique({ where: { id: racer.id } });
  if (!afterRace) {
    assert.equal(publication.status, "rejected");
    assert.equal(await prisma.service.count({ where: { providerId: racer.id, status: "ACTIVE" } }), 0);
  } else {
    assert.equal(publication.status, "fulfilled");
    assert.equal(deletion.status === "fulfilled" && deletion.value.deleted, false);
  }
  const legacy = await user("Deleted account");
  await prisma.user.update({ where: { id: legacy.id }, data: { isActive: false, deactivatedAt: new Date(), email: `${legacy.id}@deleted.servicehub.invalid` } });
  await prisma.accountDeletionRequest.create({ data: { userId: legacy.id, status: "COMPLETED" } });
  assert.equal((await purgePreviouslyDeletedAccount(legacy.id)).deleted, true);
  assert.equal(await prisma.user.findUnique({ where: { id: legacy.id } }), null);
});

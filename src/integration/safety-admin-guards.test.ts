import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { createSafetyReport, accessSafetyReportEvidence } from "../services/safety-report.service";
import { requestAccountDeletion } from "../services/account-deletion.service";
import { promoteUserToAdmin } from "../controllers/admin/users.controller";
import { moderateReview } from "../controllers/admin/reviews.controller";
import { finalizeAccountDeletion } from "../controllers/admin/account-deletions.controller";
import { getProviderReviews } from "../controllers/reviews.controller";

async function invoke(controller: Function, req: Record<string, unknown>) {
  let status = 200;
  let body: any;
  let nextError: any;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  };
  await controller(req, res, (error?: unknown) => { nextError = error; });
  return { status, body, error: nextError };
}

test("participant safety, review moderation, promotion guards, and final deactivation", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userIds: string[] = [];
  const reportIds: string[] = [];
  t.after(async () => {
    if (reportIds.length) await prisma.notification.deleteMany({ where: { link: { in: reportIds.map((id) => `/admin/reports?report=${id}`) } } });
    await prisma.accountDeletionRequest.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { targetUserId: { in: userIds } }] } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: userIds } }, { reportedUserId: { in: userIds } }] } });
    await prisma.review.deleteMany({ where: { OR: [{ authorId: { in: userIds } }, { targetId: { in: userIds } }] } });
    await prisma.completedService.deleteMany({ where: { OR: [{ seekerId: { in: userIds } }, { providerId: { in: userIds } }] } });
    await prisma.booking.deleteMany({ where: { OR: [{ seekerId: { in: userIds } }, { providerId: { in: userIds } }] } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  const password = "Phase4-Test-Password!";
  const passwordHash = await bcrypt.hash(password, 10);
  const makeUser = async (name: string, role = "user") => {
    const user = await prisma.user.create({ data: { name, email: `${name.toLowerCase().replace(/\s/g, "-")}-${suffix}@example.test`, passwordHash, phone: `${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`, location: "Cordova, Cebu", emailVerified: true, verificationStatus: "APPROVED", role } });
    userIds.push(user.id);
    return user;
  };
  const admin = await makeUser("Safety Admin", "admin");
  const seeker = await makeUser("Safety Seeker");
  const provider = await makeUser("Safety Provider");
  const outsider = await makeUser("Safety Outsider");
  const promotionTarget = await makeUser("Promotion Target");
  const deletionTarget = await makeUser("Deletion Target");

  const booking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 500, paymentStatus: "UNPAID", status: "ONGOING", started: true } });
  const evidenceStorageKey = `servicehub/safety/${booking.id}/${seeker.id}/evidence.jpg`;
  const firstReport = await createSafetyReport({ bookingId: booking.id, reporterId: seeker.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "The participant behaved in a way that requires administrator review.", evidenceStorageKey });
  reportIds.push(firstReport.id);
  assert.equal(firstReport.created, true);
  assert.equal("evidenceStorageKey" in firstReport, false);
  const duplicate = await createSafetyReport({ bookingId: booking.id, reporterId: seeker.id, reason: "NO_SHOW", description: "A duplicate active safety submission should return the first case." });
  assert.equal(duplicate.id, firstReport.id);
  assert.equal(duplicate.created, false);
  const reciprocal = await createSafetyReport({ bookingId: booking.id, reporterId: provider.id, reason: "INCOMPLETE_SERVICE", description: "The other participant may independently submit a safety concern." });
  reportIds.push(reciprocal.id);
  assert.notEqual(reciprocal.id, firstReport.id);
  await assert.rejects(createSafetyReport({ bookingId: booking.id, reporterId: outsider.id, reason: "NO_SHOW", description: "An outsider must never be allowed to report this booking." }), /access denied/i);
  await assert.rejects(createSafetyReport({ bookingId: booking.id, reporterId: provider.id, reason: "NO_SHOW", description: "Invalid evidence ownership must be rejected.", evidenceStorageKey: `servicehub/safety/${booking.id}/${outsider.id}/bad.jpg` }), /does not belong/i);
  await accessSafetyReportEvidence(firstReport.id, admin.id, "view");
  assert.equal(await prisma.adminAuditLog.count({ where: { actorId: admin.id, resourceId: firstReport.id, action: "REPORT_EVIDENCE_VIEWED" } }), 1);

  const completedBooking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 600, paymentStatus: "CASH_CONFIRMED", status: "COMPLETED", started: true } });
  const completed = await prisma.completedService.create({ data: { bookingId: completedBooking.id, seekerId: seeker.id, providerId: provider.id, finalPrice: 600, paymentStatus: "CASH_CONFIRMED" } });
  const review = await prisma.review.create({ data: { completedServiceId: completed.id, authorId: seeker.id, targetId: provider.id, rating: 2, text: "This review requires a moderation visibility test.", editableUntil: new Date(Date.now() + 60_000) } });
  const hidden = await invoke(moderateReview, { params: { id: review.id }, body: { action: "hide", reason: "Contains content requiring moderation." }, user: admin });
  assert.equal(hidden.error, undefined);
  assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).visibility, "HIDDEN");
  const publicWhileHidden = await invoke(getProviderReviews, { params: { providerId: provider.id } });
  assert.equal(publicWhileHidden.body.data.some((item: any) => item.id === review.id), false);
  await invoke(moderateReview, { params: { id: review.id }, body: { action: "restore", reason: "Manual review confirmed the content is allowed." }, user: admin });
  assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).visibility, "VISIBLE");
  assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: review.id, action: { in: ["REVIEW_HIDDEN", "REVIEW_RESTORED"] } } }), 2);

  const promotionBlocker = await prisma.booking.create({ data: { seekerId: outsider.id, providerId: promotionTarget.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 400, paymentStatus: "UNPAID", status: "ACCEPTED" } });
  const wrongPassword = await invoke(promoteUserToAdmin, { params: { id: promotionTarget.id }, body: { reason: "Capstone moderation team member.", currentPassword: "Wrong-Password" }, user: admin });
  assert.equal(wrongPassword.status, 403);
  const blockedPromotion = await invoke(promoteUserToAdmin, { params: { id: promotionTarget.id }, body: { reason: "Capstone moderation team member.", currentPassword: password }, user: admin });
  assert.equal(blockedPromotion.error?.code, "ADMIN_PROMOTION_BLOCKED");
  await prisma.booking.update({ where: { id: promotionBlocker.id }, data: { status: "CANCELED" } });
  const promoted = await invoke(promoteUserToAdmin, { params: { id: promotionTarget.id }, body: { reason: "Capstone moderation team member.", currentPassword: password }, user: admin });
  assert.equal(promoted.error, undefined);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: promotionTarget.id } })).role, "admin");

  const deletionRequest = await requestAccountDeletion(deletionTarget.id);
  assert.equal(deletionRequest.status, "PENDING");
  const finalized = await invoke(finalizeAccountDeletion, { params: { userId: deletionTarget.id }, body: { reason: "User-requested deletion after all obligations cleared." }, user: admin });
  assert.equal(finalized.error, undefined);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: deletionTarget.id } })).isActive, false);
  assert.equal((await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { userId: deletionTarget.id } })).status, "COMPLETED");
  assert.equal(await prisma.adminAuditLog.count({ where: { targetUserId: deletionTarget.id, action: "ACCOUNT_DEACTIVATED" } }), 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { VERIFICATION_PRIVACY_NOTICE_VERSION } from "../config/privacy";
import { requestAccountDeletion } from "../services/account-deletion.service";
import { getVerificationRetentionState } from "../services/data-retention.service";
import {
  accessVerificationProof,
  getVerificationStatus,
  listPendingVerifications,
  submitVerification,
} from "../services/verification.service";

test("verification privacy, audited access, retention holds, and deletion blockers", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userIds: string[] = [];
  let verificationId = "";

  t.after(async () => {
    if (verificationId) {
      await prisma.notification.deleteMany({
        where: { link: `/admin/verifications?verification=${verificationId}` },
      });
    }
    await prisma.accountDeletionRequest.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.adminAuditLog.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, { targetUserId: { in: userIds } }] },
    });
    await prisma.booking.deleteMany({ where: { OR: [{ seekerId: { in: userIds } }, { providerId: { in: userIds } }] } });
    await prisma.serviceVerification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  const createUser = async (name: string, emailVerified: boolean, role = "user") => {
    const user = await prisma.user.create({
      data: {
        name,
        email: `${name.toLowerCase().replace(/\s/g, "-")}-${suffix}@example.test`,
        passwordHash: "test-only",
        phone: `${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
        location: "Cordova, Cebu",
        emailVerified,
        role,
      },
    });
    userIds.push(user.id);
    return user;
  };

  const unverified = await createUser("Privacy Unverified", false);
  const seeker = await createUser("Privacy Seeker", true);
  const provider = await createUser("Privacy Provider", true);
  const admin = await createUser("Privacy Admin", true, "admin");

  await assert.rejects(
    submitVerification(
      unverified.id,
      [{ storageKey: `servicehub/verification/${unverified.id}/id.jpg`, documentType: "GOVERNMENT_ID" }],
      VERIFICATION_PRIVACY_NOTICE_VERSION,
      true,
    ),
    (error: any) => error?.code === "EMAIL_NOT_VERIFIED",
  );
  await assert.rejects(
    submitVerification(
      seeker.id,
      [{ storageKey: `servicehub/verification/${seeker.id}/id.jpg`, documentType: "GOVERNMENT_ID" }],
      "stale-version",
      true,
    ),
    (error: any) => error?.code === "PRIVACY_NOTICE_REQUIRED",
  );

  const submitted = await submitVerification(
    seeker.id,
    [{ storageKey: `servicehub/verification/${seeker.id}/id.jpg`, documentType: "GOVERNMENT_ID" }],
    VERIFICATION_PRIVACY_NOTICE_VERSION,
    true,
  );
  verificationId = submitted.id;
  assert.equal("storageKey" in submitted.proofs[0], false);
  assert.equal("fileUrl" in submitted.proofs[0], false);
  assert.equal(submitted.privacyNoticeVersion, VERIFICATION_PRIVACY_NOTICE_VERSION);
  assert.equal(submitted.privacyAcknowledgedBy, seeker.id);

  const duplicate = await submitVerification(
    seeker.id,
    [{ storageKey: `servicehub/verification/${seeker.id}/duplicate.jpg`, documentType: "BARANGAY_ID" }],
    VERIFICATION_PRIVACY_NOTICE_VERSION,
    true,
  );
  assert.equal(duplicate.id, submitted.id);
  assert.equal(await prisma.serviceVerification.count({ where: { userId: seeker.id } }), 1);

  const status = await getVerificationStatus(seeker.id);
  assert.ok(status);
  assert.equal("storageKey" in status!.proofs[0], false);
  const pending = await listPendingVerifications(1, 50);
  const listed = pending.items.find((item) => item.id === submitted.id);
  assert.ok(listed);
  assert.equal("storageKey" in listed!.proofs[0], false);
  assert.equal("fileUrl" in listed!.proofs[0], false);

  const stored = await prisma.serviceVerification.findUniqueOrThrow({
    where: { id: submitted.id },
    include: { proofs: true },
  });
  const access = await accessVerificationProof(submitted.id, stored.proofs[0].id, admin.id, "view");
  assert.match(access.url, /^https:/);
  assert.equal(await prisma.adminAuditLog.count({
    where: { actorId: admin.id, resourceId: stored.proofs[0].id, action: "VERIFICATION_DOCUMENT_VIEWED" },
  }), 1);

  await prisma.serviceVerification.update({
    where: { id: submitted.id },
    data: { retentionUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  const booking = await prisma.booking.create({
    data: {
      seekerId: seeker.id,
      providerId: provider.id,
      originType: "DIRECT_LISTING",
      paymentMethod: "On-site Cash",
      agreedAmount: 500,
      paymentStatus: "UNPAID",
      status: "ACCEPTED",
    },
  });
  const retention = await getVerificationRetentionState(submitted.id);
  assert.equal(retention?.hasActiveCaseHold, true);
  assert.equal(retention?.canPurge, false);

  const blockedDeletion = await requestAccountDeletion(seeker.id);
  assert.equal(blockedDeletion.status, "BLOCKED");
  assert.deepEqual(blockedDeletion.blockers, [{ type: "nonterminalBookings", count: 1 }]);

  await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELED" } });
  const pendingDeletion = await requestAccountDeletion(seeker.id);
  assert.equal(pendingDeletion.status, "PENDING");
  assert.deepEqual(pendingDeletion.blockers, []);
});

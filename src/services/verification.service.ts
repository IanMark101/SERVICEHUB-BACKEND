import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import { getPrivateVerificationUrl } from "../config/cloudinary";
import { applyTrustEventInTransaction } from "./trust.service";
import {
  VERIFICATION_DOCUMENT_RETENTION_DAYS,
  VERIFICATION_PRIVACY_NOTICE,
  VERIFICATION_PRIVACY_NOTICE_VERSION,
  verificationRetentionDeadline,
} from "../config/privacy";

type VerificationProofInput = { storageKey: string; documentType: string };

function httpError(message: string, status: number, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

function redactVerification<T extends { proofs: Array<Record<string, unknown>> }>(verification: T) {
  return {
    ...verification,
    proofs: verification.proofs.map(({ storageKey: _storageKey, fileUrl: _fileUrl, ...proof }) => proof),
  };
}

export function getVerificationPrivacyNotice() {
  return {
    version: VERIFICATION_PRIVACY_NOTICE_VERSION,
    notice: VERIFICATION_PRIVACY_NOTICE,
    minimumRetentionDays: VERIFICATION_DOCUMENT_RETENTION_DAYS,
  };
}

export async function submitVerification(
  userId: string,
  proofs: VerificationProofInput[],
  privacyNoticeVersion: string,
  privacyAcknowledged: boolean,
) {
  if (!privacyAcknowledged || privacyNoticeVersion !== VERIFICATION_PRIVACY_NOTICE_VERSION) {
    throw httpError("You must acknowledge the current verification privacy notice", 400, "PRIVACY_NOTICE_REQUIRED");
  }
  if (!proofs.length) throw httpError("At least one document is required", 400);
  if (proofs.some((proof) => !proof.storageKey.startsWith(`servicehub/verification/${userId}/`))) {
    throw httpError("Verification document does not belong to this user", 403);
  }

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { verificationStatus: true, emailVerified: true, name: true, email: true },
    });
    if (!user) throw httpError("User not found", 404);
    if (!user.emailVerified) throw httpError("Verify your email before submitting residency documents", 403, "EMAIL_NOT_VERIFIED");
    if (user.verificationStatus === "APPROVED") throw httpError("Your account is already verified", 409);

    const pending = await tx.serviceVerification.findFirst({
      where: { userId, status: "PENDING_REVIEW" },
      orderBy: { submittedAt: "desc" },
      include: { proofs: true },
    });
    if (pending) return { verification: pending, admins: [] as { id: string }[], created: false };

    const acknowledgedAt = new Date();
    const verification = await tx.serviceVerification.create({
      data: {
        userId,
        status: "PENDING_REVIEW",
        privacyNoticeVersion,
        privacyAcknowledgedAt: acknowledgedAt,
        privacyAcknowledgedBy: userId,
        retentionUntil: verificationRetentionDeadline(acknowledgedAt),
        proofs: { create: proofs },
      },
      include: { proofs: true },
    });
    await tx.user.update({ where: { id: userId }, data: { verificationStatus: "PENDING_REVIEW" } });
    const admins = await tx.user.findMany({
      where: { role: "admin", isActive: true, moderationStatus: "ACTIVE" },
      select: { id: true },
    });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((admin) => ({
          userId: admin.id,
          title: "New Verification Submission",
          body: `${user.name} (${user.email}) submitted verification documents for review.`,
          link: `/admin/verifications?verification=${verification.id}`,
        })),
      });
    }
    return { verification, admins, created: true };
  });

  if (result.created) {
    result.admins.forEach((admin) => safeEmit(`user:${admin.id}`, "notification", {
      title: "New Verification Submission",
      link: `/admin/verifications?verification=${result.verification.id}`,
    }));
    safeEmit("admin", "verification_submitted", { userId, verificationId: result.verification.id });
  }
  return redactVerification(result.verification);
}

export async function getVerificationStatus(userId: string) {
  const verification = await prisma.serviceVerification.findFirst({
    where: { userId },
    orderBy: { submittedAt: "desc" },
    include: { proofs: true },
  });
  return verification ? redactVerification(verification) : null;
}

export async function listPendingVerifications(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const where = { status: "PENDING_REVIEW" as const };
  const [items, total] = await Promise.all([
    prisma.serviceVerification.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true } },
        proofs: true,
      },
      orderBy: { submittedAt: "asc" },
      skip,
      take: limit,
    }),
    prisma.serviceVerification.count({ where }),
  ]);
  return {
    items: items.map(redactVerification),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function accessVerificationProof(
  verificationId: string,
  proofId: string,
  adminId: string,
  action: "view" | "download",
) {
  const proof = await prisma.verificationProof.findFirst({
    where: { id: proofId, verificationId },
    include: { verification: { select: { userId: true } } },
  });
  if (!proof?.storageKey) throw httpError("Verification proof not found", 404);

  await prisma.adminAuditLog.create({
    data: {
      actorId: adminId,
      targetUserId: proof.verification.userId,
      action: action === "download" ? "VERIFICATION_DOCUMENT_DOWNLOADED" : "VERIFICATION_DOCUMENT_VIEWED",
      resourceType: "VerificationProof",
      resourceId: proof.id,
      reason: `Administrator ${action}ed a private verification document`,
      metadata: { verificationId, documentType: proof.documentType },
    },
  });
  return { url: getPrivateVerificationUrl(proof.storageKey, action === "download"), expiresInSeconds: 300, documentType: proof.documentType };
}

export async function reviewVerification(
  verificationId: string,
  adminId: string,
  approve: boolean,
  adminNotes?: string,
) {
  const newStatus = approve ? "APPROVED" : "REJECTED";
  const verification = await prisma.$transaction(async (tx) => {
    const current = await tx.serviceVerification.findUnique({ where: { id: verificationId }, include: { user: true } });
    if (!current) throw httpError("Verification not found", 404);
    const reviewedAt = new Date();
    const claimed = await tx.serviceVerification.updateMany({
      where: { id: verificationId, status: "PENDING_REVIEW" },
      data: { status: newStatus, adminId, adminNotes: adminNotes || null, reviewedAt, retentionUntil: verificationRetentionDeadline(reviewedAt) },
    });
    if (claimed.count !== 1) throw httpError("Verification has already been reviewed", 409);
    await tx.user.update({ where: { id: current.userId }, data: { verificationStatus: newStatus } });

    if (approve) {
      await applyTrustEventInTransaction(tx, {
        userId: current.userId,
        delta: 5,
        reason: "Residency & Identity Verification Approved by Cordova Admin",
        actorAdminId: adminId,
        eventKey: `verification-approval:${verificationId}`,
      });
    }

    await tx.notification.create({
      data: {
        userId: current.userId,
        title: approve ? "Verification Approved" : "Verification Rejected",
        body: approve ? "You are now a verified Cordova resident." : `Your verification was not approved. Reason: ${adminNotes}`,
        link: `/seeker/user-profile?id=${current.userId}`,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: adminId,
        targetUserId: current.userId,
        action: approve ? "VERIFICATION_APPROVED" : "VERIFICATION_REJECTED",
        resourceType: "ServiceVerification",
        resourceId: verificationId,
        reason: adminNotes || "Verification requirements satisfied",
      },
    });
    return current;
  });

  safeEmit(`user:${verification.userId}`, "notification", { title: approve ? "Verification Approved" : "Verification Rejected" });
  return { status: newStatus };
}

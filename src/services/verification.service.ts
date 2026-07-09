import { prisma } from "../lib/prisma";
import { applyTrustEvent } from "./trust.service";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { safeEmit } from "../lib/socket";

// ── Submit Verification ────────────────────────────────────────────────────────

export async function submitVerification(
  userId: string,
  proofs: { fileUrl: string; documentType: string }[]
) {
  // Invalidate any existing verification in REJECTED or UNVERIFIED state
  await prisma.serviceVerification.updateMany({
    where: { userId, status: { in: ["REJECTED"] } },
    data: { status: "PENDING_REVIEW" },
  });

  // Check if already pending
  const existing = await prisma.serviceVerification.findFirst({
    where: { userId, status: "PENDING_REVIEW" },
  });

  if (existing) {
    const err = new Error("Verification already under review") as any;
    err.status = 409;
    throw err;
  }

  if (proofs.length === 0) {
    const err = new Error("At least one document is required") as any;
    err.status = 400;
    throw err;
  }

  const verification = await prisma.serviceVerification.create({
    data: {
      userId,
      status: "PENDING_REVIEW",
      proofs: {
        create: proofs.map((p) => ({
          fileUrl: p.fileUrl,
          documentType: p.documentType,
        })),
      },
    },
    include: { proofs: true },
  });

  return verification;
}

// ── Get My Verification Status ─────────────────────────────────────────────────

export async function getVerificationStatus(userId: string) {
  const verification = await prisma.serviceVerification.findFirst({
    where: { userId },
    orderBy: { submittedAt: "desc" },
    include: { proofs: true },
  });

  return verification;
}

// ── Admin: List Pending Verifications ─────────────────────────────────────────

export async function listPendingVerifications() {
  return prisma.serviceVerification.findMany({
    where: { status: "PENDING_REVIEW" },
    include: {
      user: {
        select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true },
      },
      proofs: true,
    },
    orderBy: { submittedAt: "asc" }, // FCFS — oldest first
  });
}

// ── Admin: Approve or Reject Verification ─────────────────────────────────────

export async function reviewVerification(
  verificationId: string,
  adminId: string,
  approve: boolean,
  adminNotes?: string
) {
  const verification = await prisma.serviceVerification.findUnique({
    where: { id: verificationId },
    include: { user: true },
  });

  if (!verification) {
    const err = new Error("Verification not found") as any;
    err.status = 404;
    throw err;
  }

  const newStatus = approve ? "APPROVED" : "REJECTED";

  // Update verification record
  await prisma.serviceVerification.update({
    where: { id: verificationId },
    data: {
      status: newStatus,
      adminId,
      adminNotes: adminNotes || null,
      reviewedAt: new Date(),
    },
  });

  // Update user's verification status
  await prisma.user.update({
    where: { id: verification.userId },
    data: { verificationStatus: newStatus },
  });

  if (approve) {
    // One-time trust score bonus for completing verification (+5)
    await applyTrustEvent(verification.userId, 5, "Community verification approved");
  }

  // In-app notification
  await prisma.notification.create({
    data: {
      userId: verification.userId,
      title: approve ? "Verification Approved ✅" : "Verification Rejected",
      body: approve
        ? 'You are now a Verified Resident of Cordova! Your "Verified" badge is now active.'
        : `Your verification was not approved. Reason: ${adminNotes || "Please resubmit with clearer documents."}`,
      link: `/provider/provider-activity`,
    },
  });
  safeEmit(`user:${verification.userId}`, "notification", { title: approve ? "Verification Approved ✅" : "Verification Rejected" });

  return { status: newStatus };
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitVerification = submitVerification;
exports.getVerificationStatus = getVerificationStatus;
exports.listPendingVerifications = listPendingVerifications;
exports.reviewVerification = reviewVerification;
const prisma_1 = require("../lib/prisma");
const trust_service_1 = require("./trust.service");
// ── Submit Verification ────────────────────────────────────────────────────────
async function submitVerification(userId, proofs) {
    // Invalidate any existing verification in REJECTED or UNVERIFIED state
    await prisma_1.prisma.serviceVerification.updateMany({
        where: { userId, status: { in: ["REJECTED"] } },
        data: { status: "PENDING_REVIEW" },
    });
    // Check if already pending
    const existing = await prisma_1.prisma.serviceVerification.findFirst({
        where: { userId, status: "PENDING_REVIEW" },
    });
    if (existing) {
        const err = new Error("Verification already under review");
        err.status = 409;
        throw err;
    }
    if (proofs.length === 0) {
        const err = new Error("At least one document is required");
        err.status = 400;
        throw err;
    }
    const verification = await prisma_1.prisma.serviceVerification.create({
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
async function getVerificationStatus(userId) {
    const verification = await prisma_1.prisma.serviceVerification.findFirst({
        where: { userId },
        orderBy: { submittedAt: "desc" },
        include: { proofs: true },
    });
    return verification;
}
// ── Admin: List Pending Verifications ─────────────────────────────────────────
async function listPendingVerifications() {
    return prisma_1.prisma.serviceVerification.findMany({
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
async function reviewVerification(verificationId, adminId, approve, adminNotes) {
    const verification = await prisma_1.prisma.serviceVerification.findUnique({
        where: { id: verificationId },
        include: { user: true },
    });
    if (!verification) {
        const err = new Error("Verification not found");
        err.status = 404;
        throw err;
    }
    const newStatus = approve ? "APPROVED" : "REJECTED";
    // Update verification record
    await prisma_1.prisma.serviceVerification.update({
        where: { id: verificationId },
        data: {
            status: newStatus,
            adminId,
            adminNotes: adminNotes || null,
            reviewedAt: new Date(),
        },
    });
    // Update user's verification status
    await prisma_1.prisma.user.update({
        where: { id: verification.userId },
        data: { verificationStatus: newStatus },
    });
    if (approve) {
        // One-time trust score bonus for completing verification (+5)
        await (0, trust_service_1.applyTrustEvent)(verification.userId, 5, "Community verification approved");
    }
    // In-app notification
    await prisma_1.prisma.notification.create({
        data: {
            userId: verification.userId,
            title: approve ? "Verification Approved ✅" : "Verification Rejected",
            body: approve
                ? 'You are now a Verified Resident of Cordova! Your "Verified" badge is now active.'
                : `Your verification was not approved. Reason: ${adminNotes || "Please resubmit with clearer documents."}`,
        },
    });
    return { status: newStatus };
}
//# sourceMappingURL=verification.service.js.map
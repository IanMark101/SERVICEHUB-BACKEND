import { prisma } from "../lib/prisma";
import { applyVerificationApprovalTrust } from "./trust.service";
import { safeEmit } from "../lib/socket";
// ── Submit Verification ────────────────────────────────────────────────────────
export async function submitVerification(userId, proofs) {
    if (!proofs || proofs.length === 0) {
        const err = new Error("At least one document is required");
        err.status = 400;
        throw err;
    }
    // Check user's current status
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { verificationStatus: true, name: true, email: true },
    });
    if (user?.verificationStatus === "APPROVED") {
        const err = new Error("Your account is already verified.");
        err.status = 400;
        throw err;
    }
    // Find any existing verification record for this user
    const existing = await prisma.serviceVerification.findFirst({
        where: { userId },
        orderBy: { submittedAt: "desc" },
    });
    let verification;
    if (existing) {
        // Delete old proofs attached to this verification record
        await prisma.verificationProof.deleteMany({
            where: { verificationId: existing.id },
        });
        // Update existing verification record to PENDING_REVIEW with new proofs
        verification = await prisma.serviceVerification.update({
            where: { id: existing.id },
            data: {
                status: "PENDING_REVIEW",
                submittedAt: new Date(),
                reviewedAt: null,
                adminId: null,
                adminNotes: null,
                proofs: {
                    create: proofs.map((p) => ({
                        fileUrl: p.fileUrl,
                        documentType: p.documentType,
                    })),
                },
            },
            include: { proofs: true },
        });
    }
    else {
        // Create brand new verification record
        verification = await prisma.serviceVerification.create({
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
    }
    // Update user's verificationStatus to PENDING_REVIEW
    await prisma.user.update({
        where: { id: userId },
        data: { verificationStatus: "PENDING_REVIEW" },
    });
    // Create in-app notification records for all admin users so it shows up in their bell dropdown
    const admins = await prisma.user.findMany({
        where: { role: "admin" },
        select: { id: true },
    });
    if (admins.length > 0) {
        const adminNotifs = admins.map((admin) => ({
            userId: admin.id,
            title: "📁 New Verification Submission",
            body: `${user?.name || "A user"} (${user?.email || userId}) submitted verification documents for review.`,
            link: "/admin/verifications",
        }));
        await prisma.notification.createMany({ data: adminNotifs });
        admins.forEach((admin) => {
            safeEmit(`user:${admin.id}`, "notification", {
                title: "📁 New Verification Submission",
                body: `${user?.name || "A user"} submitted verification documents.`,
                link: "/admin/verifications",
            });
        });
    }
    // Emit real-time queue update for Admin Verifications page
    safeEmit("admin", "verification_submitted", { userId, verificationId: verification.id });
    return verification;
}
// ── Get My Verification Status ─────────────────────────────────────────────────
export async function getVerificationStatus(userId) {
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
export async function reviewVerification(verificationId, adminId, approve, adminNotes) {
    const verification = await prisma.serviceVerification.findUnique({
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
        // Masterprompt Part 5 & 15: one-time +5 for verification approval
        await applyVerificationApprovalTrust(verification.userId);
    }
    // In-app notification for the user
    await prisma.notification.create({
        data: {
            userId: verification.userId,
            title: approve ? "Verification Approved ✅" : "Verification Rejected",
            body: approve
                ? 'You are now a Verified Resident of Cordova! Your "Verified" badge is now active.'
                : `Your verification was not approved. Reason: ${adminNotes || "Please resubmit with clearer documents."}`,
            link: verification.user.role === "provider" ? `/provider/user-profile?id=${verification.userId}` : `/seeker/user-profile?id=${verification.userId}`,
        },
    });
    safeEmit(`user:${verification.userId}`, "notification", { title: approve ? "Verification Approved ✅" : "Verification Rejected" });
    return { status: newStatus };
}
//# sourceMappingURL=verification.service.js.map
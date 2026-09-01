import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import { deletePrivateVerificationImage, getPrivateVerificationUrl } from "../config/cloudinary";
export async function submitVerification(userId, proofs) {
    if (!proofs.length) {
        const error = new Error("At least one document is required");
        error.status = 400;
        throw error;
    }
    if (proofs.some((proof) => !proof.storageKey.startsWith(`servicehub/verification/${userId}/`))) {
        const error = new Error("Verification document does not belong to this user");
        error.status = 403;
        throw error;
    }
    const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
            where: { id: userId },
            select: { verificationStatus: true, name: true, email: true },
        });
        if (!user) {
            const error = new Error("User not found");
            error.status = 404;
            throw error;
        }
        if (user.verificationStatus === "APPROVED") {
            const error = new Error("Your account is already verified");
            error.status = 409;
            throw error;
        }
        const existing = await tx.serviceVerification.findFirst({
            where: { userId },
            orderBy: { submittedAt: "desc" },
            include: { proofs: { select: { storageKey: true } } },
        });
        const verification = existing
            ? await tx.serviceVerification.update({
                where: { id: existing.id },
                data: {
                    status: "PENDING_REVIEW",
                    submittedAt: new Date(),
                    reviewedAt: null,
                    adminId: null,
                    adminNotes: null,
                    proofs: {
                        deleteMany: {},
                        create: proofs.map((proof) => ({
                            storageKey: proof.storageKey,
                            documentType: proof.documentType,
                        })),
                    },
                },
                include: { proofs: true },
            })
            : await tx.serviceVerification.create({
                data: {
                    userId,
                    status: "PENDING_REVIEW",
                    proofs: {
                        create: proofs.map((proof) => ({
                            storageKey: proof.storageKey,
                            documentType: proof.documentType,
                        })),
                    },
                },
                include: { proofs: true },
            });
        await tx.user.update({ where: { id: userId }, data: { verificationStatus: "PENDING_REVIEW" } });
        const admins = await tx.user.findMany({
            where: { role: "admin", isActive: true },
            select: { id: true },
        });
        if (admins.length) {
            await tx.notification.createMany({
                data: admins.map((admin) => ({
                    userId: admin.id,
                    title: "New Verification Submission",
                    body: `${user.name} (${user.email}) submitted verification documents for review.`,
                    link: "/admin/verifications",
                })),
            });
        }
        return {
            verification,
            admins,
            replacedStorageKeys: existing?.proofs.map((proof) => proof.storageKey).filter((key) => Boolean(key)) || [],
        };
    });
    await Promise.allSettled(result.replacedStorageKeys.map(deletePrivateVerificationImage));
    result.admins.forEach((admin) => safeEmit(`user:${admin.id}`, "notification", {
        title: "New Verification Submission",
        link: "/admin/verifications",
    }));
    safeEmit("admin", "verification_submitted", { userId, verificationId: result.verification.id });
    return result.verification;
}
export async function getVerificationStatus(userId) {
    const verification = await prisma.serviceVerification.findFirst({
        where: { userId },
        orderBy: { submittedAt: "desc" },
        include: { proofs: true },
    });
    if (!verification)
        return null;
    return {
        ...verification,
        proofs: verification.proofs.map((proof) => ({
            ...proof,
            fileUrl: proof.storageKey ? getPrivateVerificationUrl(proof.storageKey) : proof.fileUrl,
        })),
    };
}
export async function listPendingVerifications(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { status: "PENDING_REVIEW" };
    const [items, total] = await Promise.all([
        prisma.serviceVerification.findMany({
            where,
            include: {
                user: {
                    select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true },
                },
                proofs: true,
            },
            orderBy: { submittedAt: "asc" },
            skip,
            take: limit,
        }),
        prisma.serviceVerification.count({ where }),
    ]);
    return {
        items: items.map((item) => ({
            ...item,
            proofs: item.proofs.map((proof) => ({
                ...proof,
                fileUrl: proof.storageKey ? getPrivateVerificationUrl(proof.storageKey) : proof.fileUrl,
            })),
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
}
export async function reviewVerification(verificationId, adminId, approve, adminNotes) {
    const newStatus = approve ? "APPROVED" : "REJECTED";
    const verification = await prisma.$transaction(async (tx) => {
        const current = await tx.serviceVerification.findUnique({
            where: { id: verificationId },
            include: { user: true },
        });
        if (!current) {
            const error = new Error("Verification not found");
            error.status = 404;
            throw error;
        }
        const claimed = await tx.serviceVerification.updateMany({
            where: { id: verificationId, status: "PENDING_REVIEW" },
            data: { status: newStatus, adminId, adminNotes: adminNotes || null, reviewedAt: new Date() },
        });
        if (claimed.count !== 1) {
            const error = new Error("Verification has already been reviewed");
            error.status = 409;
            throw error;
        }
        await tx.user.update({ where: { id: current.userId }, data: { verificationStatus: newStatus } });
        if (approve) {
            const rows = await tx.$queryRaw `
        SELECT "trustScore" FROM "users" WHERE "id" = ${current.userId} FOR UPDATE
      `;
            const scoreBefore = rows[0].trustScore;
            const scoreAfter = Math.min(100, scoreBefore + 5);
            await tx.user.update({ where: { id: current.userId }, data: { trustScore: scoreAfter } });
            await tx.trustScoreEvent.create({
                data: {
                    userId: current.userId,
                    delta: scoreAfter - scoreBefore,
                    reason: "Residency & Identity Verification Approved by Cordova Admin",
                    scoreBefore,
                    scoreAfter,
                    actorAdminId: adminId,
                },
            });
        }
        await tx.notification.create({
            data: {
                userId: current.userId,
                title: approve ? "Verification Approved" : "Verification Rejected",
                body: approve
                    ? 'You are now a Verified Resident of Cordova. Your "Verified" badge is active.'
                    : `Your verification was not approved. Reason: ${adminNotes}`,
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
    safeEmit(`user:${verification.userId}`, "notification", {
        title: approve ? "Verification Approved" : "Verification Rejected",
    });
    return { status: newStatus };
}
//# sourceMappingURL=verification.service.js.map
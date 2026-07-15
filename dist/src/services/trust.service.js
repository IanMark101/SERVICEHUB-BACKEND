import { prisma } from "../lib/prisma";
/**
 * Core engine method to apply delta to a user's trust score.
 * Trust score is clamped between 0 and 100.
 */
export async function applyTrustEvent(userId, delta, reason) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { trustScore: true } });
    if (!user)
        return;
    const newScore = Math.min(100, Math.max(0, user.trustScore + delta));
    await prisma.user.update({
        where: { id: userId },
        data: { trustScore: newScore },
    });
    console.log(`[TrustEngine] User ${userId}: ${delta > 0 ? "+" : ""}${delta} → ${newScore} (${reason})`);
}
/**
 * Apply trust score adjustments based on a rating left in a review.
 */
export async function applyReviewTrust(userId, rating) {
    let delta = 0;
    if (rating === 5) {
        delta = 2; // +2 for exceptional service
    }
    else if (rating === 4) {
        delta = 1; // +1 for good service
    }
    else if (rating === 2) {
        delta = -3; // -3 for poor service
    }
    else if (rating === 1) {
        delta = -5; // -5 for highly unsatisfied service
    }
    if (delta !== 0) {
        await applyTrustEvent(userId, delta, `Received ${rating}-star review`);
    }
}
/**
 * Apply trust score deductions for cancellations where the user was at fault.
 */
export async function applyCancellationTrust(userId, isProvider) {
    const delta = -5; // -5 for cancellation at fault
    const role = isProvider ? "Provider" : "Seeker";
    await applyTrustEvent(userId, delta, `${role} cancelled active booking (at fault)`);
}
/**
 * Apply trust score deductions for repeated service listing rejections.
 */
export async function applyListingRejectionTrust(userId, count) {
    if (count === 2) {
        await applyTrustEvent(userId, -5, "Second repeated listing rejection");
    }
}
//# sourceMappingURL=trust.service.js.map
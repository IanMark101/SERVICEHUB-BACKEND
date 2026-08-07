import { prisma } from "../lib/prisma";

/**
 * THE SINGLE SOURCE OF TRUTH FOR ALL TRUST SCORE CHANGES.
 *
 * Every trust score modification — whether triggered by verification,
 * review, cancellation, admin override, or any other event — MUST go
 * through this function. It is the only place that should ever write
 * to `User.trustScore`.
 *
 * This ensures:
 * 1. The DB `trustScore` column is always the authoritative, correct value.
 * 2. Every change is recorded as an immutable row in `trust_score_events`
 *    so the Trust History tab always matches the displayed score exactly.
 * 3. Score is always clamped between 0 and 100.
 */
export async function applyTrustEvent(
  userId: string,
  delta: number,
  reason: string
): Promise<void> {
  // Use a transaction so the score update and history record are always atomic.
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { trustScore: true },
    });
    if (!user) return;

    const scoreBefore = user.trustScore;
    const scoreAfter = Math.min(100, Math.max(0, scoreBefore + delta));

    // 1. Update the live score on the User record
    await tx.user.update({
      where: { id: userId },
      data: { trustScore: scoreAfter },
    });

    // 2. Write an immutable audit event — this is what the Trust History
    //    tab reads. It will always be consistent with the actual score.
    await tx.trustScoreEvent.create({
      data: {
        userId,
        delta,
        reason,
        scoreBefore,
        scoreAfter,
      },
    });

    console.log(
      `[TrustEngine] ${userId}: ${delta > 0 ? "+" : ""}${delta} (${scoreBefore} → ${scoreAfter}) — ${reason}`
    );
  });
}

/**
 * Called once at account creation to record the default baseline.
 * The schema sets trustScore: 50 via @default(50), so we only need
 * to write the history event — no score update needed.
 */
export async function recordAccountCreationBaseline(userId: string): Promise<void> {
  await prisma.trustScoreEvent.create({
    data: {
      userId,
      delta: 50,
      reason: "Initial Account Base Trust Score Baseline",
      scoreBefore: 0,
      scoreAfter: 50,
    },
  });
}

// ── Specific Event Helpers ───────────────────────────────────────────────────
// These all route through applyTrustEvent — they are the ONLY callers
// allowed to modify trust scores in the entire codebase.

/**
 * Masterprompt Part 15: verification approval grants a one-time +5.
 * (Part 5 confirms this exact value: "one-time trust_score: +5")
 */
export async function applyVerificationApprovalTrust(userId: string): Promise<void> {
  await applyTrustEvent(userId, +5, "Residency & Identity Verification Approved by Cordova Admin");
}

/**
 * Masterprompt Part 10 (Path A): provider gets a small trust increase
 * when a seeker confirms and releases escrow (service completed).
 */
export async function applyServiceCompletionTrust(userId: string): Promise<void> {
  await applyTrustEvent(userId, +3, "Service completed & confirmed by seeker");
}

/**
 * Masterprompt Part 14 / Part 15: trust adjustments based on review rating.
 * Applied to the PROVIDER (the target of the review).
 */
export async function applyReviewTrust(userId: string, rating: number): Promise<void> {
  let delta = 0;
  let reason = "";

  if (rating === 5) {
    delta = +2;
    reason = "Received 5-star review";
  } else if (rating === 4) {
    delta = +1;
    reason = "Received 4-star review";
  } else if (rating === 2) {
    delta = -3;
    reason = "Received 2-star review (poor service)";
  } else if (rating === 1) {
    delta = -5;
    reason = "Received 1-star review (highly unsatisfied)";
  }
  // Rating of 3 is neutral — no trust change.

  if (delta !== 0) {
    await applyTrustEvent(userId, delta, reason);
  }
}

/**
 * Masterprompt Part 15: cancellation deduction for the at-fault party.
 * Only applied when booking was already started (Part 9).
 */
export async function applyCancellationTrust(
  userId: string,
  isProvider: boolean
): Promise<void> {
  const role = isProvider ? "Provider" : "Seeker";
  await applyTrustEvent(userId, -5, `${role} cancelled active booking (at fault)`);
}

/**
 * Masterprompt Part 15: deduction for a validated report against the user.
 */
export async function applyReportPenaltyTrust(userId: string): Promise<void> {
  await applyTrustEvent(userId, -10, "Valid report filed and confirmed by admin");
}

/**
 * Masterprompt Part 17: deduction on 2nd repeated listing rejection.
 * (1st is only a warning — no score change. 3rd triggers account flag.)
 */
export async function applyListingRejectionTrust(
  userId: string,
  rejectionCount: number
): Promise<void> {
  if (rejectionCount === 2) {
    await applyTrustEvent(userId, -5, "Second repeated service listing rejection");
  }
}

/**
 * Get the full trust score history for a user, ordered newest first.
 * If no history records exist for a legacy account created prior to the
 * TrustScoreEvent schema, it automatically backfills the baseline and
 * verification events so history is never empty for existing users.
 */
export async function getTrustHistory(userId: string) {
  let events = await prisma.trustScoreEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  // Self-healing / Backfill for legacy accounts created prior to TrustScoreEvent table
  if (events.length === 0) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { trustScore: true, verificationStatus: true, createdAt: true },
    });

    if (user) {
      let runningScore = 0;

      // 1. Account Creation Baseline (+50)
      await prisma.trustScoreEvent.create({
        data: {
          userId,
          delta: 50,
          reason: "Initial Account Base Trust Score Baseline",
          scoreBefore: 0,
          scoreAfter: 50,
          createdAt: user.createdAt,
        },
      });
      runningScore = 50;

      // 2. Verification Approval (+5) if user is verified
      if (user.verificationStatus === "APPROVED") {
        await prisma.trustScoreEvent.create({
          data: {
            userId,
            delta: 5,
            reason: "Residency & Identity Verification Approved by Cordova Admin",
            scoreBefore: 50,
            scoreAfter: 55,
            createdAt: new Date(),
          },
        });
        runningScore = 55;
      }

      // 3. Catch-all adjustment if current trustScore in DB is different from runningScore
      if (user.trustScore !== runningScore) {
        const diff = user.trustScore - runningScore;
        await prisma.trustScoreEvent.create({
          data: {
            userId,
            delta: diff,
            reason: diff > 0 ? "Legacy Earned Trust Activity Adjustment" : "Legacy Trust Score Adjustment",
            scoreBefore: runningScore,
            scoreAfter: user.trustScore,
            createdAt: new Date(),
          },
        });
      }

      // Re-fetch the newly generated history
      events = await prisma.trustScoreEvent.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
    }
  }

  return events;
}


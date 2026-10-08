import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { SALT_ROUNDS, toPublicUser } from "./authentication.service";
import { disconnectUserSockets, safeEmit } from "../../lib/socket";
import { lockAuthenticationSession } from "./session-lifecycle.service";
import { lockAccountLifecycle } from "../account-lifecycle.service";
import { StrongPasswordSchema } from "../../schema/password.schema";
import { reviewEligibilitySql } from '../../lib/review-eligibility';

type ProfileReviewRow = {
  id: string; authorName: string; authorAvatar: string | null; rating: number;
  comment: string | null; createdAt: Date; reviewContext: 'PROVIDER' | 'SEEKER';
  reviewCount: bigint; averageRating: unknown; five: bigint; four: bigint;
  three: bigint; two: bigint; one: bigint;
};

// ── Public & Edit Profile Services ───────────────────────────────────────────

export async function getUserPublicProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      location: true,
      avatarUrl: true,
      bio: true,
      facebookUrl: true,
      instagramUrl: true,
      websiteUrl: true,
      role: true,
      trustScore: true,
      verificationStatus: true,
      createdAt: true,
    },
  });

  if (!user) {
    const err = new Error("User not found") as any;
    err.status = 404;
    throw err;
  }

  // Get completed services count and reviews
  const completedCount = await prisma.completedService.count({
    where: { providerId: userId },
  });

  // Keep each role's latest ten comments and its full rating totals. Limiting a
  // mixed feed first could hide all service reviews behind newer client ones.
  const reviews = await prisma.$queryRaw<ProfileReviewRow[]>`
    WITH eligible AS (
      SELECT r.id, a.name AS "authorName", a."avatarUrl" AS "authorAvatar",
        r.rating, r.text AS comment, r."createdAt",
        CASE WHEN cs."providerId" = ${userId} THEN 'PROVIDER' ELSE 'SEEKER' END AS "reviewContext"
      FROM reviews r JOIN completed_services cs ON cs.id = r."completedServiceId"
      JOIN users a ON a.id = r."authorId" LEFT JOIN bookings b ON b.id = cs."bookingId"
      WHERE ${reviewEligibilitySql(userId)}
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER w AS position,
        COUNT(*) OVER role AS "reviewCount", AVG(rating) OVER role AS "averageRating",
        COUNT(*) FILTER (WHERE rating = 5) OVER role AS five,
        COUNT(*) FILTER (WHERE rating = 4) OVER role AS four,
        COUNT(*) FILTER (WHERE rating = 3) OVER role AS three,
        COUNT(*) FILTER (WHERE rating = 2) OVER role AS two,
        COUNT(*) FILTER (WHERE rating = 1) OVER role AS one
      FROM eligible WINDOW role AS (PARTITION BY "reviewContext"),
        w AS (PARTITION BY "reviewContext" ORDER BY "createdAt" DESC, id DESC)
    ) SELECT * FROM ranked WHERE position <= 10 ORDER BY "createdAt" DESC, id DESC`;

  const statsFor = (context: 'PROVIDER' | 'SEEKER') => {
    const row = reviews.find(review => review.reviewContext === context);
    return {
      reviewCount: Number(row?.reviewCount ?? 0),
      averageRating: row ? Number(Number(row.averageRating).toFixed(1)) : 0,
      ratingDistribution: [5, 4, 3, 2, 1].map((star, index) => ({
        star, count: Number(row ? [row.five, row.four, row.three, row.two, row.one][index] : 0),
      })),
    };
  };
  const reviewStats = { PROVIDER: statsFor('PROVIDER'), SEEKER: statsFor('SEEKER') };

  return {
    ...user,
    completedServiceCount: completedCount,
    averageRating: reviewStats.PROVIDER.averageRating,
    reviewStats,
    reviews: reviews.map(r => ({
      id: r.id,
      authorName: r.authorName,
      authorAvatar: r.authorAvatar,
      rating: r.rating,
      comment: r.comment || '',
      createdAt: r.createdAt,
      reviewContext: r.reviewContext,
    })),
  };
}

export async function updateUserProfile(
  userId: string,
  data: {
    name?: string;
    bio?: string;
    phone?: string;
    location?: string;
    avatarUrl?: string;
    facebookUrl?: string;
    instagramUrl?: string;
    websiteUrl?: string;
    currentPassword?: string;
  }
) {
  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, phone: true, passwordHash: true },
  });

  if (!currentUser) {
    const err = new Error("User not found") as any;
    err.status = 404;
    throw err;
  }

  // Check if phone number is being updated
  const isPhoneChanging =
    data.phone !== undefined &&
    data.phone.trim() !== "" &&
    data.phone.trim() !== (currentUser.phone || "").trim();

  if (isPhoneChanging) {
    // 1. Active Job Lock: Check if user is a provider or seeker in any active/held booking
    const activeBookings = await prisma.booking.findMany({
      where: {
        OR: [{ providerId: userId }, { seekerId: userId }],
        status: {
          in: [
            "PENDING_APPROVAL",
            "WAITING",
            "ACCEPTED",
            "ONGOING",
            "AWAITING_CONFIRMATION",
            "UNDER_REVIEW",
            "DISPUTED",
          ],
        },
      },
      select: { id: true, status: true },
    });

    if (activeBookings.length > 0) {
      const err = new Error(
        "Mobile number cannot be changed while you have active service engagements in progress. Please complete or settle your active jobs first."
      ) as any;
      err.status = 400;
      throw err;
    }

    // 2. Password Re-Authentication: If passwordHash exists, verify currentPassword
    if (currentUser.passwordHash) {
      if (!data.currentPassword) {
        const err = new Error(
          "Current password is required to update your mobile/GCash payout number."
        ) as any;
        err.status = 400;
        throw err;
      }

      const isValidPassword = await bcrypt.compare(
        data.currentPassword,
        currentUser.passwordHash
      );
      if (!isValidPassword) {
        const err = new Error(
          "Incorrect current password. Mobile number was not updated."
        ) as any;
        err.status = 400;
        throw err;
      }
    }
  }

  const updatedUser = await prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, userId);
    await lockAuthenticationSession(tx, userId);
    const latest = await tx.user.findUnique({ where: { id: userId } });
    if (!latest || !latest.isActive || latest.deactivatedAt) throw Object.assign(new Error("This account is no longer active."), { status: 403 });
    if (isPhoneChanging && latest.passwordHash !== currentUser.passwordHash) throw Object.assign(new Error("Your password changed. Verify your current password again."), { status: 409 });
    return tx.user.update({
    where: { id: userId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.bio !== undefined && { bio: data.bio }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.location !== undefined && { location: data.location }),
      ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
      ...(data.facebookUrl !== undefined && { facebookUrl: data.facebookUrl }),
      ...(data.instagramUrl !== undefined && { instagramUrl: data.instagramUrl }),
      ...(data.websiteUrl !== undefined && { websiteUrl: data.websiteUrl }),
    },
    });
  });

  // 3. Security Notification on Phone Change
  if (isPhoneChanging) {
    try {
      await prisma.notification.create({
        data: {
          userId,
          title: "Security Alert: Mobile Number Updated 🔒",
          body: `Your mobile/GCash number was successfully updated to ${data.phone}. If you did not make this change, please contact support immediately.`,
          link: updatedUser.role === "provider" ? "/provider/account-settings" : "/seeker/account-settings",
        },
      });
      safeEmit(`user:${userId}`, "notification", { title: "Security Alert: Mobile Number Updated" });
    } catch (notifErr) {
      console.warn("Failed to create phone change security notification:", notifErr);
    }
  }

  return toPublicUser(updatedUser);
}

export async function changeUserPassword(
  userId: string,
  currentPassword?: string,
  newPassword?: string,
  sessionId?: string
) {
  if (!currentPassword || !newPassword) {
    const err = new Error("Current and new password are required") as any;
    err.status = 400;
    throw err;
  }

  StrongPasswordSchema.parse(newPassword);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const err = new Error("User not found") as any;
    err.status = 404;
    throw err;
  }

  if (user.passwordState === "NONE") throw Object.assign(new Error("No password is set. Verify with Google and use Set Password."), { status: 409, code: "PASSWORD_NOT_SET" });
  const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordValid) {
    const err = new Error("Current password is incorrect. Try again.") as any;
    err.status = 400;
    err.code = "CURRENT_PASSWORD_INCORRECT";
    throw err;
  }

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.$transaction(async (tx) => {
    await lockAccountLifecycle(tx, userId);
    await lockAuthenticationSession(tx, userId);
    const latest = await tx.user.findUnique({ where: { id: userId } });
    if (!latest || !latest.isActive || latest.deactivatedAt) throw Object.assign(new Error("Account inactive."), { status: 403 });
    if (sessionId && !await tx.refreshToken.findFirst({ where: { id: sessionId, userId, expiresAt: { gt: new Date() } } })) throw Object.assign(new Error("Your session ended. Sign in again."), { status: 401 });
    if (latest.passwordHash !== user.passwordHash) throw Object.assign(new Error("Your password changed in another session. Enter your current password again."), { status: 409, code: "CURRENT_PASSWORD_CHANGED" });
    await tx.user.update({ where: { id: userId }, data: { passwordHash: newHash, passwordState: "SET" } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });
    await tx.refreshToken.deleteMany({ where: { userId } });
  });
  await disconnectUserSockets(userId, "Your password changed successfully. Please sign in again.", "PASSWORD_CHANGED");

  return { success: true };
}

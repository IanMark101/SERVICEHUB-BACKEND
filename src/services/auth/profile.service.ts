import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { SALT_ROUNDS, toPublicUser } from "./authentication.service";
import { disconnectUserSockets, safeEmit } from "../../lib/socket";
import { lockAuthenticationSession } from "./session-lifecycle.service";
import { lockAccountLifecycle } from "../account-lifecycle.service";
import { StrongPasswordSchema } from "../../schema/password.schema";

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

  const reviews = await prisma.review.findMany({
    where: { targetId: userId, visibility: "VISIBLE" },
    include: {
      author: {
        select: { id: true, name: true, avatarUrl: true },
      },
      completedService: { select: { seekerId: true, providerId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const avgRatingResult = await prisma.review.aggregate({
    where: { targetId: userId, visibility: "VISIBLE", completedService: { providerId: userId } },
    _avg: { rating: true },
  });

  return {
    ...user,
    completedServiceCount: completedCount,
    averageRating: avgRatingResult._avg.rating ? Number(avgRatingResult._avg.rating.toFixed(1)) : 0,
    reviews: reviews.map(r => ({
      id: r.id,
      authorName: r.author.name,
      authorAvatar: r.author.avatarUrl,
      rating: r.rating,
      comment: r.text || '',
      createdAt: r.createdAt,
      reviewContext: r.completedService.providerId === userId ? "PROVIDER" : "SEEKER",
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

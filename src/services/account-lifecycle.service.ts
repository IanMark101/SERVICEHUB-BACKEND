import type { Prisma } from "@prisma/client";

// Use the existing account-deletion lock key for every new relationship commit
// and eligibility change. Sorted acquisition prevents two-party deadlocks.
export async function lockAccountLifecycle(tx: Prisma.TransactionClient, ...userIds: string[]) {
  for (const userId of [...new Set(userIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-deletion:${userId}`}))`;
  }
}

export async function assertActiveMarketplaceAccount(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true, deactivatedAt: true, moderationStatus: true } });
  if (!user || user.role !== "user" || !user.isActive || user.deactivatedAt || user.moderationStatus !== "ACTIVE") {
    throw Object.assign(new Error("This account is no longer eligible for marketplace changes."), { status: 403 });
  }
}

export async function marketplaceParticipantsEligible(tx: Prisma.TransactionClient, seekerId: string, providerId: string) {
  const users = await tx.user.findMany({
    where: { id: { in: [seekerId, providerId] } },
    select: { id: true, role: true, isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true },
  });
  return users.length === 2 && users.every(user => user.role === "user"
    && user.isActive && user.moderationStatus === "ACTIVE"
    && user.emailVerified && user.verificationStatus === "APPROVED");
}

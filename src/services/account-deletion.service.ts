import { prisma } from "../lib/prisma";
import { getUserActiveCaseCounts } from "./data-retention.service";

function httpError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

export async function requestAccountDeletion(userId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-deletion:${userId}`}))`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw httpError("User not found", 404);
    if (user.role === "admin") throw httpError("Administrator accounts require a separate governance process", 403);

    const activeCases = await getUserActiveCaseCounts(tx, userId);
    const blockers = Object.entries(activeCases)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({ type, count }));
    const status = blockers.length > 0 ? "BLOCKED" : "PENDING";
    return tx.accountDeletionRequest.upsert({
      where: { userId },
      create: { userId, status, blockers },
      update: { status, blockers, requestedAt: new Date(), completedAt: null },
    });
  });
}

export async function getAccountDeletionRequest(userId: string) {
  return prisma.accountDeletionRequest.findUnique({ where: { userId } });
}

export async function cancelAccountDeletionRequest(userId: string) {
  const existing = await prisma.accountDeletionRequest.findUnique({ where: { userId } });
  if (!existing) throw httpError("Account deletion request not found", 404);
  if (existing.status === "COMPLETED") throw httpError("Completed deletion requests cannot be cancelled", 409);
  return prisma.accountDeletionRequest.update({ where: { userId }, data: { status: "CANCELLED", blockers: [] } });
}

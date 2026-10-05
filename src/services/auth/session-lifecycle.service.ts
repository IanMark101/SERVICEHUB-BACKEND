import type { Prisma } from "@prisma/client";

// Session creation and all-session password revocation must serialize for the
// same user. Callers re-read credentials after acquiring this transaction lock.
export async function lockAuthenticationSession(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`auth-session:${userId}`}))`;
}

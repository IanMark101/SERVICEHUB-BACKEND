import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { disconnectUserSockets, safeBroadcast } from "../lib/socket";
import { NONTERMINAL_BOOKING_STATUSES } from "./data-retention.service";
import { lockAccountLifecycle } from "./account-lifecycle.service";
import { lockAuthenticationSession } from "./auth/session-lifecycle.service";
import type { DeleteOwnAccountInput } from "../schema/account-deletion.schema";
import { purgeAccountData } from "./account-data-purge.service";

const CHALLENGE_AUDIENCE = "servicehub-account-deletion";
const CHALLENGE_SECONDS = 300;
// A deletion challenge must never be accepted as an ordinary access JWT.
const CHALLENGE_SECRET = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(CHALLENGE_AUDIENCE).digest("base64");

function httpError(message: string, status: number, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

async function checkUser(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive || user.deactivatedAt) throw httpError("This account is no longer active.", 403);
  if (user.role === "admin") throw httpError("Administrator accounts require a separate governance process.", 403);
  return user;
}

export async function getDeletionEligibilityInTransaction(tx: Prisma.TransactionClient, userId: string) {
  // Prisma's adapter schema option qualifies ORM queries, but raw SQL still
  // needs the same transaction-local schema (including isolated test schemas).
  const schema = new URL(env.DATABASE_URL).searchParams.get("schema") || "public";
  await tx.$executeRaw`SELECT set_config('search_path', quote_ident(${schema}), true)`;
  const bookingScope = Prisma.sql`(b."seekerId" = ${userId} OR b."providerId" = ${userId})`;
  const nonterminal = Prisma.sql`b.status::text IN (${Prisma.join([...NONTERMINAL_BOOKING_STATUSES])})`;
  // One round trip and one consistent statement snapshot for the whole checklist.
  // All values remain bound parameters, including the authenticated account id.
  const [counts] = await tx.$queryRaw<Array<Record<string, number>>>(Prisma.sql`SELECT
    (SELECT count(*)::int FROM services WHERE "providerId" = ${userId} AND status = 'ACTIVE') AS "activeListings",
    (SELECT count(*)::int FROM service_requests WHERE "seekerId" = ${userId} AND status = 'OPEN') AS "openRequests",
    (SELECT count(*)::int FROM bookings b WHERE ${bookingScope} AND ${nonterminal}) AS "nonterminalBookings",
    (SELECT count(*)::int FROM bookings b WHERE ${bookingScope} AND "paymentStatus" IN ('PAID_HELD', 'FROZEN_HELD')) AS "heldPayments",
    (SELECT count(*)::int FROM cancellation_requests c JOIN bookings b ON b.id = c."bookingId" WHERE ${bookingScope}
      AND (c.status IN ('PENDING', 'ESCALATED', 'UNDER_REVIEW') OR (c.status = 'DECLINED' AND ${nonterminal}))) AS cancellations,
    (SELECT count(*)::int FROM reports WHERE ("reporterId" = ${userId} OR "reportedUserId" = ${userId}) AND status IN ('PENDING', 'UNDER_REVIEW')) AS reports,
    (SELECT count(*)::int FROM completion_escalations c JOIN bookings b ON b.id = c."bookingId" WHERE ${bookingScope} AND c.status IN ('PENDING', 'UNDER_REVIEW')) AS "completionEscalations",
    (SELECT count(*)::int FROM payment_attempts WHERE ("seekerId" = ${userId} OR "providerId" = ${userId}) AND status IN ('PENDING', 'REFUND_REQUIRED')) AS "paymentAttempts",
    (SELECT count(*)::int FROM payment_refunds r WHERE r.status IN ('PENDING', 'PROCESSING', 'FAILED') AND
      (r."requestedById" = ${userId} OR EXISTS (SELECT 1 FROM bookings b WHERE b.id = r."bookingId" AND ${bookingScope})
       OR EXISTS (SELECT 1 FROM payment_attempts a WHERE a.id = r."paymentAttemptId" AND (a."seekerId" = ${userId} OR a."providerId" = ${userId})))) AS "unresolvedRefunds",
    (SELECT count(*)::int FROM service_verifications WHERE "userId" = ${userId} AND "legalHold" = true) AS "verificationHolds",
    (SELECT count(*)::int FROM admin_resolution_operations o JOIN bookings b ON b.id = o."bookingId" WHERE ${bookingScope}
      AND o.status IN ('PROCESSING', 'FAILED_RETRYABLE') AND o.stage <> 'CASE_FINALIZED') AS "resolutionOperations",
    (SELECT count(*)::int FROM ban_appeals WHERE "userId" = ${userId} AND status = 'PENDING') AS "banAppeals",
    (SELECT count(*)::int FROM queue WHERE ("seekerId" = ${userId} OR "providerId" = ${userId}) AND status IN ('WAITING', 'SERVING')) AS "queueJobs",
    (SELECT count(*)::int FROM content_moderation_cases c WHERE c.status IN ('OPEN', 'UNDER_REVIEW') AND
      (c."submitterId" = ${userId} OR c."contentOwnerId" = ${userId}
       OR (c."contentType" = 'SERVICE_LISTING' AND EXISTS (SELECT 1 FROM services s WHERE s.id = c."resourceId" AND s."providerId" = ${userId}))
       OR (c."contentType" = 'SERVICE_REQUEST' AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = c."resourceId" AND r."seekerId" = ${userId})))) AS "contentCases"`);
  const blockers = Object.entries(counts).filter(([, count]) => count > 0).map(([type, count]) => ({ type, count }));
  return { eligible: blockers.length === 0, counts, blockers, googleAvailable: Boolean(env.GOOGLE_CLIENT_ID) };
}

export async function getAccountDeletionEligibility(userId: string) {
  return prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, userId);
    const user = await checkUser(tx, userId);
    return { ...await getDeletionEligibilityInTransaction(tx, userId), passwordAvailable: user.passwordState === "SET" || (user.passwordState === "LEGACY_UNCONFIRMED" && !user.googleSubject) };
  }, { timeout: 15_000 });
}

export async function purgePreviouslyDeletedAccount(userId: string) {
  return prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, userId);
    await lockAuthenticationSession(tx, userId);
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return { deleted: true as const, alreadyAbsent: true };
    // This operational path cannot delete a live, banned, or merely suspended
    // account. Only the exact tombstone written by the old flow is eligible.
    if (user.role !== "user" || user.isActive || !user.deactivatedAt || user.name !== "Deleted account"
      || user.email !== `${user.id}@deleted.servicehub.invalid`) {
      throw httpError("Only an account already deleted by the previous flow can be purged here.", 403);
    }
    const eligibility = await getDeletionEligibilityInTransaction(tx, userId);
    if (!eligibility.eligible) return { deleted: false as const, eligibility };
    await purgeAccountData(tx, userId);
    return { deleted: true as const, alreadyAbsent: false };
  }, { timeout: 60_000 });
}

export function createDeletionGoogleChallenge(userId: string, sessionId: string) {
  if (!env.GOOGLE_CLIENT_ID) throw httpError("Google verification is unavailable. Use your password or reset it securely.", 503);
  const nonce = crypto.randomBytes(32).toString("hex");
  const challenge = jwt.sign({ sub: userId, sid: sessionId, nonce }, CHALLENGE_SECRET, {
    algorithm: "HS256", audience: CHALLENGE_AUDIENCE, expiresIn: CHALLENGE_SECONDS,
  });
  return { nonce, challenge, expiresInSeconds: CHALLENGE_SECONDS };
}

export async function verifyDeletionGoogleCredential(userId: string, sessionId: string, email: string, credential: string, challenge: string, googleSubject?: string | null) {
  let claims: JwtPayload;
  try {
    claims = jwt.verify(challenge, CHALLENGE_SECRET, { algorithms: ["HS256"], audience: CHALLENGE_AUDIENCE }) as JwtPayload;
    if (claims.sub !== userId || claims.sid !== sessionId || typeof claims.nonce !== "string") throw new Error("Wrong challenge");
  } catch {
    throw httpError("Google verification expired. Start verification again.", 403, "REAUTHENTICATION_FAILED");
  }
  if (!env.GOOGLE_CLIENT_ID) throw httpError("Google verification is unavailable. Use your password or reset it securely.", 503);
  let response: Response;
  try {
    response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw httpError("Google verification could not connect. Try again or use your password.", 503);
  }
  if (!response.ok) throw httpError("Google verification failed. Start verification again.", 403, "REAUTHENTICATION_FAILED");
  const data = await response.json() as Record<string, unknown>;
  if (googleSubject && data.sub !== googleSubject) throw httpError("Use your connected Google account for fresh verification.", 403, "REAUTHENTICATION_FAILED");
  const now = Math.floor(Date.now() / 1000);
  if (data.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(String(data.iss))
    || ![true, "true"].includes(data.email_verified as boolean | string)
    || typeof data.email !== "string" || data.email.toLowerCase() !== email.toLowerCase()
    || typeof data.sub !== "string" || !data.sub || data.nonce !== claims.nonce
    || !Number.isFinite(Number(data.exp)) || Number(data.exp) <= now
    || !Number.isFinite(Number(data.iat)) || Number(data.iat) < now - CHALLENGE_SECONDS || Number(data.iat) > now + 30
    || Number(data.iat) < Number(claims.iat) - 5) {
    throw httpError("Verify with the same Google account shown here, using a fresh verification.", 403, "REAUTHENTICATION_FAILED");
  }
}

export async function deleteOwnAccount(userId: string, sessionId: string, input: DeleteOwnAccountInput) {
  // No slow credential/network verification holds database locks.
  const snapshot = await prisma.user.findUnique({ where: { id: userId } });
  if (!snapshot || snapshot.role === "admin" || !snapshot.isActive || snapshot.deactivatedAt) throw httpError("This account cannot be deleted through this flow.", 403);
  if (input.method === "password") {
    if (snapshot.passwordState === "NONE") throw httpError("No ServiceHub password is set. Verify with Google instead.", 403, "REAUTHENTICATION_FAILED");
    if (!await bcrypt.compare(input.password, snapshot.passwordHash)) throw httpError("Your current password is incorrect. Try again or reset your password.", 403, "REAUTHENTICATION_FAILED");
  } else {
    await verifyDeletionGoogleCredential(userId, sessionId, snapshot.email, input.credential, input.challenge, snapshot.googleSubject);
  }

  const result = await prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, userId);
    await lockAuthenticationSession(tx, userId);
    const user = await checkUser(tx, userId);
    const session = await tx.refreshToken.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId || session.expiresAt <= new Date()) throw httpError("Your session expired. Sign in again before deleting your account.", 401);
    if (user.passwordHash !== snapshot.passwordHash || user.email !== snapshot.email) throw httpError("Your account credentials changed. Verify your account again.", 403, "REAUTHENTICATION_FAILED");
    const eligibility = await getDeletionEligibilityInTransaction(tx, userId);
    if (!eligibility.eligible) return { deleted: false as const, eligibility };

    await purgeAccountData(tx, userId);
    return { deleted: true as const };
  }, { timeout: 60_000 });
  if (result.deleted) {
    // Committed deletion stays successful if best-effort socket cleanup fails.
    try { await disconnectUserSockets(userId, "Your account has been deleted.", "ACCOUNT_DELETED"); } catch { /* Sessions are already revoked. */ }
    safeBroadcast("SERVICE_LISTINGS_CHANGED", { providerId: userId });
    safeBroadcast("SERVICE_REQUESTS_CHANGED", { seekerId: userId });
    safeBroadcast("ENGAGEMENT_CHANGED", {});
    safeBroadcast("message_notification", {});
  }
  return result;
}

import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { lockAccountLifecycle } from "../account-lifecycle.service";
import { lockAuthenticationSession } from "./session-lifecycle.service";
import { StrongPasswordSchema } from "../../schema/password.schema";

const PURPOSE = "servicehub-password-setup";
const SECRET = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(PURPOSE).digest("base64");
const TTL = 300;
const fail = (message: string, status: number, code: string) => Object.assign(new Error(message), { status, code });

export function signInMethods(user: { passwordState: string; googleSubject: string | null }) {
  return { passwordEnabled: user.passwordState === "SET", googleConnected: Boolean(user.googleSubject),
    legacyPasswordUnconfirmed: user.passwordState === "LEGACY_UNCONFIRMED" };
}

async function activeSession(tx: Prisma.TransactionClient, userId: string, sessionId: string) {
  await lockAccountLifecycle(tx, userId);
  await lockAuthenticationSession(tx, userId);
  const user = await tx.user.findUnique({ where: { id: userId } });
  const session = await tx.refreshToken.findFirst({ where: { id: sessionId, userId, expiresAt: { gt: new Date() } } });
  if (!user || !user.isActive || user.deactivatedAt || user.moderationStatus === "BANNED" || !session)
    throw fail("Your session ended. Sign in again before managing your password.", 401, "SESSION_EXPIRED");
  return user;
}

export async function getSecurityMethods(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { ...signInMethods(user), email: user.email, googleAvailable: Boolean(env.GOOGLE_CLIENT_ID) };
}

function signProof(payload: Record<string, unknown>, kind: "challenge" | "grant") {
  return jwt.sign({ ...payload, kind }, SECRET, { algorithm: "HS256", audience: PURPOSE, expiresIn: TTL });
}

export function readPasswordProof(proof: string, userId: string, sessionId: string, kind: "challenge" | "grant") {
  try {
    const claims = jwt.verify(proof, SECRET, { algorithms: ["HS256"], audience: PURPOSE }) as JwtPayload;
    if (claims.sub !== userId || claims.sid !== sessionId || claims.kind !== kind || typeof claims.googleSubject !== "string") throw new Error();
    return claims;
  } catch { throw fail("Google verification expired. Verify with Google again.", 403, "GOOGLE_VERIFICATION_EXPIRED"); }
}

export async function startPasswordSetup(userId: string, sessionId: string) {
  if (!env.GOOGLE_CLIENT_ID) throw fail("Google verification is temporarily unavailable. Try again later.", 503, "GOOGLE_UNAVAILABLE");
  return prisma.$transaction(async tx => {
    const user = await activeSession(tx, userId, sessionId);
    if (user.passwordState === "SET") throw fail("A password is already set. Use Change Password.", 409, "PASSWORD_ALREADY_SET");
    if (!user.googleSubject && user.passwordState !== "LEGACY_UNCONFIRMED") throw fail("Sign in with Google first to connect and verify your Google account.", 409, "GOOGLE_NOT_CONNECTED");
    const nonce = crypto.randomBytes(32).toString("hex");
    return { nonce, challenge: signProof({ sub: userId, sid: sessionId, googleSubject: user.googleSubject ?? "", email: user.email, nonce }, "challenge"), expiresInSeconds: TTL };
  });
}

export async function verifyPasswordGoogleClaims(credential: string, claims: JwtPayload) {
  let response: Response;
  try { response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(10_000) }); }
  catch { throw fail("Could not reach Google. Check your connection and try again.", 503, "GOOGLE_UNAVAILABLE"); }
  if (!response.ok) throw fail("Google could not verify your identity. Try again.", 403, "GOOGLE_VERIFICATION_FAILED");
  const data = await response.json() as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (!env.GOOGLE_CLIENT_ID || data.aud !== env.GOOGLE_CLIENT_ID
    || !["accounts.google.com", "https://accounts.google.com"].includes(String(data.iss))
    || ![true, "true"].includes(data.email_verified as boolean | string)
    || typeof data.sub !== "string" || !data.sub
    || (claims.googleSubject ? data.sub !== claims.googleSubject : typeof data.email !== "string" || data.email.toLowerCase() !== String(claims.email).toLowerCase())
    || data.nonce !== claims.nonce
    || !Number.isFinite(Number(data.exp)) || Number(data.exp) <= now
    || !Number.isFinite(Number(data.iat)) || Number(data.iat) < now - TTL
    || Number(data.iat) > now + 30 || Number(data.iat) < Number(claims.iat) - 30)
    throw fail("Use the connected Google account and complete a fresh verification.", 403, "GOOGLE_VERIFICATION_FAILED");
  return data.sub as string;
}

export async function verifyPasswordSetup(userId: string, sessionId: string, credential: string, challenge: string) {
  const claims = readPasswordProof(challenge, userId, sessionId, "challenge");
  const verifiedSubject = await verifyPasswordGoogleClaims(credential, claims);
  return prisma.$transaction(async tx => {
    const user = await activeSession(tx, userId, sessionId);
    if (user.passwordState === "SET") throw fail("A password is already set. Use Change Password.", 409, "PASSWORD_ALREADY_SET");
    if (user.googleSubject && user.googleSubject !== verifiedSubject) throw fail("Your sign-in methods changed. Verify again.", 409, "SIGN_IN_METHODS_CHANGED");
    if (!user.googleSubject) {
      if (user.passwordState !== "LEGACY_UNCONFIRMED" || user.email !== claims.email) throw fail("Your sign-in methods changed. Verify again.", 409, "SIGN_IN_METHODS_CHANGED");
      const linked = await tx.user.findUnique({ where: { googleSubject: verifiedSubject }, select: { id: true } });
      if (linked && linked.id !== userId) throw fail("This Google account is connected to another ServiceHub account.", 409, "SIGN_IN_METHODS_CHANGED");
      await tx.user.update({ where: { id: userId }, data: { googleSubject: verifiedSubject, googleConnectedAt: new Date(), emailVerified: true } });
    }
    // The hash is used only as a snapshot to detect concurrent credential changes.
    const version = crypto.createHash("sha256").update(user.passwordHash).digest("hex");
    return { grant: signProof({ sub: userId, sid: sessionId, googleSubject: verifiedSubject, version }, "grant"), expiresInSeconds: TTL };
  });
}

export async function setUserPassword(userId: string, sessionId: string, grant: string, newPassword: string) {
  StrongPasswordSchema.parse(newPassword);
  const claims = readPasswordProof(grant, userId, sessionId, "grant");
  const passwordHash = await bcrypt.hash(newPassword, 12);
  return prisma.$transaction(async tx => {
    const user = await activeSession(tx, userId, sessionId);
    readPasswordProof(grant, userId, sessionId, "grant");
    if (user.passwordState === "SET") throw fail("A password is already set. Use Change Password.", 409, "PASSWORD_ALREADY_SET");
    if (user.googleSubject !== claims.googleSubject || crypto.createHash("sha256").update(user.passwordHash).digest("hex") !== claims.version)
      throw fail("Your sign-in methods changed. Verify again.", 409, "SIGN_IN_METHODS_CHANGED");
    // Creation consumes the grant logically: SET can never enter this path again.
    await tx.user.update({ where: { id: userId }, data: { passwordHash, passwordState: "SET" } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });
    // Preserve the freshly Google-verified session; revoke every other device.
    await tx.refreshToken.deleteMany({ where: { userId, id: { not: sessionId } } });
    return { passwordEnabled: true, googleConnected: true, legacyPasswordUnconfirmed: false };
  });
}

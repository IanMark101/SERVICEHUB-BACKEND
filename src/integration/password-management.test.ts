import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import app from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { forgotPassword, loginUser, googleLoginUser, resetPassword } from "../services/auth/authentication.service";

test("Google only, dual methods, local and legacy password lifecycle with real database/session guards", async t => {
  const tag = `password-qa-${crypto.randomUUID()}`; const ids: string[] = [];
  const oldClient = env.GOOGLE_CLIENT_ID; env.GOOGLE_CLIENT_ID = "password-qa-client";
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  const originalFetch = globalThis.fetch; const claims = new Map<string, Record<string, unknown>>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      const data = claims.get(new URL(url).searchParams.get("id_token")!);
      return new Response(JSON.stringify(data ?? {}), { status: data ? 200 : 401 });
    }
    return originalFetch(input, options);
  });
  t.after(async () => {
    env.GOOGLE_CLIENT_ID = oldClient;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });
  const password = "Fixture-password-2026!";
  const tokenClaims = (subject: string, email: string, nonce?: string) => ({ sub: subject, email, name: "Password QA", aud: env.GOOGLE_CLIENT_ID, iss: "https://accounts.google.com", email_verified: true, exp: Math.floor(Date.now()/1000)+300, iat: Math.floor(Date.now()/1000), ...(nonce ? { nonce } : {}) });
  const send = (route: string, bearer?: string, body?: unknown) => fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const session = async (userId: string) => {
    const record = await prisma.refreshToken.create({ data: { userId, token: crypto.randomUUID(), expiresAt: new Date(Date.now()+300_000) } });
    return { id: record.id, bearer: jwt.sign({ sub: userId, sid: record.id, role: "user" }, env.JWT_ACCESS_SECRET, { expiresIn: "5m" }) };
  };
  assert.equal((await send("/security")).status, 401);
  const googleEmail = `${tag}-google@example.test`; const googleSubject = `${tag}-subject`;
  claims.set("google-signup-credential", tokenClaims(googleSubject, googleEmail));
  const google = await googleLoginUser("google-signup-credential"); ids.push(google.user.id);
  assert.equal(google.user.signInMethods.passwordEnabled, false); assert.equal(google.user.signInMethods.googleConnected, true);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: google.user.id } })).passwordState, "NONE");
  const keeper = await session(google.user.id); const anotherDevice = await session(google.user.id);
  // Even a test hash with a known value cannot enable login for a NONE account.
  await prisma.user.update({ where: { id: google.user.id }, data: { passwordHash: await bcrypt.hash(password, 4) } });
  await assert.rejects(loginUser({ email: googleEmail, password }), /Invalid credentials/);
  await forgotPassword(googleEmail);
  assert.equal(await prisma.passwordResetToken.count({ where: { userId: google.user.id } }), 0);
  const resetToken = crypto.randomUUID();
  await prisma.passwordResetToken.create({ data: { userId: google.user.id, token: crypto.createHash("sha256").update(resetToken).digest("hex"), expiresAt: new Date(Date.now()+300_000) } });
  await assert.rejects(resetPassword(resetToken, password), /Invalid or expired/);
  const challengeResponse = await send("/password-setup/challenge", keeper.bearer, {}); assert.equal(challengeResponse.status, 200);
  const challenge = (await challengeResponse.json() as any).data;
  claims.set("bad-google-verification-credential", tokenClaims("attacker", googleEmail, challenge.nonce));
  assert.equal((await send("/password-setup/verify", keeper.bearer, { challenge: challenge.challenge, credential: "bad-google-verification-credential" })).status, 403);
  claims.set("good-google-verification-credential", tokenClaims(googleSubject, googleEmail, challenge.nonce));
  assert.equal((await send("/password-setup/verify", anotherDevice.bearer, { challenge: challenge.challenge, credential: "good-google-verification-credential" })).status, 403);
  const verified = await send("/password-setup/verify", keeper.bearer, { challenge: challenge.challenge, credential: "good-google-verification-credential" }); assert.equal(verified.status, 200);
  const { grant } = (await verified.json() as any).data;
  assert.equal((await send("/set-password", keeper.bearer, { grant, newPassword: "weak", confirmPassword: "weak" })).status, 400);
  assert.equal((await send("/set-password", keeper.bearer, { grant, newPassword: password, confirmPassword: "different" })).status, 400);
  const results = await Promise.all([0,1].map(() => send("/set-password", keeper.bearer, { grant, newPassword: password, confirmPassword: password })));
  assert.deepEqual(results.map(result => result.status).sort(), [200,409]);
  assert.equal((await send("/set-password", keeper.bearer, { grant, newPassword: password, confirmPassword: password })).status, 409);
  assert.equal((await send("/security", anotherDevice.bearer)).status, 401);
  const methods = await send("/security", keeper.bearer); assert.equal(methods.status, 200);
  assert.equal((await methods.json() as any).data.passwordEnabled, true);
  assert.equal((await loginUser({ email: googleEmail, password })).user.id, google.user.id);
  assert.equal((await googleLoginUser("google-signup-credential")).user.id, google.user.id);

  const local = await prisma.user.create({ data: { name: "Local password QA", email: `${tag}-local@example.test`, passwordHash: await bcrypt.hash(password, 4), passwordState: "SET", phone: "", location: "Cordova", verificationStatus: "APPROVED", emailVerified: true, trustScore: 77 } }); ids.push(local.id);
  const localSession = await session(local.id); const localOther = await session(local.id);
  const wrong = await send("/change-password", localSession.bearer, { currentPassword: "wrong", newPassword: password, confirmPassword: password }); assert.equal(wrong.status, 400); assert.equal((await wrong.json() as any).code, "CURRENT_PASSWORD_INCORRECT");
  const nextPassword = "Replacement-password-2026!";
  const changed = await send("/change-password", localSession.bearer, { currentPassword: password, newPassword: nextPassword, confirmPassword: nextPassword }); assert.equal(changed.status, 200);
  assert.equal((await send("/security", localSession.bearer)).status, 401); assert.equal((await send("/security", localOther.bearer)).status, 401);
  await assert.rejects(loginUser({ email: local.email, password }), /Invalid credentials/);
  const localLogin = await loginUser({ email: local.email, password: nextPassword }); assert.equal(localLogin.user.signInMethods.googleConnected, false);
  assert.equal(localLogin.user.verificationStatus, "APPROVED"); assert.equal(localLogin.user.trustScore, 77);
  claims.set("local-google-login-credential", tokenClaims(`${tag}-local-subject`, local.email));
  const dual = await googleLoginUser("local-google-login-credential"); assert.equal(dual.user.id, local.id); assert.equal(dual.user.signInMethods.passwordEnabled, true); assert.equal(dual.user.signInMethods.googleConnected, true);
  const localReset = crypto.randomUUID();
  await prisma.passwordResetToken.create({ data: { userId: local.id, token: crypto.createHash("sha256").update(localReset).digest("hex"), expiresAt: new Date(Date.now()+300_000) } });
  const resetResponse = await send("/reset-password", undefined, { token: localReset, password, confirmPassword: password }); assert.equal(resetResponse.status, 200);
  await assert.rejects(resetPassword(localReset, password), /Invalid or expired/);
  assert.equal((await send("/security", dual.tokens.accessToken)).status, 401);
  assert.equal((await loginUser({ email: local.email, password })).user.signInMethods.googleConnected, true);

  const legacy = await prisma.user.create({ data: { name: "Legacy QA", email: `${tag}-legacy@example.test`, passwordHash: await bcrypt.hash(password, 4), phone: "", location: "Cordova" } }); ids.push(legacy.id);
  assert.equal(legacy.passwordState, "LEGACY_UNCONFIRMED");
  const legacyLogin = await loginUser({ email: legacy.email, password }); assert.equal(legacyLogin.user.signInMethods.passwordEnabled, true);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } })).passwordState, "SET");
  const legacyGoogle = await prisma.user.create({ data: { name: "Legacy Google QA", email: `${tag}-legacy-google@example.test`, passwordHash: await bcrypt.hash(crypto.randomUUID(), 4), phone: "", location: "Cordova" } }); ids.push(legacyGoogle.id);
  const legacySession = await session(legacyGoogle.id);
  const legacyChallenge = (await (await send("/password-setup/challenge", legacySession.bearer, {})).json() as any).data;
  claims.set("legacy-google-verification-credential", tokenClaims(`${tag}-legacy-google-sub`, legacyGoogle.email, legacyChallenge.nonce));
  const legacyVerified = await send("/password-setup/verify", legacySession.bearer, { challenge: legacyChallenge.challenge, credential: "legacy-google-verification-credential" }); assert.equal(legacyVerified.status, 200);
  const legacyGrant = (await legacyVerified.json() as any).data.grant;
  assert.equal((await send("/set-password", legacySession.bearer, { grant: legacyGrant, newPassword: password, confirmPassword: password })).status, 200);
  const restored = await loginUser({ email: legacyGoogle.email, password }); assert.equal(restored.user.signInMethods.googleConnected, true);
  console.log("Verified real DB: Google-only setup, single-use/race rejection, dual login, current-password error, all-device revocation, legacy recovery, unchanged residency/trust.");
});

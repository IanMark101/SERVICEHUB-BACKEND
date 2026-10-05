import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { StrongPasswordSchema, SetPasswordSchema } from "./password.schema";
import { ChangePasswordSchema, ResetPasswordSchema } from "./auth.schema";
import { readPasswordProof, signInMethods, verifyPasswordGoogleClaims } from "../services/auth/password-management.service";
import { env } from "../config/env";

test("password rules require all five requirements, matching confirmation, and bcrypt byte safety", () => {
  for (const value of ["Ab1!", "abcdefgh1!", "ABCDEFGH1!", "Abcdefgh!", "Abcdefgh1", "Abcdefg1 ", `Ab1!${"🙂".repeat(18)}`]) assert.equal(StrongPasswordSchema.safeParse(value).success, false, value);
  assert.equal(StrongPasswordSchema.safeParse("Safe-password-2026!").success, true);
  assert.equal(SetPasswordSchema.safeParse({ grant: "g".repeat(30), newPassword: "Safe-password-2026!", confirmPassword: "different" }).success, false);
  assert.equal(ChangePasswordSchema.safeParse({ currentPassword: "old", newPassword: "Safe-password-2026!", confirmPassword: "different" }).success, false);
  assert.equal(ChangePasswordSchema.safeParse({ currentPassword: "old", newPassword: "Safe-password-2026!" }).success, false);
  assert.equal(ResetPasswordSchema.safeParse({ token: "token", password: "Safe-password-2026!" }).success, false);
});

test("sign-in methods are explicit and never inferred from a password hash", () => {
  assert.deepEqual(signInMethods({ passwordState: "NONE", googleSubject: "google-id" }), { passwordEnabled: false, googleConnected: true, legacyPasswordUnconfirmed: false });
  assert.equal(signInMethods({ passwordState: "SET", googleSubject: "google-id" }).passwordEnabled, true);
  assert.equal(signInMethods({ passwordState: "SET", googleSubject: null }).googleConnected, false);
  assert.equal(signInMethods({ passwordState: "LEGACY_UNCONFIRMED", googleSubject: null }).passwordEnabled, false);
});

test("Google setup proofs require correct purpose, owner, session, subject, nonce and fresh claims", async t => {
  const prior = env.GOOGLE_CLIENT_ID; env.GOOGLE_CLIENT_ID = "password-test-client";
  t.after(() => { env.GOOGLE_CLIENT_ID = prior; });
  const secret = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update("servicehub-password-setup").digest("base64");
  const challenge = jwt.sign({ sub: "owner", sid: "session", kind: "challenge", googleSubject: "google-owner", nonce: "nonce" }, secret, { audience: "servicehub-password-setup", expiresIn: "5m" });
  const proof = readPasswordProof(challenge, "owner", "session", "challenge");
  assert.throws(() => jwt.verify(challenge, env.JWT_ACCESS_SECRET), /signature/);
  assert.throws(() => readPasswordProof(challenge, "attacker", "session", "challenge"));
  assert.throws(() => readPasswordProof(challenge, "owner", "another-session", "challenge"));
  assert.throws(() => readPasswordProof(challenge, "owner", "session", "grant"));
  const expired = jwt.sign({ sub: "owner", sid: "session", kind: "challenge", googleSubject: "google-owner" }, secret, { audience: "servicehub-password-setup", expiresIn: -1 });
  assert.throws(() => readPasswordProof(expired, "owner", "session", "challenge"));
  const now = Math.floor(Date.now() / 1000);
  const valid = { sub: "google-owner", nonce: "nonce", iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, iat: now, exp: now + 300, email_verified: true };
  let data = { ...valid };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(data)));
  await verifyPasswordGoogleClaims("credential", proof);
  for (const mismatch of [{ sub: "attacker" }, { nonce: "replayed" }, { iss: "evil" }, { aud: "another-app" }, { email_verified: false }, { iat: now - 301 }, { iat: now + 60 }, { exp: now - 1 }]) {
    data = { ...valid, ...mismatch };
    await assert.rejects(verifyPasswordGoogleClaims("credential", proof));
  }
});

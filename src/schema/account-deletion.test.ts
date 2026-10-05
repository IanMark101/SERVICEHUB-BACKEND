import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { DeleteOwnAccountSchema } from "./account-deletion.schema";
import { createDeletionGoogleChallenge, verifyDeletionGoogleCredential } from "../services/account-deletion.service";
import { env } from "../config/env";

test("deletion requires explicit acknowledgement and fresh credentials, without a target override", () => {
  assert.equal(DeleteOwnAccountSchema.safeParse({ confirmation: "DELETE" }).success, false);
  assert.equal(DeleteOwnAccountSchema.safeParse({ confirmation: "delete", method: "password", password: "valid-password" }).success, false);
  assert.equal(DeleteOwnAccountSchema.safeParse({ confirmation: "DELETE", method: "password", password: "" }).success, false);
  assert.equal(DeleteOwnAccountSchema.safeParse({ confirmation: "DELETE", method: "password", password: "valid-password", userId: "someone-else" }).success, false);
  assert.equal(DeleteOwnAccountSchema.safeParse({ confirmation: "DELETE", method: "password", password: " valid-password " }).success, true);
  assert.equal(DeleteOwnAccountSchema.safeParse({ confirmation: "DELETE", method: "google", credential: "token" }).success, false);
});

test("Google deletion verification binds owner, session, nonce, audience, issuer, and fresh claims", async t => {
  const configured = env.GOOGLE_CLIENT_ID;
  env.GOOGLE_CLIENT_ID = "test-google-client";
  t.after(() => { env.GOOGLE_CLIENT_ID = configured; });
  const { nonce, challenge } = createDeletionGoogleChallenge("owner", "session-one");
  assert.throws(() => jwt.verify(challenge, env.JWT_ACCESS_SECRET), /invalid signature/, "a deletion challenge cannot authenticate normal API requests");
  const now = Math.floor(Date.now() / 1000);
  const valid = { aud: env.GOOGLE_CLIENT_ID, iss: "https://accounts.google.com", email: "owner@example.test", email_verified: "true", sub: "google-owner", nonce, iat: now, exp: now + 300 };
  let claims = { ...valid };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(JSON.stringify(claims), { status: 200 }); });
  await verifyDeletionGoogleCredential("owner", "session-one", "owner@example.test", "test-credential", challenge);
  for (const mismatch of [{ email: "attacker@example.test" }, { nonce: "old-nonce" }, { aud: "another-app" }, { iss: "untrusted" }, { email_verified: "false" }, { iat: now - 301 }, { iat: now + 100 }, { exp: now - 1 }, { sub: "" }]) {
    claims = { ...valid, ...mismatch };
    await assert.rejects(verifyDeletionGoogleCredential("owner", "session-one", valid.email, "test-credential", challenge), /fresh verification/);
  }
  const beforeInvalidChallenge = calls;
  await assert.rejects(verifyDeletionGoogleCredential("owner", "session-two", valid.email, "test-credential", challenge), /expired/);
  await assert.rejects(verifyDeletionGoogleCredential("other-owner", "session-one", valid.email, "test-credential", challenge), /expired/);
  const challengeSecret = crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update("servicehub-account-deletion").digest("base64");
  const expired = jwt.sign({ sub: "owner", sid: "session-one", nonce }, challengeSecret, { audience: "servicehub-account-deletion", expiresIn: -1 });
  await assert.rejects(verifyDeletionGoogleCredential("owner", "session-one", valid.email, "test-credential", expired), /expired/);
  await assert.rejects(verifyDeletionGoogleCredential("owner", "session-one", valid.email, "test-credential", `${challenge}tampered`), /expired/);
  assert.equal(calls, beforeInvalidChallenge, "invalid challenges never reach Google verification");
});

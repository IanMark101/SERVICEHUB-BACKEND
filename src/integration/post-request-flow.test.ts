import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import app from "../app";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";

test("a verified seeker selects controlled urgency and historical request timing remains readable", async (t) => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^audit_20260924_[a-f0-9]{32}$/, 'Use the isolated audit runner');
  const suffix = randomUUID();
  const category = await prisma.category.create({ data: { name: `Request flow ${suffix}` } });
  const seeker = await prisma.user.create({
    data: {
      name: "Request Flow Seeker",
      email: `request-flow-${suffix}@example.test`,
      passwordHash: "test-only-unusable-hash",
      phone: `test-${suffix}`,
      location: "Cordova",
      emailVerified: true,
      verificationStatus: "APPROVED",
    },
  });
  const session = await prisma.refreshToken.create({
    data: {
      userId: seeker.id,
      token: createHash("sha256").update(`request-flow-${suffix}`).digest("hex"),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
  const accessToken = jwt.sign(
    { sub: seeker.id, role: "user", sid: session.id },
    env.JWT_ACCESS_SECRET,
    { expiresIn: "15m" },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.serviceRequest.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.refreshToken.delete({ where: { id: session.id } });
    await prisma.user.delete({ where: { id: seeker.id } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.$disconnect();
  });

  const body = {
    categoryId: category.id,
    title: "Fix kitchen faucet leak",
    description: "The faucet leaks under the sink and needs repair.",
    budgetMin: 500,
    budgetMax: 500,
    urgency: "Flexible Schedule",
    paymentMethods: { cash: true, gcash: false },
  };
  const created = await post(body);
  const createdBody = await created.json() as { success: boolean; data?: { id: string; urgency: string; paymentMethods: { cash: boolean; gcash: boolean } }; error?: string; errors?: unknown[] };
  assert.equal(created.status, 201, JSON.stringify({ request: body, response: createdBody }));
  assert.equal(createdBody.success, true);
  assert.equal(createdBody.data?.urgency, "Flexible Schedule");
  assert.deepEqual(createdBody.data?.paymentMethods, body.paymentMethods);
  assert.equal(await prisma.serviceRequest.count({ where: { seekerId: seeker.id } }), 1);

  const listed = await fetch(`http://127.0.0.1:${port}/api/requests`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(listed.status, 200, "a verified seeker can read marketplace requests");
  const listedBody = await listed.json() as { data: Array<{ id: string; paymentMethods: unknown }> };
  assert.deepEqual(listedBody.data.find(item => item.id === createdBody.data?.id)?.paymentMethods, body.paymentMethods);
  const mine = await fetch(`http://127.0.0.1:${port}/api/requests/mine`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const mineBody = await mine.json() as { data: Array<{ id: string; paymentMethods: unknown }> };
  assert.deepEqual(mineBody.data.find(item => item.id === createdBody.data?.id)?.paymentMethods, body.paymentMethods, 'selection survives reloading the owner list');

  const noMethod = await post({ ...body, paymentMethods: { cash: false, gcash: false } });
  assert.equal(noMethod.status, 400);
  const missingMethod = await post({ ...body, paymentMethods: undefined });
  assert.equal(missingMethod.status, 400);

  const invalid = await post({ ...body, urgency: "x".repeat(501) });
  assert.equal(invalid.status, 400);
  const random = await post({ ...body, urgency: 'adsfasdfadsf' });
  assert.equal(random.status, 400, 'arbitrary timing cannot be newly posted');
  const patch = (changes: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/api/requests/${createdBody.data!.id}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
  assert.equal((await patch({ urgency: 'Monday random words' })).status, 400, 'urgency edits also use the enum');
  assert.equal((await patch({ urgency: 'Needs Tomorrow' })).status, 200);
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: createdBody.data!.id } })).urgency, 'Needs Tomorrow');
  await prisma.serviceRequest.update({ where: { id: createdBody.data!.id }, data: { urgency: 'July 16 at 2 PM' } });
  const kept = await patch({ description: 'Please repair the kitchen faucet under the sink.' });
  assert.equal(kept.status, 200, 'unrelated edits preserve historical timing');
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: createdBody.data!.id } })).urgency, 'July 16 at 2 PM');
  const invalidBody = await invalid.json() as { success: boolean; error: string; errors?: Array<{ path?: string[] }> };
  assert.equal(invalidBody.error, "Validation failed");
  assert.deepEqual(invalidBody.errors?.[0]?.path, ["urgency"]);
  assert.equal(await prisma.serviceRequest.count({ where: { seekerId: seeker.id } }), 1);

  await prisma.user.update({ where: { id: seeker.id }, data: { verificationStatus: "PENDING_REVIEW" } });
  const unverified = await post(body);
  assert.equal(unverified.status, 403, "posting still requires approved residency verification");
  const unverifiedBody = await unverified.json() as { code?: string };
  assert.equal(unverifiedBody.code, "VERIFICATION_REQUIRED");
  assert.equal(await prisma.serviceRequest.count({ where: { seekerId: seeker.id } }), 1);
});

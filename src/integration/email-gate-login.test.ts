import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { loginUser } from '../services/auth/authentication.service';
import { requireEmailVerified, requireVerification } from '../middlewares/auth.middleware';

function checkGate(middleware: typeof requireEmailVerified, user: Record<string, unknown>) {
  let status = 200;
  let code: string | undefined;
  middleware(
    { user } as any,
    { status(value: number) { status = value; return this; }, json(body: { code?: string }) { code = body.code; return this; } } as any,
    () => { status = 204; },
  );
  return { status, code };
}

test('correct credentials authenticate an email-unverified account without granting marketplace access', async (t) => {
  const id = randomUUID();
  const password = 'StrongPassword123!';
  const account = await prisma.user.create({ data: {
    name: 'Email Gate Test', email: `email-gate-${id}@example.test`,
    passwordHash: await bcrypt.hash(password, 10), phone: '09123456789', location: 'Cordova',
    emailVerified: false, verificationStatus: 'UNVERIFIED',
  } });
  t.after(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId: account.id } });
    await prisma.user.deleteMany({ where: { id: account.id } });
    await prisma.$disconnect();
  });

  const result = await loginUser({ email: account.email, password });
  assert.ok(result.tokens.accessToken);
  assert.equal(result.user.emailVerified, false);
  assert.deepEqual(checkGate(requireEmailVerified, result.user as unknown as Record<string, unknown>), { status: 403, code: 'EMAIL_NOT_VERIFIED' });
  assert.deepEqual(checkGate(requireVerification, result.user as unknown as Record<string, unknown>), { status: 403, code: 'EMAIL_NOT_VERIFIED' });
});

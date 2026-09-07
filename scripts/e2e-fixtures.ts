import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';

const emails = {
  seeker: 'e2e-seeker@servicehub.example.test',
  provider: 'e2e-provider@servicehub.example.test',
  admin: 'e2e-admin@servicehub.example.test',
};
const categoryName = 'E2E Browser Services';
const password = 'ServiceHub-E2E-2026!';

async function fixtureUserIds() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(emails) } }, select: { id: true } });
  return users.map((user) => user.id);
}

async function cleanup() {
  const userIds = await fixtureUserIds();
  if (userIds.length) {
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { targetUserId: { in: userIds } }] } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: userIds } }, { reportedUserId: { in: userIds } }] } });
    await prisma.review.deleteMany({ where: { OR: [{ authorId: { in: userIds } }, { targetId: { in: userIds } }] } });
    await prisma.completionEscalation.deleteMany({ where: { requestedBy: { in: userIds } } });
    await prisma.message.deleteMany({ where: { senderId: { in: userIds } } });
    await prisma.completedService.deleteMany({ where: { OR: [{ seekerId: { in: userIds } }, { providerId: { in: userIds } }] } });
    await prisma.paymentRefund.deleteMany({ where: { requestedById: { in: userIds } } });
    await prisma.queueNotify.deleteMany({ where: { seekerId: { in: userIds } } });
    await prisma.queue.deleteMany({ where: { seekerId: { in: userIds } } });
    await prisma.cancellationRequest.deleteMany({ where: { requestedBy: { in: userIds } } });
    await prisma.booking.deleteMany({ where: { OR: [{ seekerId: { in: userIds } }, { providerId: { in: userIds } }] } });
    await prisma.paymentAttempt.deleteMany({ where: { seekerId: { in: userIds } } });
    await prisma.offer.deleteMany({ where: { providerId: { in: userIds } } });
    await prisma.serviceRequest.deleteMany({ where: { seekerId: { in: userIds } } });
    await prisma.directRequest.deleteMany({ where: { OR: [{ seekerId: { in: userIds } }, { providerId: { in: userIds } }] } });
    await prisma.serviceVerification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.service.deleteMany({ where: { providerId: { in: userIds } } });
    await prisma.accountDeletionRequest.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.category.deleteMany({ where: { name: categoryName, services: { none: {} }, serviceRequests: { none: {} } } });
}

async function setup() {
  await cleanup();
  const passwordHash = await bcrypt.hash(password, 10);
  const category = await prisma.category.create({ data: { name: categoryName } });
  const seeker = await prisma.user.create({ data: {
    name: 'E2E Seeker', email: emails.seeker, passwordHash, phone: '09170000001', location: 'Cordova, Cebu',
    emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const provider = await prisma.user.create({ data: {
    name: 'E2E Provider', email: emails.provider, passwordHash, phone: '09170000002', location: 'Cordova, Cebu',
    emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const admin = await prisma.user.create({ data: {
    name: 'E2E Administrator', email: emails.admin, passwordHash, phone: '09170000003', location: 'Cordova, Cebu',
    emailVerified: true, verificationStatus: 'APPROVED', role: 'admin',
  } });
  const directService = await prisma.service.create({ data: {
    providerId: provider.id, categoryId: category.id, title: 'E2E Direct Cash Service', titleNormalized: 'e2e direct cash service',
    description: 'Browser-test direct cash service.', price: 500, priceType: 'FIXED', serviceType: 'ONE_TIME',
    estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true, gcash: false, maya: false, card: false },
    status: 'ACTIVE', isAvailable: true,
  } });
  const offerService = await prisma.service.create({ data: {
    providerId: provider.id, categoryId: category.id, title: 'E2E Quoted Cash Service', titleNormalized: 'e2e quoted cash service',
    description: 'Browser-test quoted cash service.', price: 500, priceType: 'STARTS_AT', serviceType: 'ONE_TIME',
    estimatedDurationMins: 45, queueLimit: 3, paymentMethods: { cash: true, gcash: false, maya: false, card: false },
    status: 'ACTIVE', isAvailable: true,
  } });
  process.stdout.write(`${JSON.stringify({
    password,
    users: { seeker: { id: seeker.id, email: seeker.email }, provider: { id: provider.id, email: provider.email }, admin: { id: admin.id, email: admin.email } },
    categoryId: category.id,
    directServiceId: directService.id,
    offerServiceId: offerService.id,
  })}\n`);
}

async function ageCompletion(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { seeker: { select: { email: true } }, provider: { select: { email: true } } },
  });
  if (!booking || booking.seeker.email !== emails.seeker || booking.provider.email !== emails.provider) {
    throw new Error('Only the fixed E2E participants may use completion time travel');
  }
  if (booking.status !== 'AWAITING_CONFIRMATION') throw new Error('E2E booking is not awaiting confirmation');
  await prisma.booking.update({ where: { id: bookingId }, data: { updatedAt: new Date(Date.now() - 73 * 60 * 60 * 1000) } });
  process.stdout.write(`${JSON.stringify({ agedBookingId: bookingId })}\n`);
}

async function main() {
  if (env.NODE_ENV === 'production' || !process.argv.includes('--confirm-e2e')) {
    throw new Error('E2E fixtures require a non-production environment and --confirm-e2e');
  }
  if (process.argv.includes('cleanup')) await cleanup();
  else if (process.argv.includes('age-completion')) {
    const bookingId = process.argv[process.argv.indexOf('age-completion') + 1];
    if (!bookingId) throw new Error('age-completion requires a booking ID');
    await ageCompletion(bookingId);
  } else await setup();
}

main()
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

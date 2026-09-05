import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';

// Deliberately opt-in: all records are visibly marked as demonstration data.
async function main() {
  if (env.NODE_ENV === 'production' || !process.argv.includes('--confirm-demo-data')) {
    throw new Error('Run only against a development database with --confirm-demo-data');
  }
  const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
  const provider = await prisma.user.upsert({
    where: { email: 'defense-provider@servicehub.example.test' }, update: {},
    create: { name: 'DEMO Cordova Repair Provider', email: 'defense-provider@servicehub.example.test', passwordHash,
      phone: 'DEMO - no contact number', location: 'Cordova (demonstration)', emailVerified: true, verificationStatus: 'APPROVED' },
  });
  const category = await prisma.category.upsert({ where: { name: 'Appliance Repair' }, update: {}, create: { name: 'Appliance Repair' } });
  const title = 'DEMO Appliance Repair Service';
  const listing = await prisma.service.findFirst({ where: { providerId: provider.id, title } }) ?? await prisma.service.create({ data: {
    providerId: provider.id, categoryId: category.id, title, titleNormalized: title.toLowerCase(),
    description: 'Demonstration listing for the capstone defense. All attached bookings and feedback are fictional test data.',
    price: 500, priceType: 'FIXED', estimatedDurationMins: 30, queueLimit: 3,
    paymentMethods: { cash: true, gcash: false, maya: false, card: false }, status: 'ACTIVE', isAvailable: true,
  } });
  const comments = [
    'DEMO: The provider arrived at the agreed time and explained the appliance repair clearly.',
    'DEMO: The repair was completed carefully and the work area was left clean.',
    'DEMO: Communication was helpful. The appliance worked correctly after the repair.',
    'DEMO: The provider explained the repair cost before starting and finished as agreed.',
    'DEMO: The work was satisfactory. A short delay was communicated before arrival.',
  ];
  for (let index = 0; index < comments.length; index++) {
    const email = `defense-seeker-${index + 1}@servicehub.example.test`;
    const seeker = await prisma.user.upsert({ where: { email }, update: {}, create: {
      name: `DEMO Seeker ${index + 1}`, email, passwordHash, phone: 'DEMO - no contact number',
      location: 'Cordova (demonstration)', emailVerified: true, verificationStatus: 'APPROVED',
    } });
    if (await prisma.review.findFirst({ where: { authorId: seeker.id, targetId: provider.id } })) continue;
    await prisma.$transaction(async (tx) => {
      const direct = await tx.directRequest.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: listing.id,
        selectedPaymentMethod: 'cash', agreedPrice: 500, message: 'DEMO completed booking', status: 'ACCEPTED' } });
      const booking = await tx.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: listing.id,
        directRequestId: direct.id, originType: 'DIRECT_LISTING', paymentMethod: 'On-site Cash', agreedAmount: 500,
        status: 'COMPLETED', paymentStatus: 'CASH_CONFIRMED', started: true } });
      const completed = await tx.completedService.create({ data: { bookingId: booking.id, directRequestId: direct.id,
        seekerId: seeker.id, providerId: provider.id, finalPrice: 500, paymentStatus: 'CASH_CONFIRMED' } });
      await tx.review.create({ data: { completedServiceId: completed.id, authorId: seeker.id, targetId: provider.id,
        rating: index === 4 ? 4 : 5, text: comments[index], editableUntil: new Date() } });
    });
  }
  console.log(`Defense dataset ready: ${provider.id}. Five labelled reviews are linked to completed cash bookings.`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : 'Defense seed failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

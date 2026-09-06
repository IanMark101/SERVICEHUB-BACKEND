import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getMyNotifications, markAllAsRead } from '../controllers/notifications.controller';
import { prisma } from '../lib/prisma';
import { sendMessage } from '../services/messages.service';

function controllerResponse() {
  let statusCode = 200;
  let body: any;
  return {
    response: {
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any,
    read: () => ({ statusCode, body }),
  };
}

test('concurrent messages and notification operations remain durable and bounded', async (t) => {
  const suffix = randomUUID();
  const category = await prisma.category.create({ data: { name: `Phase 7 load ${suffix}` } });
  const [seeker, provider] = await Promise.all([
    prisma.user.create({
      data: {
        name: `Load Seeker ${suffix}`,
        email: `load-seeker-${suffix}@example.test`,
        passwordHash: 'test-only-unusable-hash',
        phone: `load-seeker-${suffix}`,
        location: 'Cordova',
        emailVerified: true,
        verificationStatus: 'APPROVED',
      },
    }),
    prisma.user.create({
      data: {
        name: `Load Provider ${suffix}`,
        email: `load-provider-${suffix}@example.test`,
        passwordHash: 'test-only-unusable-hash',
        phone: `load-provider-${suffix}`,
        location: 'Cordova',
        emailVerified: true,
        verificationStatus: 'APPROVED',
      },
    }),
  ]);
  const service = await prisma.service.create({
    data: {
      providerId: provider.id,
      categoryId: category.id,
      title: `Concurrent messages ${suffix}`,
      titleNormalized: `concurrent messages ${suffix}`,
      description: 'A service fixture used to verify concurrent communication durability.',
      price: 500,
      estimatedDurationMins: 60,
      queueLimit: 2,
      paymentMethods: { cash: true },
      status: 'ACTIVE',
      isAvailable: true,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      seekerId: seeker.id,
      providerId: provider.id,
      serviceId: service.id,
      originType: 'DIRECT_LISTING',
      paymentMethod: 'On-site Cash',
      agreedAmount: 500,
      paymentStatus: 'UNPAID',
      status: 'ACCEPTED',
    },
  });

  t.after(async () => {
    await prisma.message.deleteMany({ where: { bookingId: booking.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [seeker.id, provider.id] } } });
    await prisma.booking.delete({ where: { id: booking.id } });
    await prisma.service.delete({ where: { id: service.id } });
    await prisma.user.deleteMany({ where: { id: { in: [seeker.id, provider.id] } } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.$disconnect();
  });

  const sent = await Promise.all(
    Array.from({ length: 40 }, (_, index) => {
      const senderId = index % 2 === 0 ? seeker.id : provider.id;
      return sendMessage(booking.id, senderId, `Concurrent message ${index}`, undefined, false, 'user');
    }),
  );
  assert.equal(new Set(sent.map((message) => message.id)).size, 40);
  assert.equal(await prisma.message.count({ where: { bookingId: booking.id } }), 40);

  await prisma.notification.createMany({
    data: Array.from({ length: 120 }, (_, index) => ({
      userId: seeker.id,
      title: `Load notification ${index}`,
      body: `Durable notification ${index}`,
    })),
  });

  const readRequest = { user: { id: seeker.id } } as any;
  await Promise.all(Array.from({ length: 8 }, async () => {
    const target = controllerResponse();
    await markAllAsRead(readRequest, target.response, (error) => { throw error; });
    assert.equal(target.read().body.success, true);
  }));
  assert.equal(await prisma.notification.count({ where: { userId: seeker.id, isRead: false } }), 0);

  const listTarget = controllerResponse();
  await getMyNotifications(readRequest, listTarget.response, (error) => { throw error; });
  assert.equal(listTarget.read().statusCode, 200);
  assert.equal(listTarget.read().body.data.length, 50);
});

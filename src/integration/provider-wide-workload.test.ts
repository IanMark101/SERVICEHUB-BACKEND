import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { submitOffer } from "../services/offers.service";
import { listRequests } from "../services/requests.service";
import { createDirectFromOfferService } from "../services/bookings/direct-bookings.service";
import { finalizeSuccessfulPayment } from "../services/payment-attempt.service";
import { providerStartJob } from "../services/bookings/provider-operations.service";
import { markJobComplete } from "../services/bookings/completion.service";
import { requestCancellation } from "../services/cancellation.service";

test("listing-free offers and direct listings enter one provider-wide paid workload", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userIds: string[] = [];
  let categoryId = "";
  t.after(async () => {
    if (userIds.length) {
      await prisma.queue.deleteMany({ where: { providerId: { in: userIds } } });
      await prisma.paymentRefund.deleteMany({ where: { OR: [
        { booking: { providerId: { in: userIds } } },
        { requestedById: { in: userIds } },
      ] } });
      await prisma.booking.deleteMany({ where: { providerId: { in: userIds } } });
      await prisma.paymentAttempt.deleteMany({ where: { providerId: { in: userIds } } });
      await prisma.offer.deleteMany({ where: { providerId: { in: userIds } } });
      await prisma.serviceRequest.deleteMany({ where: { seekerId: { in: userIds } } });
      await prisma.service.deleteMany({ where: { providerId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (categoryId) await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.$disconnect();
  });
  const category = await prisma.category.create({ data: { name: `Provider work ${suffix}` } });
  categoryId = category.id;
  const createUser = async (label: string) => {
    const user = await prisma.user.create({ data: {
      name: label,
      email: `${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@example.test`,
      passwordHash: "test-only", phone: `${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
      location: "Cordova, Cebu", emailVerified: true, verificationStatus: "APPROVED",
    } });
    userIds.push(user.id);
    return user;
  };
  const provider = await createUser("Work Provider");
  const otherProviders = await Promise.all([createUser("Work Provider Two"), createUser("Work Provider Three")]);
  const seekers = await Promise.all([createUser("Work Seeker One"), createUser("Work Seeker Two"), createUser("Work Seeker Three"), createUser("Work Seeker Four")]);
  await prisma.user.update({ where: { id: provider.id }, data: { onlineQueueLimit: 3 } });
  assert.equal(await prisma.service.count({ where: { providerId: provider.id } }), 0);

  const cashRequest = await prisma.serviceRequest.create({ data: {
    seekerId: seekers[0].id, categoryId, title: `Cash job ${suffix}`, description: "A specific cash job for the provider", budgetMin: 450, budgetMax: 750, urgency: "medium",
  } });
  const cashOffer = await submitOffer(provider.id, { requestId: cashRequest.id, offeredPrice: 610, estimatedDuration: 75, message: "I can do this specific job in about 75 minutes." });
  const cashSiblings = await Promise.all(otherProviders.map((candidate, index) => submitOffer(candidate.id, { requestId: cashRequest.id, offeredPrice: 620 + index * 10, estimatedDuration: 80, message: "I can handle this repair request." })));
  assert.equal(cashOffer.serviceId, null);
  const cashBooking = await createDirectFromOfferService(cashOffer.id, seekers[0].id);
  assert.equal(cashBooking.serviceId, null);
  assert.equal(cashBooking.estimatedDurationMins, 75);
  assert.equal(await prisma.queue.count({ where: { bookingId: cashBooking.id } }), 0);
  for (const sibling of cashSiblings) {
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: sibling.id } })).status, 'REJECTED');
    assert.equal(await prisma.notification.count({ where: { id: `offer-not-selected:${sibling.id}`, userId: sibling.providerId } }), 1);
  }

  // A legacy OPEN flag must not make an already-booked request available again.
  await prisma.serviceRequest.update({ where: { id: cashRequest.id }, data: { status: "OPEN" } });
  assert.equal((await listRequests()).some((request) => request.id === cashRequest.id), false);
  await assert.rejects(
    submitOffer(provider.id, { requestId: cashRequest.id, offeredPrice: 620, estimatedDuration: 75 }),
    (error: any) => error?.code === "REQUEST_ALREADY_MATCHED",
  );
  await prisma.serviceRequest.update({ where: { id: cashRequest.id }, data: { status: "IN_PROGRESS" } });

  const onlineRequest = await prisma.serviceRequest.create({ data: {
    seekerId: seekers[1].id, categoryId, title: `Paid custom job ${suffix}`, description: "A specific paid custom job for the provider", budgetMin: 600, budgetMax: 900, urgency: "medium",
  } });
  const onlineOffer = await submitOffer(provider.id, { requestId: onlineRequest.id, offeredPrice: 800, estimatedDuration: 90, message: "This custom job should take about 90 minutes." });
  const onlineSiblings = await Promise.all(otherProviders.map((candidate, index) => submitOffer(candidate.id, { requestId: onlineRequest.id, offeredPrice: 810 + index * 10, estimatedDuration: 90, message: "I can handle this custom job." })));
  assert.equal(onlineOffer.serviceId, null);
  await prisma.offer.update({ where: { id: onlineOffer.id }, data: { status: "PENDING_PAYMENT", paymentHoldExpiresAt: new Date(Date.now() + 120_000) } });
  await prisma.serviceRequest.update({ where: { id: onlineRequest.id }, data: { status: "PAYMENT_PENDING" } });
  for (const sibling of onlineSiblings) {
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: sibling.id } })).status, 'PENDING');
    assert.equal(await prisma.notification.count({ where: { id: `offer-not-selected:${sibling.id}` } }), 0);
  }

  const listing = async (name: string, price: number, duration: number) => prisma.service.create({ data: {
    providerId: provider.id, categoryId, title: `${name} ${suffix}`, titleNormalized: `${name} ${suffix}`.toLowerCase(),
    description: "Listing used for provider-wide paid queue integration", price,
    priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: duration, queueLimit: 3,
    paymentMethods: { gcash: true, cash: true }, status: "ACTIVE", isAvailable: true,
  } });
  const firstListing = await listing("First service", 500, 30);
  const secondListing = await listing("Second service", 700, 60);
  const linkedRequest = await prisma.serviceRequest.create({ data: {
    seekerId: seekers[3].id, categoryId, title: `Linked job ${suffix}`, description: "A request using a listing only as a starting point", budgetMin: 500, budgetMax: 850, urgency: "medium",
  } });
  const linkedOffer = await submitOffer(provider.id, { requestId: linkedRequest.id, serviceId: firstListing.id, offeredPrice: 650, estimatedDuration: 45, message: "Customized from my listing." });
  assert.equal(linkedOffer.serviceId, firstListing.id);
  assert.equal(Number(linkedOffer.offeredPrice), 650);
  assert.equal(linkedOffer.estimatedDuration, 45);

  const capture = async (seekerId: string, amount: number, serviceId?: string, offerId?: string) => {
    const intentId = `pi_work_${Math.random().toString(36).slice(2)}_${suffix}`;
    const attempt = await prisma.paymentAttempt.create({ data: {
      idempotencyKey: intentId, seekerId, providerId: provider.id, serviceId: serviceId || null, offerId: offerId || null,
      providerIntentId: intentId, amount, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 120_000),
    } });
    const payload = { paymentIntentId: intentId, paymentId: `pay_${intentId}`, amount, currency: "PHP", metadata: {
      servicehub_attempt_id: attempt.id, servicehub_seeker_id: seekerId, servicehub_service_id: serviceId || "",
      servicehub_offer_id: offerId || "", servicehub_expected_amount: amount.toFixed(2), servicehub_payment_method: "gcash",
    } };
    return { attempt, first: await finalizeSuccessfulPayment(payload), duplicate: () => finalizeSuccessfulPayment(payload) };
  };

  const paidOffer = await capture(seekers[1].id, 800, undefined, onlineOffer.id);
  assert.equal(paidOffer.first.booking?.serviceId, null);
  assert.equal(paidOffer.first.booking?.status, "ACCEPTED");
  assert.equal(paidOffer.first.queue?.position, 1);
  assert.equal((await paidOffer.duplicate()).created, false);
  for (const sibling of onlineSiblings) {
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: sibling.id } })).status, 'REJECTED');
    assert.equal(await prisma.notification.count({ where: { id: `offer-not-selected:${sibling.id}`, userId: sibling.providerId } }), 1);
  }
  assert.equal(await prisma.queue.count({ where: { providerId: provider.id, status: "WAITING" } }), 1);
  await assert.rejects(providerStartJob(cashBooking.id, provider.id), (error: any) => error?.code === "PAID_WORK_WAITING");

  const listedOne = await capture(seekers[2].id, 500, firstListing.id);
  const listedTwo = await capture(seekers[3].id, 700, secondListing.id);
  assert.deepEqual([listedOne.first.queue?.position, listedTwo.first.queue?.position], [2, 3]);
  assert.deepEqual((await prisma.queue.findMany({ where: { providerId: provider.id, status: "WAITING" }, orderBy: { position: "asc" }, select: { estimatedWait: true } })).map((row) => row.estimatedWait), [0, 90, 120]);
  await assert.rejects(providerStartJob(listedTwo.first.booking!.id, provider.id), /first waiting booking/i);

  await prisma.user.update({ where: { id: provider.id }, data: { onlineQueueLimit: 1 } });
  const overCapacity = await capture(seekers[0].id, 500, firstListing.id);
  assert.equal(overCapacity.first.refundRequired, true);
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: overCapacity.attempt.id } }), 0);
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: overCapacity.attempt.id } })).status, "REFUND_REQUIRED");

  // Legacy captured bookings can still carry WAITING while their paid queue row
  // and both payment records are valid. The first one must remain startable.
  await prisma.booking.update({ where: { id: paidOffer.first.booking!.id }, data: { status: "WAITING" } });
  await providerStartJob(paidOffer.first.booking!.id, provider.id);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: paidOffer.first.booking!.id } })).status, "ONGOING");
  await assert.rejects(providerStartJob(listedOne.first.booking!.id, provider.id), (error: any) => error?.code === "PROVIDER_ALREADY_ONGOING");
  await markJobComplete(paidOffer.first.booking!.id, provider.id);
  const remaining = await prisma.queue.findMany({ where: { providerId: provider.id, status: "WAITING" }, orderBy: { position: "asc" } });
  assert.deepEqual(remaining.map((row) => row.position), [1, 2]);
  assert.deepEqual(remaining.map((row) => row.estimatedWait), [0, 30]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(`/payment_intents/${listedOne.attempt.providerIntentId}`)) {
      return new Response(JSON.stringify({ data: { id: listedOne.attempt.providerIntentId,
        attributes: { status: "succeeded", amount: 50_000, currency: "PHP", metadata: {}, payments: [{ id: `pay_${listedOne.attempt.providerIntentId}` }] } } }),
      { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected mocked payment request: ${url}`);
  }) as typeof fetch;
  try {
    const canceled = await requestCancellation(listedOne.first.booking!.id, seekers[2].id, "I no longer need the listed service.");
    assert.equal(canceled.immediate, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: listedOne.first.booking!.id } })).status, "CANCELLED");
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: listedTwo.first.booking!.id } })).position, 1);
  await assert.rejects(providerStartJob(cashBooking.id, provider.id), (error: any) => error?.code === "PAID_WORK_WAITING");
  await providerStartJob(listedTwo.first.booking!.id, provider.id);
  await markJobComplete(listedTwo.first.booking!.id, provider.id);
  await providerStartJob(cashBooking.id, provider.id);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: cashBooking.id } })).status, "ONGOING");
  await markJobComplete(cashBooking.id, provider.id);
});

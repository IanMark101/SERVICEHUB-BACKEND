import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Prisma, type PrismaClient } from '@prisma/client';

test('booking lifecycle commits before realtime publication and does not wait for queue broadcasts', async t => {
  type Row = Record<string, any>;
  const initialBooking = () => ({ id: 'booking', providerId: 'provider', seekerId: 'seeker', status: 'ACCEPTED',
    started: false, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID', agreedAmount: 500,
    updatedAt: new Date(), estimatedDurationMins: 60, directRequestId: null, offerId: null });
  let state: { booking: Row; queue: Row | null; completed: Row | null; notifications: Row[]; messages: Row[]; progress: Row[]; earnings: Row[]; trust: Row[];
    cancellations: Row[]; reports: Row[]; operations: Row[]; escalations: Row[]; directRequests: Row[]; refunds: Row[]; offers: Row[]; requests: Row[]; attempts: Row[] };
  let inTransaction = false;
  let failNotice = false;
  let otherOngoing = false;
  let refundProcessing = false;
  let slowQueueBroadcast = false;
  const broadcastFinishes: (() => void)[] = [];
  const reset = (paid = false) => {
    state = { booking: initialBooking(), queue: null, completed: null, notifications: [], messages: [], progress: [], earnings: [], trust: [],
      cancellations: [], reports: [], operations: [], escalations: [], directRequests: [], refunds: [], offers: [], requests: [], attempts: [] };
    if (paid) {
      Object.assign(state.booking, { paymentMethod: 'GCash', paymentStatus: 'PAID_HELD' });
      state.queue = { id: 'queue', bookingId: 'booking', providerId: 'provider', seekerId: 'seeker', status: 'WAITING', paymentStatus: 'PAID_HELD', position: 1, estimatedWait: 0, paymentId: 'intent', paymongoPaymentId: 'payment' };
    }
    failNotice = otherOngoing = refundProcessing = slowQueueBroadcast = false;
  };
  reset();
  const fullBooking = () => ({ ...state.booking, queue: state.queue, completedService: state.completed, offer: null,
    directRequest: state.directRequests.find(row => row.id === state.booking.directRequestId) || null });
  const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      return matches(row[key] && typeof row[key] === 'object' ? row[key] : row, value);
    }
    return row[key] === value;
  });
  const table = (key: 'cancellations' | 'reports' | 'operations' | 'escalations' | 'directRequests' | 'refunds' | 'offers' | 'requests' | 'attempts', decorate = (row: Row): Row => row) => {
    const find = ({ where }: Row) => state[key].find(row => matches(decorate(row), where));
    return {
      findUnique: async (args: Row) => { const row = find(args); return row ? decorate({ ...row }) : null; },
      findUniqueOrThrow: async (args: Row) => decorate({ ...find(args)! }),
      findFirst: async (args: Row) => { const row = find(args); return row ? decorate({ ...row }) : null; },
      findMany: async ({ where }: Row) => state[key].filter(row => matches(decorate(row), where)).map(row => decorate({ ...row })),
      count: async ({ where }: Row) => state[key].filter(row => matches(decorate(row), where)).length,
      create: async ({ data }: Row) => {
        const row = { id: `${key}-${state[key].length}`, createdAt: new Date(), resolvedAt: null, status: key === 'operations' ? 'PROCESSING' : 'PENDING', stage: 'CLAIMED', ...data };
        state[key].push(row); return decorate({ ...row });
      },
      update: async ({ where, data }: Row) => { const row = find({ where }); if (!row) throw new Error(`Missing ${key}`); Object.assign(row, data); return decorate({ ...row }); },
      updateMany: async ({ where, data }: Row) => { const rows = state[key].filter(row => matches(decorate(row), where)); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }; },
    };
  };
  const eligibility = { role: 'user', isActive: true, moderationStatus: 'ACTIVE', emailVerified: true, verificationStatus: 'APPROVED', onlineQueueLimit: 5, trustScore: 55 };
  const fake = {
    $executeRaw: async () => 0, $queryRaw: async () => [],
    booking: {
      findUnique: async ({ where }: Row) => matches(state.booking, where) ? fullBooking() : null,
      findFirst: async () => state.booking.paymentMethod === 'On-site Cash' && state.booking.status === 'ONGOING' ? state.booking : null,
      count: async () => otherOngoing ? 1 : 0,
      update: async ({ data }: Row) => { state.booking = { ...state.booking, ...data, updatedAt: new Date() }; return { ...state.booking }; },
      create: async ({ data }: Row) => { state.booking = { ...initialBooking(), ...data }; return { ...state.booking }; },
      updateMany: async () => ({ count: 0 }),
    },
    queue: {
      findUnique: async () => state.queue ? { ...state.queue, booking: fullBooking() } : null,
      findFirst: async ({ where }: Row) => state.queue?.status === where.status ? { ...state.queue, booking: state.booking } : null,
      findMany: async ({ where }: Row) => {
        if (!inTransaction && slowQueueBroadcast) return new Promise<Row[]>(resolve => { broadcastFinishes.push(() => resolve([])); });
        return state.queue?.status === where.status ? [{ ...state.queue, booking: state.booking }] : [];
      },
      count: async ({ where }: Row) => state.queue?.status === where.status ? 1 : 0,
      update: async ({ data }: Row) => { state.queue = { ...state.queue, ...data }; return state.queue; },
      create: async ({ data }: Row) => { state.queue = { id: 'queue', ...data }; return { ...state.queue }; },
      updateMany: async ({ data }: Row) => { if (!state.queue) return { count: 0 }; Object.assign(state.queue, data); return { count: 1 }; },
    },
    queueNotify: { findFirst: async () => null, deleteMany: async () => ({ count: 0 }) },
    service: { findMany: async () => [], findUnique: async () => ({ providerId: 'provider', title: 'Repair', status: 'ACTIVE', isAvailable: true, priceType: 'FIXED', price: new Prisma.Decimal(500), estimatedDurationMins: 60, paymentMethods: { cash: true }, provider: eligibility }) },
    user: { findUnique: async () => eligibility, findMany: async ({ where }: Row) => where.role === 'admin' ? [{ id: 'admin' }] : ['seeker', 'provider'].map(id => ({ id, ...eligibility })), update: async () => ({}) },
    paymentRefund: { ...table('refunds'), findUnique: async ({ where }: Row) => refundProcessing ? { status: 'PROCESSING' } : state.refunds.find(row => matches(row, where)) || null },
    notification: { create: async ({ data }: Row) => {
      assert.equal(inTransaction, true, 'durable notices belong to the transition transaction');
      if (failNotice) throw new Error('Notice storage unavailable');
      state.notifications.push(data); return data;
    }, createMany: async ({ data }: Row) => { assert.equal(inTransaction, true); state.notifications.push(...data); return { count: data.length }; } },
    message: { findFirst: async ({ where }: Row) => state.messages.find(row => matches(row, where)) || null, create: async ({ data }: Row) => {
      assert.equal(inTransaction, true);
      const message = { ...data, id: `message-${state.messages.length}`, sender: { id: data.senderId, name: data.senderId, avatarUrl: null } };
      state.messages.push(message); return message;
    } },
    bookingProgressEvent: { upsert: async ({ where, create }: Row) => {
      let event = state.progress.find(row => row.eventKey === where.bookingId_eventKey.eventKey);
      if (!event) { event = { id: `event-${state.progress.length}`, ...create }; state.progress.push(event); }
      return event;
    } },
    completedService: { create: async ({ data }: Row) => { state.completed = { id: 'completion', completedAt: new Date(), ...data }; return state.completed; } },
    completionEscalation: table('escalations'),
    cancellationRequest: table('cancellations', row => ({ ...row, booking: fullBooking(), report: state.reports.find(report => report.id === row.reportId) || null })),
    report: table('reports'), adminResolutionOperation: table('operations'),
    paymentAttempt: table('attempts'),
    directRequest: table('directRequests', row => ({ ...row, booking: fullBooking() })),
    offer: table('offers', row => ({ ...row, request: state.requests.find(request => request.id === row.requestId) })), serviceRequest: table('requests'),
    transaction: { findFirst: async ({ where }: Row) => state.earnings.find(row => matches(row, where)) || null, create: async ({ data }: Row) => { state.earnings.push(data); return data; } },
    trustScoreEvent: { findUnique: async () => null, create: async ({ data }: Row) => { state.trust.push(data); return data; } },
  };
  const singleton = globalThis as unknown as { prisma?: PrismaClient };
  const previous = singleton.prisma;
  singleton.prisma = { ...fake, $transaction: async (run: (tx: typeof fake) => unknown) => {
    const before = structuredClone(state);
    inTransaction = true;
    try { return await run(fake); } catch (error) { state = before; throw error; } finally { inTransaction = false; }
  } } as unknown as PrismaClient;
  t.after(() => { singleton.prisma = previous; });
  const { initSocket } = await import('../lib/socket');
  const io = initSocket(createServer());
  t.after(() => { io.close(); });
  const emitted: { room: string; event: string; data: Row }[] = [];
  t.mock.method(io, 'to', (room: string) => ({ emit: (event: string, data: Row) => {
    assert.equal(inTransaction, false, 'participants must never see an uncommitted transition');
    emitted.push({ room, event, data });
  } }));
  const { providerStartJob } = await import('../services/bookings/provider-operations.service');
  const { markJobComplete, confirmCompletionService, disputeJobService } = await import('../services/bookings/completion.service');
  const { requestCancellation, respondToCancellationRequest, escalateCancellationRequest, performImmediateCancel } = await import('../services/cancellation.service');
  const { createDirectRequest, respondToDirectBookingService, createDirectFromOfferService } = await import('../services/bookings/direct-bookings.service');
  const { createSafetyReport } = await import('../services/safety-report.service');
  const { createCompletionEscalation } = await import('../services/completion-escalation.service');
  const { hideBookingService } = await import('../services/bookings/booking-visibility.service');
  const { env } = await import('../config/env');
  const { finalizeSuccessfulPayment } = await import('../services/payment-attempt.service');
  const previousPaymentKey = env.PAYMONGO_SECRET_KEY;
  env.PAYMONGO_SECRET_KEY = 'sk_test_local_regression';
  t.after(() => { env.PAYMONGO_SECRET_KEY = previousPaymentKey; });
  let releaseGateway: (() => void) | null = null;
  let holdGateway = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'https://api.paymongo.com/v1/payment_intents/intent', 'never contact a real gateway');
    if (holdGateway) await new Promise<void>(resolve => { releaseGateway = resolve; });
    return new Response(JSON.stringify({ data: { id: 'intent', attributes: { status: 'succeeded', amount: 50000, currency: 'PHP', payments: [{ id: 'payment' }] } } }));
  });

  const assertBothNotified = (type: string) => {
    for (const user of ['seeker', 'provider']) assert.ok(emitted.some(event => event.room === `user:${user}` && event.data.type === type), `${user} misses ${type}`);
  };

  for (const paid of [false, true]) {
    await t.test(`${paid ? 'paid queue' : 'cash'} start, mark, confirm, and repeat confirmation`, async () => {
      reset(paid); emitted.length = 0;
      await assert.rejects(providerStartJob('booking', 'outsider'));
      const started = await providerStartJob('booking', 'provider');
      assert.equal(started.status, 'ONGOING');
      assert.equal(started.progressEvent.kind, 'STARTED');
      await assert.rejects(markJobComplete('booking', 'outsider'));
      await assert.rejects(confirmCompletionService('booking', 'seeker'), /not ready/);
      const marked = await markJobComplete('booking', 'provider');
      assert.equal(marked.status, 'AWAITING_CONFIRMATION');
      assert.equal(marked.progressEvent?.kind, 'WORK_MARKED_COMPLETE');
      await markJobComplete('booking', 'provider');
      await assert.rejects(confirmCompletionService('booking', 'provider'));
      const confirmed = await confirmCompletionService('booking', 'seeker');
      await confirmCompletionService('booking', 'seeker');
      assert.equal(confirmed.booking.status, 'COMPLETED');
      assert.equal(confirmed.progressEvent?.kind, 'COMPLETION_CONFIRMED');
      assert.equal(state.notifications.length, 3);
      assert.equal(state.messages.length, 2);
      assert.equal(state.progress.length, 3);
      assert.equal(state.earnings.length, paid ? 1 : 0);
      assert.equal(state.trust.length, 1);
      assert.equal(state.booking.paymentStatus, paid ? 'RELEASED' : 'CASH_CONFIRMED');
      for (const type of ['started', 'awaiting_confirmation', 'completed']) {
        for (const user of ['seeker', 'provider']) {
          assert.ok(emitted.some(event => event.room === `user:${user}` && event.event === 'ENGAGEMENT_CHANGED' && event.data.type === type));
        }
      }
    });
  }

  await t.test('slow queue audience discovery cannot delay either participant or the start response', async () => {
    reset(true); emitted.length = 0; slowQueueBroadcast = true;
    let timer!: ReturnType<typeof setTimeout>;
    try {
      const started = await Promise.race([providerStartJob('booking', 'provider'), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Start waited for queue audience discovery')), 500);
      })]);
      assert.equal(started.status, 'ONGOING');
      assert.equal(broadcastFinishes.length, 1);
      assert.ok(emitted.some(event => event.room === 'user:seeker' && event.data.type === 'started'));
    } finally { clearTimeout(timer); slowQueueBroadcast = false; broadcastFinishes.splice(0).forEach(finish => finish()); }
  });

  await t.test('failed persistence rolls back the transition instead of advertising a completed action', async () => {
    reset(); emitted.length = 0; failNotice = true;
    await assert.rejects(providerStartJob('booking', 'provider'), /Notice storage unavailable/);
    assert.equal(state.booking.status, 'ACCEPTED');
    assert.equal(state.progress.length, 0);
    assert.equal(emitted.length, 0);
  });

  await t.test('start still enforces the single-job and refund guards', async () => {
    reset(); otherOngoing = true;
    await assert.rejects(providerStartJob('booking', 'provider'), /current ongoing job/);
    reset(); refundProcessing = true;
    await assert.rejects(providerStartJob('booking', 'provider'), /refund.*processed/);
    assert.equal(state.booking.started, false);
  });

  await t.test('a frozen paid booking cannot settle or create wallet earnings', async () => {
    reset(true);
    state.booking.status = 'AWAITING_CONFIRMATION';
    state.booking.paymentStatus = 'FROZEN_HELD';
    await assert.rejects(confirmCompletionService('booking', 'seeker'), /payment state/);
    assert.equal(state.completed, null);
    assert.equal(state.earnings.length, 0);
  });

  for (const accept of [true, false]) {
    await t.test(`direct request ${accept ? 'accept' : 'decline'} records notices before publishing`, async () => {
      reset(); emitted.length = 0;
      state.booking.status = 'PENDING_APPROVAL'; state.booking.directRequestId = 'direct';
      state.directRequests.push({ id: 'direct', seekerId: 'seeker', providerId: 'provider', status: 'PENDING_APPROVAL' });
      await assert.rejects(respondToDirectBookingService('direct', 'outsider', accept), /Access denied/);
      const response = await respondToDirectBookingService('direct', 'provider', accept);
      assert.equal(response?.status, accept ? 'ACCEPTED' : 'DECLINED');
      assert.equal(state.notifications.length, accept ? 2 : 1);
      assert.equal(state.messages.length, accept ? 1 : 0);
      assertBothNotified(accept ? 'accepted' : 'declined');
      await assert.rejects(respondToDirectBookingService('direct', 'provider', accept));
    });
  }
  await t.test('new cash request and offer acceptance persist their own notices with the booking', async () => {
    reset(); emitted.length = 0;
    await createDirectRequest({ seekerId: 'seeker', providerId: 'provider', serviceId: 'service' });
    assert.equal(state.booking.status, 'PENDING_APPROVAL');
    assertBothNotified('created');
    reset(); emitted.length = 0;
    state.requests.push({ id: 'request', seekerId: 'seeker', status: 'OPEN', title: 'Repair', paymentMethods: { cash: true, gcash: true } });
    state.offers.push({ id: 'offer', requestId: 'request', providerId: 'provider', status: 'PENDING', offeredPrice: 500, estimatedDuration: 60 });
    const accepted = await createDirectFromOfferService('offer', 'seeker');
    assert.equal(accepted.status, 'ACCEPTED');
    assert.equal(state.requests[0].status, 'IN_PROGRESS');
    assert.equal(state.messages.length, 1);
    assert.equal(state.notifications.length, 2);
    assertBothNotified('accepted_offer');
  });

  for (const paid of [false, true]) {
    await t.test(`${paid ? 'paid' : 'cash'} cancellation remains authoritative and ignores stalled audience queries`, async () => {
      reset(paid); emitted.length = 0; slowQueueBroadcast = true;
      let finished = false;
      holdGateway = paid;
      const action = requestCancellation('booking', 'seeker', 'Cannot attend').then(result => { finished = true; return result; });
      if (paid) {
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(finished, false, 'cancellation must wait for actual payment verification');
        assert.equal(state.booking.status, 'UNDER_REVIEW');
        holdGateway = false; releaseGateway!(); releaseGateway = null;
      }
      let timer!: ReturnType<typeof setTimeout>;
      try {
        const response = await Promise.race([action, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation waited for a background query')), 500); })]);
        assert.equal(response.booking?.status, 'CANCELED');
        assert.equal(response.booking?.paymentStatus, paid ? 'REFUNDED' : 'UNPAID');
        assert.equal(state.cancellations[0].status, 'APPROVED');
        assert.equal(state.messages.length, 1);
        assert.equal(state.earnings.length, paid ? 1 : 0);
        assertBothNotified('cancellation_approved');
      } finally { clearTimeout(timer); slowQueueBroadcast = false; broadcastFinishes.splice(0).forEach(finish => finish()); }
      const count = state.notifications.length;
      await requestCancellation('booking', 'seeker', 'Cannot attend');
      await performImmediateCancel('booking', 'seeker');
      assert.equal(state.notifications.length, count);
      assert.equal(state.messages.length, 1);
    });
  }

  for (const requester of ['seeker', 'provider']) {
    await t.test(`${requester} cancellation request, decline with reason, and escalation notify both views`, async () => {
      reset(); emitted.length = 0; state.booking.status = 'ONGOING'; state.booking.started = true;
      const responder = requester === 'seeker' ? 'provider' : 'seeker';
      const request = await requestCancellation('booking', requester, 'Cannot continue');
      assert.equal(request.cancellationRequest?.status, 'PENDING');
      await requestCancellation('booking', requester, 'Cannot continue');
      assert.equal(state.notifications.length, 1);
      await assert.rejects(respondToCancellationRequest(state.cancellations[0].id, requester, false, 'Continue work'));
      const decline = await respondToCancellationRequest(state.cancellations[0].id, responder, false, 'Continue work') as Row;
      assert.equal(decline.cancellationRequest.status, 'DECLINED');
      assert.equal(decline.cancellationRequest.responderNote, 'Continue work');
      const escalated = await escalateCancellationRequest(state.cancellations[0].id, requester);
      assert.equal(escalated.status, 'ESCALATED');
      for (const type of ['cancellation_requested', 'cancellation_declined', 'cancellation_escalated']) assertBothNotified(type);
    });
    for (const paid of [false, true]) await t.test(`${requester} ${paid ? 'paid' : 'cash'} cancellation approved by opposite participant settles only once`, async () => {
      reset(paid); emitted.length = 0; state.booking.status = 'ONGOING'; state.booking.started = true;
      if (state.queue) state.queue.status = 'SERVING';
      await requestCancellation('booking', requester, 'Cannot continue');
      const responder = requester === 'seeker' ? 'provider' : 'seeker';
      const response = await respondToCancellationRequest(state.cancellations[0].id, responder, true) as Row;
      assert.equal(response.booking.status, 'CANCELED');
      assert.equal(response.booking.paymentStatus, paid ? 'REFUNDED' : 'UNPAID');
      assert.equal(response.cancellationRequest.status, 'APPROVED');
      assert.equal(state.operations[0].stage, 'CASE_FINALIZED');
      const noticeCount = state.notifications.length;
      await respondToCancellationRequest(state.cancellations[0].id, responder, true);
      assert.equal(state.notifications.length, noticeCount);
      assert.equal(state.messages.length, 1);
      assert.equal(state.earnings.length, paid ? 1 : 0);
      assertBothNotified('cancellation_approved');
    });
  }

  await t.test('a failed cancellation notice leaves a retryable reservation and no false cancellation event', async () => {
    reset(); emitted.length = 0; failNotice = true;
    await assert.rejects(requestCancellation('booking', 'seeker', 'Cannot attend'), /Notice storage unavailable/);
    assert.equal(state.booking.status, 'UNDER_REVIEW');
    assert.equal(state.messages.length, 0);
    assert.equal(emitted.length, 0);
    failNotice = false;
    const response = await requestCancellation('booking', 'seeker', 'Cannot attend');
    assert.equal(response.booking?.status, 'CANCELED');
    assert.equal(state.cancellations.length, 1);
  });

  for (const paid of [false, true]) {
    await t.test(`${paid ? 'paid' : 'cash'} dispute persists its notice and returns the committed booking`, async () => {
      reset(paid); emitted.length = 0; state.booking.status = 'AWAITING_CONFIRMATION';
      const response = await disputeJobService('booking', 'seeker', 'INCOMPLETE_SERVICE');
      assert.equal(response.booking.status, 'DISPUTED');
      assert.equal(response.booking.paymentStatus, paid ? 'FROZEN_HELD' : 'UNPAID');
      assertBothNotified('disputed');
      await assert.rejects(disputeJobService('booking', 'seeker', 'INCOMPLETE_SERVICE'), /already exists/);
    });
  }
  await t.test('failed dispute notification rolls back the dispute instead of returning a false failure after commit', async () => {
    reset(); emitted.length = 0; state.booking.status = 'AWAITING_CONFIRMATION'; failNotice = true;
    await assert.rejects(disputeJobService('booking', 'seeker', 'INCOMPLETE_SERVICE'), /Notice storage unavailable/);
    assert.equal(state.booking.status, 'AWAITING_CONFIRMATION');
    assert.equal(state.reports.length, 0);
    assert.equal(emitted.length, 0);
  });
  await t.test('safety report, completion escalation, and actor-only removal retain their guards', async () => {
    reset(); emitted.length = 0; state.booking.status = 'ONGOING'; state.booking.started = true;
    const report = await createSafetyReport({ bookingId: 'booking', reporterId: 'provider', reason: 'INAPPROPRIATE_BEHAVIOR', description: 'Unsafe behavior during the work.' });
    assert.equal(report.created, true); assertBothNotified('safety_report');
    reset(); state.booking.status = 'AWAITING_CONFIRMATION';
    await assert.rejects(createCompletionEscalation('booking', 'provider', 'No response'), /72 hours/);
    state.booking.updatedAt = new Date(Date.now() - 73 * 60 * 60 * 1000);
    await createCompletionEscalation('booking', 'provider', 'No response');
    await createCompletionEscalation('booking', 'provider', 'No response');
    assert.equal(state.escalations.length, 1);
    emitted.length = 0;
    await assert.rejects(hideBookingService('booking', 'outsider'), /Access denied/);
    await hideBookingService('booking', 'provider');
    assert.equal(state.booking.hiddenByProvider, true);
    assert.equal(state.booking.hiddenBySeeker, undefined);
    assert.equal(emitted.filter(row => row.event === 'ENGAGEMENT_CHANGED').length, 1);
    assert.equal(emitted[0].room, 'user:provider');
  });

  await t.test('verified paid booking creation commits its notice and does not wait for queue recipients', async () => {
    reset(); emitted.length = 0; slowQueueBroadcast = true;
    state.attempts.push({ id: 'attempt', providerIntentId: 'intent', seekerId: 'seeker', providerId: 'provider', serviceId: 'service', offerId: null,
      status: 'PENDING', amount: 500, paymentMethod: 'gcash', quantity: 1, expiresAt: new Date(Date.now() + 60000) });
    const input = { paymentIntentId: 'intent', paymentId: 'payment', amount: 500, currency: 'PHP', metadata: {
      servicehub_attempt_id: 'attempt', servicehub_seeker_id: 'seeker', servicehub_service_id: 'service', servicehub_offer_id: '', servicehub_expected_amount: '500.00', servicehub_payment_method: 'gcash' } };
    let timer!: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([finalizeSuccessfulPayment(input), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Checkout waited for queue recipients')), 500); })]);
      assert.equal(result.created, true);
      assert.equal(state.attempts[0].status, 'SUCCEEDED');
      assert.equal(state.queue?.status, 'WAITING');
      assert.equal(state.notifications.length, 1);
      assertBothNotified('queue_created');
      await finalizeSuccessfulPayment(input);
      assert.equal(state.notifications.length, 1);
    } finally { clearTimeout(timer); slowQueueBroadcast = false; broadcastFinishes.splice(0).forEach(finish => finish()); }
  });
});

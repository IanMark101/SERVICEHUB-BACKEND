import { prisma } from '../lib/prisma';
import { ListingInquirySchema } from '../schema/marketplace.schema';
import { assertDistinctAccounts } from '../utils/security';
import { lockAccountLifecycle } from './account-lifecycle.service';
import { assertOfferParticipant } from './offer-eligibility';
import { resolveDirectArrangement } from '../lib/service-arrangement';
import { locationData, publicLocation } from '../lib/proximity';
import { setListingPhotos } from './listing-photos.service';
import { listingPhotosInclude, withListingPhotos } from '../lib/listing-photos';
import { safeEmit } from '../lib/socket';
import { canArchiveCompletedRequest } from '../lib/request-archive';

const fail = (message: string, status = 409, code?: string) => Object.assign(new Error(message), { status, code });

export async function createListingInquiry(seekerId: string, input: unknown) {
  const params = ListingInquirySchema.parse(input);
  const source = await prisma.service.findUnique({ where: { id: params.serviceId }, select: { providerId: true } });
  if (!source) throw fail('This listing is no longer available.', 404);
  assertDistinctAccounts(seekerId, source.providerId, 'request service');
  const result = await prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, seekerId, source.providerId);
    await assertOfferParticipant(tx, seekerId, 'seeker');
    await assertOfferParticipant(tx, source.providerId, 'provider');
    await tx.$queryRaw`SELECT id FROM services WHERE id = ${params.serviceId} FOR SHARE`;
    const service = await tx.service.findUnique({ where: { id: params.serviceId }, include: { category: true } });
    if (!service || service.providerId !== source.providerId || service.status !== 'ACTIVE' || !service.isAvailable || !service.category.isActive) throw fail('This listing is no longer available.', 404);
    const methods = service.paymentMethods as { cash?: boolean; gcash?: boolean } | null;
    if (!methods?.cash && !methods?.gcash) throw fail('This listing has no available payment method.');
    const arrangement = resolveDirectArrangement(service, params.serviceLocationMode, params.jobLocation);
    if (service.priceType !== 'BY_AGREEMENT' && arrangement.serviceLocationMode !== 'PROVIDER_VISITS') throw fail('Use the normal booking request for this listing and arrangement.', 400);
    const activeBooking = await tx.booking.findFirst({ where: { seekerId, serviceId: service.id, status: { in: ['PENDING_APPROVAL', 'WAITING', 'ACCEPTED', 'ONGOING', 'AWAITING_CONFIRMATION', 'UNDER_REVIEW', 'DISPUTED'] } }, select: { id: true } });
    if (activeBooking) throw fail('You already have an active booking for this service. Check Activity.', 409, 'ACTIVE_BOOKING_EXISTS');
    const existing = await tx.serviceRequest.findMany({ where: { seekerId, targetServiceId: service.id, status: { in: ['OPEN', 'PAYMENT_PENDING', 'IN_PROGRESS'] } }, select: { offers: { select: { status: true, booking: { select: { status: true } } } } } });
    if (existing.some(request => !canArchiveCompletedRequest(request.offers))) throw fail('You already sent a request for this listing. Review it in Request Manager or Offers Received.', 409, 'DUPLICATE_SERVICE_INQUIRY');
    const point = arrangement.serviceLocationMode === 'PROVIDER_VISITS' ? arrangement.jobLocation! : null;
    const inquiry = await tx.serviceRequest.create({ data: {
      seekerId, targetProviderId: service.providerId, targetServiceId: service.id,
      preferredPaymentMethod: null, paymentMethods: { cash: methods.cash === true, gcash: methods.gcash === true },
      categoryId: service.categoryId, title: service.title, description: params.message,
      // Private inquiries have no quoted price or public budget. Zero is the
      // existing internal unset-budget representation, never a booking amount.
      budgetMin: 0, budgetMax: 0, urgency: 'Flexible Schedule', status: 'OPEN',
      serviceLocationMode: arrangement.serviceLocationMode,
      ...(point && { ...locationData(point), privateAddress: point.address || null }),
    } });
    await setListingPhotos(tx, seekerId, params.photoIds ?? [], { requestId: inquiry.id });
    await tx.notification.create({ data: { userId: service.providerId, title: 'New service request', body: `A seeker requested ${service.title}. Review the work and location, then send your final price or decline.`, link: `/provider/incoming-requests?request=${inquiry.id}` } });
    return withListingPhotos(await tx.serviceRequest.findUniqueOrThrow({ where: { id: inquiry.id }, include: { ...listingPhotosInclude, category: true, seeker: { select: { id: true, name: true, avatarUrl: true } } } }));
  });
  for (const userId of [seekerId, source.providerId]) safeEmit(`user:${userId}`, 'SERVICE_REQUESTS_CHANGED', { id: result.id });
  safeEmit(`user:${source.providerId}`, 'notification', { title: 'New service request' });
  return publicLocation(result);
}

export async function declineListingInquiry(providerId: string, requestId: string) {
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${requestId}`}))`;
    const request = await tx.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request?.targetServiceId || request.targetProviderId !== providerId) throw fail('This service request is not available to you.', 404);
    await lockAccountLifecycle(tx, providerId, request.seekerId);
    await assertOfferParticipant(tx, providerId, 'provider');
    if (request.status === 'CANCELED') return { request, changed: false };
    if (request.status !== 'OPEN') throw fail('This request can no longer be declined.');
    if (await tx.offer.count({ where: { requestId, status: { in: ['PENDING', 'PENDING_PAYMENT', 'ACCEPTED'] } } })) throw fail('You already sent a price for this request. Manage that offer in Activity.');
    const updated = await tx.serviceRequest.update({ where: { id: requestId }, data: { status: 'CANCELED' } });
    await tx.notification.create({ data: { id: `inquiry-declined:${requestId}`, userId: request.seekerId, title: 'Service request declined', body: `The provider cannot take your request for ${request.title}. No booking or payment was created.`, link: `/seeker/seek-services?serviceId=${request.targetServiceId}` } });
    return { request: updated, changed: true };
  });
  if (result.changed) for (const userId of [providerId, result.request.seekerId]) safeEmit(`user:${userId}`, 'SERVICE_REQUESTS_CHANGED', { id: requestId, status: result.request.status });
  if (result.changed) safeEmit(`user:${result.request.seekerId}`, 'notification', { title: 'Service request declined' });
  return { id: requestId, status: result.request.status };
}

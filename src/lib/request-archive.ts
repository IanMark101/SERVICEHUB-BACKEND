import type { BookingStatus, OfferStatus } from '@prisma/client';

export function canArchiveCompletedRequest(offers: { status: OfferStatus; booking?: { status: BookingStatus } | null }[]) {
  return offers.some(offer => offer.booking?.status === 'COMPLETED')
    && !offers.some(offer => offer.status === 'PENDING_PAYMENT'
      || (offer.booking && !['COMPLETED', 'DECLINED', 'CANCELED', 'REMOVED'].includes(offer.booking.status)));
}

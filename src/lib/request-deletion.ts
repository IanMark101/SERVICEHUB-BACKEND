import type { BookingStatus, OfferStatus, PaymentAttemptStatus, RequestStatus } from '@prisma/client';

export const protectedRequestPaymentStatuses: PaymentAttemptStatus[] = ['PENDING', 'SUCCEEDED', 'REFUND_REQUIRED'];

/** Used by both the owner-list response and the locked delete transaction. */
export function requestDeletionEligibility(request: {
  status: RequestStatus;
  offers: { status: OfferStatus; booking?: { status: BookingStatus } | null }[];
}, payments: { status: PaymentAttemptStatus }[] = []) {
  let reason: string | null = null;
  if (request.offers.some(offer => offer.booking?.status === 'COMPLETED')) {
    reason = 'This request can’t be deleted because it has a completed booking. Its booking history must be kept.';
  } else if (request.status === 'IN_PROGRESS' || request.offers.some(offer => offer.booking && !['DECLINED', 'CANCELED', 'REMOVED'].includes(offer.booking.status))) {
    reason = 'This request can’t be deleted while it has an active booking. Manage the booking in Activity.';
  } else if (request.offers.some(offer => offer.status === 'ACCEPTED')) {
    reason = 'This request can’t be deleted because an offer has already been accepted. Review the booking in Activity.';
  } else if (request.status === 'PAYMENT_PENDING' || request.offers.some(offer => offer.status === 'PENDING_PAYMENT') || payments.some(payment => protectedRequestPaymentStatuses.includes(payment.status))) {
    reason = 'This request can’t be deleted while a payment or refund is being processed. Check its payment status in Activity.';
  } else if (request.status !== 'OPEN') {
    reason = request.status === 'CLOSED'
      ? 'Reopen this paused request before deleting it. Requests with booking history must be kept.'
      : 'This request can’t be deleted in its current state.';
  }
  return { canDelete: reason === null, deleteBlockedReason: reason };
}

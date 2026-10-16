export const COMPLETION_REVIEW_WAIT_MS = 72 * 60 * 60 * 1000;

type CompletionReviewBooking = {
  status: string;
  paymentMethod: string;
  updatedAt: Date;
  progressEvents?: Array<{ kind: string; occurredAt: Date }>;
};
type PreviousReview = { status: string; resolution: string | null; resolvedAt: Date | null };

/** Used by both the read model and the mutation guard. No unrelated edit restarts the wait. */
export function completionReviewAvailability(booking: CompletionReviewBooking, previous?: PreviousReview | null) {
  if (booking.status !== 'AWAITING_CONFIRMATION' || booking.paymentMethod !== 'GCash') return null;
  const markedAt = booking.progressEvents
    ?.filter(event => event.kind === 'WORK_MARKED_COMPLETE')
    .reduce((latest, event) => Math.max(latest, event.occurredAt.getTime()), 0);
  // Older bookings predate progress events; retain their existing conservative fallback.
  const initialDeadline = (markedAt || booking.updatedAt.getTime()) + COMPLETION_REVIEW_WAIT_MS;
  const retryDeadline = previous?.resolution === 'KEEP_AWAITING' && previous.resolvedAt
    ? previous.resolvedAt.getTime() + COMPLETION_REVIEW_WAIT_MS : 0;
  return {
    availableAt: new Date(Math.max(initialDeadline, retryDeadline)).toISOString(),
    pending: !!previous && ['PENDING', 'UNDER_REVIEW'].includes(previous.status),
  };
}

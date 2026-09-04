/**
 * Public booking-service facade.
 *
 * Controllers keep importing from this stable path while implementation lives
 * in feature-focused modules under ./bookings.
 */
export {
  getNextQueuePosition,
  calculateEstimatedWait,
} from "./bookings/queue-metrics";

export {
  createDirectRequest,
  respondToDirectBookingService,
  createDirectFromOfferService,
} from "./bookings/direct-bookings.service";

export {
  providerStartJob,
} from "./bookings/provider-operations.service";

export {
  markJobComplete,
  confirmCompletionService,
  disputeJobService,
} from "./bookings/completion.service";

export {
  joinWaitlist,
} from "./bookings/waitlist.service";

export { hideBookingService } from "./bookings/booking-visibility.service";

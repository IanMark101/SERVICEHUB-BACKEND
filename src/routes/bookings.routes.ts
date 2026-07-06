import { Router } from "express";
import {
  bookDirect,
  initiatePayment,
  confirmOnlineBooking,
  joinWaitlistHandler,
  cancelQueue,
  completeJob,
  confirmCompletion,
  getMyEngagements,
  respondDirectRequest,
  bookDirectFromOffer,
  startJob,
  providerRemoveFromQueue,
  disputeJob,
  cancelBookingHandler,
  respondCancellationRequestHandler,
  escalateCancellationRequestHandler,
} from "../controllers/bookings.controller";
import { requireAuth, requireVerification, requireMarketplaceUser } from "../middlewares/auth.middleware";

const router = Router();

// All booking routes require authentication and standard user role
router.use(requireAuth, requireMarketplaceUser);

// Get my engagements (active and completed)
router.get("/my-engagements", getMyEngagements);

// Cash Direct Arrangement (NEVER enters queue) — requires residency verification (Part 6)
router.post("/direct", requireVerification, bookDirect);
router.patch("/direct/:id/respond", requireVerification, respondDirectRequest);

// Cash from Offer (Flow B Cash path) — requires residency verification (Part 6)
router.post("/direct-from-offer", requireVerification, bookDirectFromOffer);

// Online payment flow (two-step) — initiate-payment requires verification (Part 6)
router.post("/initiate-payment", requireVerification, initiatePayment);
router.post("/confirm-online", requireVerification, confirmOnlineBooking); // only call after PayMongo succeeds

// Queue management
router.post("/waitlist", joinWaitlistHandler);
router.delete("/queue/:id", cancelQueue); // seeker cancels queue entry
router.patch("/queue/:id/start", startJob); // provider starts job
router.delete("/queue/:id/provider", providerRemoveFromQueue); // provider removes entry
router.patch("/queue/:id/complete", completeJob); // provider marks job complete

// Seeker actions
router.post("/:id/dispute", disputeJob); // dispute a booking
router.post("/:id/confirm", confirmCompletion); // confirm completion of booking
router.post("/:id/cancel", cancelBookingHandler); // cancel booking (or request cancellation)
router.post("/cancellation-requests/:id/escalate", escalateCancellationRequestHandler); // escalate declined cancellation request

// Provider cancellation action
router.patch("/cancellation-requests/:id/respond", respondCancellationRequestHandler); // respond to cancellation request

// Seeker confirms completion (compatible route)
router.patch("/completed/:id/confirm", confirmCompletion);

export default router;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bookings_controller_1 = require("../controllers/bookings.controller");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = (0, express_1.Router)();
// All booking routes require authentication
router.use(auth_middleware_1.requireAuth);
// Get my engagements (active and completed)
router.get("/my-engagements", bookings_controller_1.getMyEngagements);
// Cash Direct Arrangement (NEVER enters queue)
router.post("/direct", bookings_controller_1.bookDirect);
router.patch("/direct/:id/respond", bookings_controller_1.respondDirectRequest);
// Cash from Offer (Flow B Cash path)
router.post("/direct-from-offer", bookings_controller_1.bookDirectFromOffer);
// Online payment flow (two-step)
router.post("/initiate-payment", bookings_controller_1.initiatePayment);
router.post("/confirm-online", bookings_controller_1.confirmOnlineBooking); // only call after PayMongo succeeds
// Queue management
router.post("/waitlist", bookings_controller_1.joinWaitlistHandler);
router.delete("/queue/:id", bookings_controller_1.cancelQueue); // seeker cancels queue entry
router.patch("/queue/:id/start", bookings_controller_1.startJob); // provider starts job
router.delete("/queue/:id/provider", bookings_controller_1.providerRemoveFromQueue); // provider removes entry
router.patch("/queue/:id/complete", bookings_controller_1.completeJob); // provider marks job complete
// Seeker actions
router.post("/:id/dispute", bookings_controller_1.disputeJob); // dispute a booking
router.post("/:id/confirm", bookings_controller_1.confirmCompletion); // confirm completion of booking
router.post("/:id/cancel", bookings_controller_1.cancelBookingHandler); // cancel booking (or request cancellation)
router.post("/cancellation-requests/:id/escalate", bookings_controller_1.escalateCancellationRequestHandler); // escalate declined cancellation request
// Provider cancellation action
router.patch("/cancellation-requests/:id/respond", bookings_controller_1.respondCancellationRequestHandler); // respond to cancellation request
// Seeker confirms completion (compatible route)
router.patch("/completed/:id/confirm", bookings_controller_1.confirmCompletion);
exports.default = router;
//# sourceMappingURL=bookings.routes.js.map
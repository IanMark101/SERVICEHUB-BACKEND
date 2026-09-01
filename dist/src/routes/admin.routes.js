import { Router } from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware";
import { getOverview, listUsers, updateTrustScore, suspendUser, banUser, restoreUser, restorePostingPrivilege, promoteUserToAdmin, listPendingServices, reviewService, listCategorySuggestions, resolveCategorySuggestion, listReports, resolveReport, resolveCancellationRequest, listEscalatedCancellations, listAnnouncements, createAnnouncement, updateAnnouncement, } from "../controllers/admin.controller";
import { adminList as listPendingVerifications, adminReview as reviewVerification, } from "../controllers/verification.controller";
import { adminViewMessages } from "../controllers/messages.controller";
import { adminMutationLimiter } from "../middlewares/rateLimiter.middleware";
const router = Router();
// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);
router.use((req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        return adminMutationLimiter(req, res, next);
    }
    next();
});
// Overview stats
router.get("/overview", getOverview);
// Community Hub: official administration announcements
router.get("/announcements", listAnnouncements);
router.post("/announcements", createAnnouncement);
router.patch("/announcements/:id", updateAnnouncement);
// Users & Trust
router.get("/users", listUsers);
router.patch("/users/:id/trust", updateTrustScore);
router.patch("/users/:id/suspend", suspendUser);
router.patch("/users/:id/ban", banUser);
router.patch("/users/:id/restore", restoreUser);
router.patch("/users/:id/posting-restore", restorePostingPrivilege);
router.patch("/users/:id/promote", promoteUserToAdmin);
// Verification Queue
router.get("/verifications", listPendingVerifications);
router.patch("/verifications/:id", reviewVerification);
// Service Listing Review
router.get("/services/pending", listPendingServices);
router.patch("/services/:id/review", reviewService);
// Category Suggestions
router.get("/categories/suggestions", listCategorySuggestions);
router.patch("/categories/suggestions/:id", resolveCategorySuggestion);
// Reports / Moderation
router.get("/reports", listReports);
router.patch("/reports/:id/resolve", resolveReport);
// Resolve escalated cancellation requests
router.patch("/cancellation-requests/:id/resolve", resolveCancellationRequest);
// List escalated cancellations (for admin Escalations tab)
router.get("/cancellations/escalated", listEscalatedCancellations);
// Booking Messages Investigation (for dispute/report review)
router.get("/bookings/:bookingId/messages", adminViewMessages);
export default router;
//# sourceMappingURL=admin.routes.js.map
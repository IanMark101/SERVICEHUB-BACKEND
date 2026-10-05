import { Router } from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware";
import {
  getOverview,
  listUsers,
  updateTrustScore,
  suspendUser,
  banUser,
  restoreUser,
  restorePostingPrivilege,
  listServices,
  removeServiceContent,
  restoreServiceContent,
  listCategories,
  createCategory,
  updateCategory,
  listCategorySuggestions,
  resolveCategorySuggestion,
  listReports,
  resolveReport,
  accessReportEvidence,
  resolveCancellationRequest,
  listEscalatedCancellations,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
} from "../controllers/admin.controller";
import {
  adminList as listPendingVerifications,
  adminReview as reviewVerification,
  adminAccessProof,
} from "../controllers/verification.controller";
import { adminViewMessages } from "../controllers/messages.controller";
import { adminMutationLimiter } from "../middlewares/rateLimiter.middleware";
import { listAdminCompletionEscalations, resolveAdminCompletionEscalation } from "../controllers/admin/completion-escalations.controller";
import { listPaymentReconciliation, retryPaymentReconciliation } from "../controllers/admin/payments.controller";
import { adminCancelUnstartedBooking, listAdminBookings, listAdminPaymentAttempts, resolveBannedParticipantBooking } from "../controllers/admin/booking-operations.controller";
import { listAdminReviews, moderateReview } from "../controllers/admin/reviews.controller";
import { listAdminAuditLogs } from "../controllers/admin/audit-log.controller";
import { listPublicRequestContent, removeRequestContent } from "../controllers/admin/request-moderation.controller";
import { listCases as listContentCases, resolveCase as resolveContentCase, getContentCase, listMarketplaceContent, getMarketplaceContent, actOnMarketplaceContent } from "../controllers/admin/content-cases.controller";
import { listBanAppeals, decideBanAppeal, getBanAppealSummary } from "../controllers/admin/ban-appeals.controller";
import { getAdminUserProfile, getAdminUserRecords } from "../controllers/admin/user-profile.controller";
import { listCases as listModerationCases, getCase, reviewCase } from "../controllers/admin/case-workspace.controller";

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
router.get("/audit-logs", listAdminAuditLogs);

// Community Hub: official administration announcements
router.get("/announcements", listAnnouncements);
router.post("/announcements", createAnnouncement);
router.patch("/announcements/:id", updateAnnouncement);

// Users & Trust
router.get("/users", listUsers);
router.get("/users/:id", getAdminUserProfile);
router.get("/users/:id/records", getAdminUserRecords);
router.get("/ban-appeals", listBanAppeals);
router.get("/ban-appeals/summary", getBanAppealSummary);
router.patch("/ban-appeals/:id", decideBanAppeal);
router.patch("/users/:id/trust", updateTrustScore);
router.patch("/users/:id/suspend", suspendUser);
router.patch("/users/:id/ban", banUser);
router.patch("/users/:id/restore", restoreUser);
router.patch("/users/:id/posting-restore", restorePostingPrivilege);

// Verification Queue
router.get("/verifications", listPendingVerifications);
router.get("/verifications/:id/proofs/:proofId/access", adminAccessProof);
router.patch("/verifications/:id", reviewVerification);

// Published listing moderation
router.get("/services", listServices);
router.post("/services/:id/remove-content", removeServiceContent);
router.post("/services/:id/restore-content", restoreServiceContent);
router.get("/content/requests", listPublicRequestContent);
router.post("/content/requests/:id/remove", removeRequestContent);
router.get("/content/cases", listContentCases);
router.get("/content/cases/:id", getContentCase);
router.patch("/content/cases/:id", resolveContentCase);
router.get("/content/marketplace", listMarketplaceContent);
router.get("/content/marketplace/:type/:id", getMarketplaceContent);
router.post("/content/marketplace/:type/:id/action", actOnMarketplaceContent);

// Category Suggestions
router.get("/categories", listCategories);
router.post("/categories", createCategory);
router.patch("/categories/:id", updateCategory);
router.get("/categories/suggestions", listCategorySuggestions);
router.patch("/categories/suggestions/:id", resolveCategorySuggestion);

// Reports / Moderation
router.get("/reports", listReports);
router.get("/moderation-cases", listModerationCases);
router.get("/moderation-cases/:source/:id", getCase);
router.patch("/moderation-cases/:source/:id/review", reviewCase);
router.get("/reports/:id/evidence/access", accessReportEvidence);
router.patch("/reports/:id/resolve", resolveReport);
router.get("/reviews", listAdminReviews);
router.patch("/reviews/:id/moderation", moderateReview);
router.get("/completion-escalations", listAdminCompletionEscalations);
router.patch("/completion-escalations/:id/resolve", resolveAdminCompletionEscalation);
router.get("/payments/reconciliation", listPaymentReconciliation);
router.post("/payments/reconciliation/:id/retry", retryPaymentReconciliation);
router.get("/bookings", listAdminBookings);
router.post("/bookings/:bookingId/cancel", adminCancelUnstartedBooking);
router.post("/bookings/:bookingId/resolve-banned", resolveBannedParticipantBooking);
router.get("/payment-attempts", listAdminPaymentAttempts);

// Resolve escalated cancellation requests
router.patch("/cancellation-requests/:id/resolve", resolveCancellationRequest);

// List escalated cancellations (for admin Escalations tab)
router.get("/cancellations/escalated", listEscalatedCancellations);

// Booking Messages Investigation (for dispute/report review)
router.get("/bookings/:bookingId/messages", adminViewMessages);

export default router;


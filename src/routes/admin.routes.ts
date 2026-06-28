import { Router } from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware";
import {
  getOverview,
  listUsers,
  updateTrustScore,
  suspendUser,
  banUser,
  restoreUser,
  listPendingServices,
  reviewService,
  listCategorySuggestions,
  resolveCategorySuggestion,
  listReports,
  resolveReport,
  resolveCancellationRequest,
} from "../controllers/admin.controller";
import {
  adminList as listPendingVerifications,
  adminReview as reviewVerification,
} from "../controllers/verification.controller";

const router = Router();

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// Overview stats
router.get("/overview", getOverview);

// Users & Trust
router.get("/users", listUsers);
router.patch("/users/:id/trust", updateTrustScore);
router.patch("/users/:id/suspend", suspendUser);
router.patch("/users/:id/ban", banUser);
router.patch("/users/:id/restore", restoreUser);

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

export default router;

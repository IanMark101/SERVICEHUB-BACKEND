"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const admin_controller_1 = require("../controllers/admin.controller");
const verification_controller_1 = require("../controllers/verification.controller");
const router = (0, express_1.Router)();
// All admin routes require auth + admin role
router.use(auth_middleware_1.requireAuth, auth_middleware_1.requireAdmin);
// Overview stats
router.get("/overview", admin_controller_1.getOverview);
// Users & Trust
router.get("/users", admin_controller_1.listUsers);
router.patch("/users/:id/trust", admin_controller_1.updateTrustScore);
router.patch("/users/:id/suspend", admin_controller_1.suspendUser);
router.patch("/users/:id/ban", admin_controller_1.banUser);
router.patch("/users/:id/restore", admin_controller_1.restoreUser);
// Verification Queue
router.get("/verifications", verification_controller_1.adminList);
router.patch("/verifications/:id", verification_controller_1.adminReview);
// Service Listing Review
router.get("/services/pending", admin_controller_1.listPendingServices);
router.patch("/services/:id/review", admin_controller_1.reviewService);
// Category Suggestions
router.get("/categories/suggestions", admin_controller_1.listCategorySuggestions);
router.patch("/categories/suggestions/:id", admin_controller_1.resolveCategorySuggestion);
// Reports / Moderation
router.get("/reports", admin_controller_1.listReports);
router.patch("/reports/:id/resolve", admin_controller_1.resolveReport);
// Resolve escalated cancellation requests
router.patch("/cancellation-requests/:id/resolve", admin_controller_1.resolveCancellationRequest);
exports.default = router;
//# sourceMappingURL=admin.routes.js.map
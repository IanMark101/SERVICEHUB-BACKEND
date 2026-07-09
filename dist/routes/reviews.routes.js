"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const reviews_controller_1 = require("../controllers/reviews.controller");
const router = (0, express_1.Router)();
router.post("/", auth_middleware_1.requireAuth, auth_middleware_1.requireMarketplaceUser, reviews_controller_1.submitReview);
router.get("/provider/:providerId", reviews_controller_1.getProviderReviews);
exports.default = router;
//# sourceMappingURL=reviews.routes.js.map
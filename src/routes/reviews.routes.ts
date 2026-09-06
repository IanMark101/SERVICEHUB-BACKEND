import { Router } from "express";
import { requireAuth, requireMarketplaceUser, requireVerification } from "../middlewares/auth.middleware";
import { submitReview, getProviderReviews, updateReview } from "../controllers/reviews.controller";
import { reviewMutationLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

router.post("/", requireAuth, requireMarketplaceUser, requireVerification, reviewMutationLimiter, submitReview);
router.patch("/:id", requireAuth, requireMarketplaceUser, requireVerification, reviewMutationLimiter, updateReview);
router.get("/provider/:providerId", getProviderReviews);

export default router;

import { Router } from "express";
import { requireAuth, requireMarketplaceUser, requireVerification } from "../middlewares/auth.middleware";
import { submitReview, getProviderReviews, updateReview } from "../controllers/reviews.controller";
import { reviewMutationLimiter } from "../middlewares/rateLimiter.middleware";
import { submitTrustCase, listTrustCases, respondToTrustCase, respondToReview } from '../controllers/trust-cases.controller';

const router = Router();
router.get('/trust-cases', requireAuth, listTrustCases);
router.post('/trust-cases', requireAuth, requireMarketplaceUser, reviewMutationLimiter, submitTrustCase);
router.patch('/trust-cases/:id/response', requireAuth, reviewMutationLimiter, respondToTrustCase);
router.patch('/:id/response', requireAuth, requireMarketplaceUser, reviewMutationLimiter, respondToReview);

router.post("/", requireAuth, requireMarketplaceUser, requireVerification, reviewMutationLimiter, submitReview);
router.patch("/:id", requireAuth, requireMarketplaceUser, requireVerification, reviewMutationLimiter, updateReview);
router.get("/provider/:providerId", getProviderReviews);

export default router;

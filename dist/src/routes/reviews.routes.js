import { Router } from "express";
import { requireAuth, requireMarketplaceUser, requireVerification } from "../middlewares/auth.middleware";
import { submitReview, getProviderReviews, updateReview } from "../controllers/reviews.controller";
const router = Router();
router.post("/", requireAuth, requireMarketplaceUser, requireVerification, submitReview);
router.patch("/:id", requireAuth, requireMarketplaceUser, requireVerification, updateReview);
router.get("/provider/:providerId", getProviderReviews);
export default router;
//# sourceMappingURL=reviews.routes.js.map
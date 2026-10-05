import { Router } from "express";
import { searchUsers, updateOnboardingStatus } from "../controllers/users.controller";
import { requireAuth, requireEmailVerified, requireMarketplaceUser } from "../middlewares/auth.middleware";
import {
  deleteAccount,
  readDeletionEligibility,
  startDeletionGoogleVerification,
} from "../controllers/account-deletion.controller";
import { accountDeletionLimiter, deletionChallengeLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

// User discovery is available to signed-in residents only.
router.get("/", requireAuth, requireEmailVerified, searchUsers);
router.patch("/me/onboarding", requireAuth, requireMarketplaceUser, requireEmailVerified, updateOnboardingStatus);
router.get("/me/account-deletion", requireAuth, requireMarketplaceUser, readDeletionEligibility);
router.post("/me/account-deletion", requireAuth, requireMarketplaceUser, accountDeletionLimiter, deleteAccount);
router.post("/me/account-deletion/google-challenge", requireAuth, requireMarketplaceUser, deletionChallengeLimiter, startDeletionGoogleVerification);

export default router;

import { Router } from "express";
import { submit, getStatus, privacyNotice } from "../controllers/verification.controller";
import { requireAuth, requireEmailVerified, requireMarketplaceUser } from "../middlewares/auth.middleware";

const router = Router();

// All verification routes require authentication and standard user role
router.use(requireAuth, requireMarketplaceUser);

router.get("/privacy-notice", privacyNotice);
router.post("/submit", requireEmailVerified, submit);
router.get("/status", getStatus);

export default router;

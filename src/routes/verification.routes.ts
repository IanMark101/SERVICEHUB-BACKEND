import { Router } from "express";
import { submit, getStatus } from "../controllers/verification.controller";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";

const router = Router();

// All verification routes require authentication and standard user role
router.use(requireAuth, requireMarketplaceUser);

router.post("/submit", submit);
router.get("/status", getStatus);

export default router;

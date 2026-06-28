import { Router } from "express";
import { submit, getStatus } from "../controllers/verification.controller";
import { requireAuth } from "../middlewares/auth.middleware";

const router = Router();

// All verification routes require authentication
router.use(requireAuth);

router.post("/submit", submit);
router.get("/status", getStatus);

export default router;

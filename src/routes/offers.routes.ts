import { Router } from "express";
import { requireAuth, requireVerification, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { create, getReceived, getMine, accept, reject } from "../controllers/offers.controller";

const router = Router();

router.use(requireAuth, requireMarketplaceUser);

// POST requires residency verification (Part 6 — submitting an offer is a gated action)
router.post("/", requireVerification, create);
router.get("/received", getReceived);   // seeker: offers on their requests
router.get("/mine", getMine);           // provider: their own submitted bids
router.patch("/:id/accept", requireVerification, accept);
router.patch("/:id/reject", reject);

export default router;

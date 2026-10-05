import { Router } from "express";
import { requireAuth, requireEmailVerified, requireVerification, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { create, list, getMine, update, remove } from "../controllers/requests.controller";
import { marketplaceContentLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

router.use(requireAuth, requireMarketplaceUser, requireEmailVerified);

// POST requires residency verification (Part 6 — posting a request is a gated action)
router.post("/", requireVerification, marketplaceContentLimiter, create);
router.get("/", list);
router.get("/mine", getMine);
router.patch("/:id", requireVerification, marketplaceContentLimiter, update);
router.delete("/:id", remove);

export default router;

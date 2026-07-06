import { Router } from "express";
import { browse, getOne, getMine, create, update, toggle, remove } from "../controllers/services.controller";
import { requireAuth, requireVerification, requireMarketplaceUser } from "../middlewares/auth.middleware";

const router = Router();

// Public
router.get("/", browse);

// Protected — provider's own listings (MUST be before /:id to avoid route conflict)
router.get("/mine", requireAuth, requireMarketplaceUser, getMine);

// Public single service
router.get("/:id", getOne);

// Protected mutations — POST /services requires residency verification (Part 6)
router.post("/", requireAuth, requireMarketplaceUser, requireVerification, create);
router.patch("/:id", requireAuth, requireMarketplaceUser, update);
router.patch("/:id/toggle", requireAuth, requireMarketplaceUser, toggle);
router.delete("/:id", requireAuth, requireMarketplaceUser, remove);

export default router;

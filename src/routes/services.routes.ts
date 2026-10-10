import { NearbyQuerySchema } from '../schema/location.schema';
import { nearbyServices } from '../services/nearby.service';
import { Router } from "express";
import { browse, getOne, getMine, create, update, toggle, remove } from "../controllers/services.controller";
import { requireAuth, requireEmailVerified, requireVerification, requireMarketplaceUser, requirePostingPrivilege, optionalAuth } from "../middlewares/auth.middleware";
import { marketplaceContentLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

// Public (with optional user context)
router.get("/", optionalAuth, browse);

router.get('/nearby', optionalAuth, async (req, res, next) => {
  try { res.json({ success: true, data: await nearbyServices(NearbyQuerySchema.parse(req.query)) }); }
  catch (error) { next(error); }
});

// Protected — provider's own listings (MUST be before /:id to avoid route conflict)
router.get("/mine", requireAuth, requireMarketplaceUser, requireEmailVerified, getMine);

// Public single service
router.get("/:id", getOne);

// Protected mutations — POST /services requires residency verification (Part 6)
router.post("/", requireAuth, requireMarketplaceUser, requireVerification, requirePostingPrivilege, marketplaceContentLimiter, create);
router.patch("/:id", requireAuth, requireMarketplaceUser, requireVerification, requirePostingPrivilege, marketplaceContentLimiter, update);
router.patch("/:id/toggle", requireAuth, requireMarketplaceUser, requireVerification, toggle);
router.delete("/:id", requireAuth, requireMarketplaceUser, requireEmailVerified, remove);

export default router;

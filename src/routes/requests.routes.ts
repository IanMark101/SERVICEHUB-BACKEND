import { NearbyQuerySchema } from '../schema/location.schema';
import { nearbyRequests } from '../services/nearby.service';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { Router } from "express";
import { requireAuth, requireEmailVerified, requireVerification, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { create, list, getMine, update, remove, archive, repostTemplate } from "../controllers/requests.controller";
import { marketplaceContentLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

router.use(requireAuth, requireMarketplaceUser, requireEmailVerified);

// POST requires residency verification (Part 6 — posting a request is a gated action)
router.post("/", requireVerification, marketplaceContentLimiter, create);
router.get("/", list);
router.get("/mine", getMine);
router.get('/nearby', async (req, res, next) => {
  try { res.json({ success: true, data: await nearbyRequests(NearbyQuerySchema.parse(req.query), (req as AuthenticatedRequest).user.id) }); }
  catch (error) { next(error); }
});
router.get('/:id/repost-template', repostTemplate);
router.post('/:id/archive', archive);
router.patch("/:id", requireVerification, marketplaceContentLimiter, update);
router.delete("/:id", remove);

export default router;

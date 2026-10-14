import { NearbyQuerySchema } from '../schema/location.schema';
import { nearbyRequests } from '../services/nearby.service';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { Router } from "express";
import { requireAuth, requireEmailVerified, requireVerification, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { create, list, getMine, update, remove, archive, repostTemplate } from "../controllers/requests.controller";
import { marketplaceContentLimiter } from "../middlewares/rateLimiter.middleware";
import { listRequests } from '../services/requests.service';
import { publicLocation } from '../lib/proximity';
import { createInquiry, declineInquiry } from '../controllers/listing-inquiries.controller';

const router = Router();

router.use(requireAuth, requireMarketplaceUser, requireEmailVerified);

// POST requires residency verification (Part 6 — posting a request is a gated action)
router.post("/", requireVerification, marketplaceContentLimiter, create);
router.post('/listing-inquiry', requireVerification, marketplaceContentLimiter, createInquiry);
router.post('/:id/decline-inquiry', requireVerification, marketplaceContentLimiter, declineInquiry);
router.get("/", list);
router.get("/mine", getMine);
router.get('/nearby', async (req, res, next) => {
  try { res.json({ success: true, data: await nearbyRequests(NearbyQuerySchema.parse(req.query), (req as AuthenticatedRequest).user.id) }); }
  catch (error) { next(error); }
});
router.get('/:id/repost-template', repostTemplate);
router.get('/:id', async (req, res, next) => {
  try {
    const items = await listRequests(undefined, (req as unknown as AuthenticatedRequest).user.id, undefined, [req.params.id as string]);
    if (!items.length) return res.status(404).json({ success: false, error: 'This request is no longer available.' });
    res.json({ success: true, data: publicLocation(items[0]) });
  } catch (error) { next(error); }
});
router.post('/:id/archive', archive);
router.patch("/:id", requireVerification, marketplaceContentLimiter, update);
router.delete("/:id", remove);

export default router;

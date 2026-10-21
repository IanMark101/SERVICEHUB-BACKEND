import { Router } from "express";
import { getCommunityStats } from "../controllers/community.controller";
import { getFeaturedServices } from '../services/featured-services.service';

const router = Router();

// Public — no auth required (Community Hub is viewable by anyone who is logged in,
// even unverified users per Part 4 access gating)
router.get("/stats", getCommunityStats);
router.get('/featured-services', async (_req, res, next) => {
  try { res.json({ success: true, data: await getFeaturedServices() }); } catch (error) { next(error); }
});

export default router;

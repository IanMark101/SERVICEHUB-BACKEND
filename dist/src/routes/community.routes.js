import { Router } from "express";
import { getCommunityStats } from "../controllers/community.controller";
const router = Router();
// Public — no auth required (Community Hub is viewable by anyone who is logged in,
// even unverified users per Part 4 access gating)
router.get("/stats", getCommunityStats);
export default router;
//# sourceMappingURL=community.routes.js.map
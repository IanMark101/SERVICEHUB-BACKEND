import { Router } from "express";
import { requireAuth, requireMarketplaceUser, requireVerification } from "../middlewares/auth.middleware";
import {
  getCategories,
  suggestCategory,
  getMySuggestions,
} from "../controllers/categories.controller";

const router = Router();

// GET /categories — public list of all active categories
router.get("/", getCategories);

// POST /categories/suggest — suggesting marketplace scope is a verified-user action
router.post("/suggest", requireAuth, requireMarketplaceUser, requireVerification, suggestCategory);

// GET /categories/suggestions/mine — user's suggestions list (requires auth)
router.get("/suggestions/mine", requireAuth, requireMarketplaceUser, getMySuggestions);

export default router;

import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  getCategories,
  suggestCategory,
  getMySuggestions,
} from "../controllers/categories.controller";

const router = Router();

// GET /categories — public list of all active categories
router.get("/", getCategories);

// POST /categories/suggest — suggest category (requires auth)
router.post("/suggest", requireAuth, suggestCategory);

// GET /categories/suggestions/mine — user's suggestions list (requires auth)
router.get("/suggestions/mine", requireAuth, getMySuggestions);

export default router;

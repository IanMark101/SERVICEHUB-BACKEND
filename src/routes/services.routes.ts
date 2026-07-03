import { Router } from "express";
import { browse, getOne, getMine, create, update, toggle, remove } from "../controllers/services.controller";
import { requireAuth, requireVerification } from "../middlewares/auth.middleware";

const router = Router();

// Public
router.get("/", browse);

// Protected — provider's own listings (MUST be before /:id to avoid route conflict)
router.get("/mine", requireAuth, getMine);

// Public single service
router.get("/:id", getOne);

// Protected mutations — POST /services requires residency verification (Part 6)
router.post("/", requireAuth, requireVerification, create);
router.patch("/:id", requireAuth, update);
router.patch("/:id/toggle", requireAuth, toggle);
router.delete("/:id", requireAuth, remove);

export default router;

import { Router } from "express";
import { getCategories } from "../controllers/categories.controller";

const router = Router();
// Public discovery uses the active, admin-managed category catalog.
router.get("/", getCategories);
export default router;

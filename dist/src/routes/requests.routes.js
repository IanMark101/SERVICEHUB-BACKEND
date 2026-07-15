import { Router } from "express";
import { requireAuth, requireVerification, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { create, list, getMine, update, remove } from "../controllers/requests.controller";
const router = Router();
router.use(requireAuth, requireMarketplaceUser);
// POST requires residency verification (Part 6 — posting a request is a gated action)
router.post("/", requireVerification, create);
router.get("/", list);
router.get("/mine", getMine);
router.patch("/:id", update);
router.delete("/:id", remove);
export default router;
//# sourceMappingURL=requests.routes.js.map
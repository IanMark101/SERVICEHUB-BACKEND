import { Router } from "express";
import { requireAuth, requireMarketplaceUser, requireVerification } from "../middlewares/auth.middleware";
import { list, create, listConversations } from "../controllers/messages.controller";

const router = Router();

router.use(requireAuth, requireMarketplaceUser);

router.get("/conversations", listConversations);
router.get("/:completedServiceId", list);
router.post("/:completedServiceId", requireVerification, create);

export default router;

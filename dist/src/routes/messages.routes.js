import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { list, create, listConversations } from "../controllers/messages.controller";
const router = Router();
router.use(requireAuth, requireMarketplaceUser);
router.get("/conversations", listConversations);
router.get("/:completedServiceId", list);
router.post("/:completedServiceId", create);
export default router;
//# sourceMappingURL=messages.routes.js.map
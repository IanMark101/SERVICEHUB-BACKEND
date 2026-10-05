import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { list, create, listConversations, listConversationGroups, showConversationGroupForBooking } from "../controllers/messages.controller";
import { messageMutationLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

router.use(requireAuth, requireMarketplaceUser);

router.get("/conversations", listConversations);
router.get("/contacts", listConversationGroups);
router.get("/contacts/booking/:bookingId", showConversationGroupForBooking);
router.get("/:completedServiceId", list);
router.post("/:completedServiceId", messageMutationLimiter, create);

export default router;

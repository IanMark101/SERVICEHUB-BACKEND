import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { list, create } from "../controllers/messages.controller";

const router = Router();

router.use(requireAuth);

router.get("/:completedServiceId", list);
router.post("/:completedServiceId", create);

export default router;

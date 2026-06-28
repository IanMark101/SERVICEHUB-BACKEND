import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { getMyTransactions } from "../controllers/transactions.controller";

const router = Router();

router.use(requireAuth);

// GET /transactions — provider's own transaction/earning history
router.get("/", getMyTransactions);

export default router;

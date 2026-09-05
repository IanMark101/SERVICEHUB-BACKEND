import { Router } from "express";
import { searchUsers } from "../controllers/users.controller";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import {
  cancelDeletionRequest,
  createAccountDeletionRequest,
  readAccountDeletionRequest,
} from "../controllers/account-deletion.controller";

const router = Router();

// User discovery is available to signed-in residents only.
router.get("/", requireAuth, searchUsers);
router.get("/me/account-deletion", requireAuth, requireMarketplaceUser, readAccountDeletionRequest);
router.post("/me/account-deletion", requireAuth, requireMarketplaceUser, createAccountDeletionRequest);
router.delete("/me/account-deletion", requireAuth, requireMarketplaceUser, cancelDeletionRequest);

export default router;

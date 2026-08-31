import { Router } from "express";
import { searchUsers } from "../controllers/users.controller";
import { requireAuth } from "../middlewares/auth.middleware";
const router = Router();
// User discovery is available to signed-in residents only.
router.get("/", requireAuth, searchUsers);
export default router;
//# sourceMappingURL=users.routes.js.map
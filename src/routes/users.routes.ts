import { Router } from "express";
import { searchUsers } from "../controllers/users.controller";

const router = Router();

// Public user search / listing
router.get("/", searchUsers);

export default router;

import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { create, list, getMine, update, remove } from "../controllers/requests.controller";

const router = Router();

router.use(requireAuth);

router.post("/", create);
router.get("/", list);
router.get("/mine", getMine);
router.patch("/:id", update);
router.delete("/:id", remove);

export default router;

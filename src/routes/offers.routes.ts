import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { create, getReceived, getMine, accept, reject } from "../controllers/offers.controller";

const router = Router();

router.use(requireAuth);

router.post("/", create);
router.get("/received", getReceived);   // seeker: offers on their requests
router.get("/mine", getMine);           // provider: their own submitted bids
router.patch("/:id/accept", accept);
router.patch("/:id/reject", reject);

export default router;

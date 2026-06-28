"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const offers_controller_1 = require("../controllers/offers.controller");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.requireAuth);
router.post("/", offers_controller_1.create);
router.get("/received", offers_controller_1.getReceived); // seeker: offers on their requests
router.get("/mine", offers_controller_1.getMine); // provider: their own submitted bids
router.patch("/:id/accept", offers_controller_1.accept);
router.patch("/:id/reject", offers_controller_1.reject);
exports.default = router;
//# sourceMappingURL=offers.routes.js.map
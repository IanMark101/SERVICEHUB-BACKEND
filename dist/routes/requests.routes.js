"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const requests_controller_1 = require("../controllers/requests.controller");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.requireAuth);
// POST requires residency verification (Part 6 — posting a request is a gated action)
router.post("/", auth_middleware_1.requireVerification, requests_controller_1.create);
router.get("/", requests_controller_1.list);
router.get("/mine", requests_controller_1.getMine);
router.patch("/:id", requests_controller_1.update);
router.delete("/:id", requests_controller_1.remove);
exports.default = router;
//# sourceMappingURL=requests.routes.js.map
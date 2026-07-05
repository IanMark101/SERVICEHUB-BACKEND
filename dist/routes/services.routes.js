"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const services_controller_1 = require("../controllers/services.controller");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = (0, express_1.Router)();
// Public
router.get("/", services_controller_1.browse);
// Protected — provider's own listings (MUST be before /:id to avoid route conflict)
router.get("/mine", auth_middleware_1.requireAuth, services_controller_1.getMine);
// Public single service
router.get("/:id", services_controller_1.getOne);
// Protected mutations — POST /services requires residency verification (Part 6)
router.post("/", auth_middleware_1.requireAuth, auth_middleware_1.requireVerification, services_controller_1.create);
router.patch("/:id", auth_middleware_1.requireAuth, services_controller_1.update);
router.patch("/:id/toggle", auth_middleware_1.requireAuth, services_controller_1.toggle);
router.delete("/:id", auth_middleware_1.requireAuth, services_controller_1.remove);
exports.default = router;
//# sourceMappingURL=services.routes.js.map
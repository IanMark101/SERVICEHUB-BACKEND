"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const verification_controller_1 = require("../controllers/verification.controller");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = (0, express_1.Router)();
// All verification routes require authentication and standard user role
router.use(auth_middleware_1.requireAuth, auth_middleware_1.requireMarketplaceUser);
router.post("/submit", verification_controller_1.submit);
router.get("/status", verification_controller_1.getStatus);
exports.default = router;
//# sourceMappingURL=verification.routes.js.map
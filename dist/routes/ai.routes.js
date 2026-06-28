"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const ai_controller_1 = require("../controllers/ai.controller");
const router = (0, express_1.Router)();
router.get("/provider-summary/:providerId", ai_controller_1.getProviderSummary);
router.post("/match-providers", auth_middleware_1.requireAuth, ai_controller_1.matchProviders);
exports.default = router;
//# sourceMappingURL=ai.routes.js.map
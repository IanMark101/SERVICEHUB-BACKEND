"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const messages_controller_1 = require("../controllers/messages.controller");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.requireAuth);
router.get("/:completedServiceId", messages_controller_1.list);
router.post("/:completedServiceId", messages_controller_1.create);
exports.default = router;
//# sourceMappingURL=messages.routes.js.map
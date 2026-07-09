"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const transactions_controller_1 = require("../controllers/transactions.controller");
const router = (0, express_1.Router)();
router.use(auth_middleware_1.requireAuth, auth_middleware_1.requireMarketplaceUser);
// GET /transactions — provider's own transaction/earning history
router.get("/", transactions_controller_1.getMyTransactions);
exports.default = router;
//# sourceMappingURL=transactions.routes.js.map
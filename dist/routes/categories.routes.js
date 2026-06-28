"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const categories_controller_1 = require("../controllers/categories.controller");
const router = (0, express_1.Router)();
// GET /categories — public list of all active categories
router.get("/", categories_controller_1.getCategories);
// POST /categories/suggest — suggest category (requires auth)
router.post("/suggest", auth_middleware_1.requireAuth, categories_controller_1.suggestCategory);
// GET /categories/suggestions/mine — user's suggestions list (requires auth)
router.get("/suggestions/mine", auth_middleware_1.requireAuth, categories_controller_1.getMySuggestions);
exports.default = router;
//# sourceMappingURL=categories.routes.js.map
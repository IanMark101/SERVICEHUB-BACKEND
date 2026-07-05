"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = (0, express_1.Router)();
// Public routes
router.post("/register", auth_controller_1.register);
router.post("/login", auth_controller_1.login);
router.post("/google-login", auth_controller_1.googleLogin);
router.post("/refresh", auth_controller_1.refresh);
router.post("/logout", auth_controller_1.logout);
router.get("/verify-email/:token", auth_controller_1.verifyEmailHandler);
router.post("/forgot-password", auth_controller_1.forgotPasswordHandler);
router.post("/reset-password", auth_controller_1.resetPasswordHandler);
// Protected routes
router.get("/me", auth_middleware_1.requireAuth, auth_controller_1.getMe);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map
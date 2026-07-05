"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const env_1 = require("./config/env");
// Route imports
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const verification_routes_1 = __importDefault(require("./routes/verification.routes"));
const services_routes_1 = __importDefault(require("./routes/services.routes"));
const categories_routes_1 = __importDefault(require("./routes/categories.routes"));
const bookings_routes_1 = __importDefault(require("./routes/bookings.routes"));
const requests_routes_1 = __importDefault(require("./routes/requests.routes"));
const offers_routes_1 = __importDefault(require("./routes/offers.routes"));
const messages_routes_1 = __importDefault(require("./routes/messages.routes"));
const notifications_routes_1 = __importDefault(require("./routes/notifications.routes"));
const admin_routes_1 = __importDefault(require("./routes/admin.routes"));
const ai_routes_1 = __importDefault(require("./routes/ai.routes"));
const transactions_routes_1 = __importDefault(require("./routes/transactions.routes"));
const reviews_routes_1 = __importDefault(require("./routes/reviews.routes"));
const app = (0, express_1.default)();
// ─── Global Middleware ──────────────────────────────────────────────────────
app.use((0, cors_1.default)({
    origin: env_1.env.FRONTEND_URL,
    credentials: true, // allow cookies (refresh token)
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));
app.use(express_1.default.json({ limit: "10mb" }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
// ─── Health Check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "ServiceHub Cordova API", timestamp: new Date().toISOString() });
});
// ─── API Routes ─────────────────────────────────────────────────────────────
app.use("/api/auth", auth_routes_1.default);
app.use("/api/verifications", verification_routes_1.default);
app.use("/api/services", services_routes_1.default);
app.use("/api/categories", categories_routes_1.default);
app.use("/api/bookings", bookings_routes_1.default);
app.use("/api/requests", requests_routes_1.default);
app.use("/api/offers", offers_routes_1.default);
app.use("/api/messages", messages_routes_1.default);
app.use("/api/notifications", notifications_routes_1.default);
app.use("/api/admin", admin_routes_1.default);
app.use("/api/ai", ai_routes_1.default);
app.use("/api/transactions", transactions_routes_1.default);
app.use("/api/reviews", reviews_routes_1.default);
// ─── Global Error Handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    const status = err.status || err.statusCode || 500;
    const message = env_1.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    res.status(status).json({ success: false, error: message });
});
exports.default = app;
//# sourceMappingURL=app.js.map
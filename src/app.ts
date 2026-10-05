import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env";

// Route imports
import authRoutes from "./routes/auth.routes";
import verificationRoutes from "./routes/verification.routes";
import serviceRoutes from "./routes/services.routes";
import categoryRoutes from "./routes/categories.routes";
import bookingRoutes from "./routes/bookings.routes";
import requestRoutes from "./routes/requests.routes";
import offerRoutes from "./routes/offers.routes";
import messageRoutes from "./routes/messages.routes";
import notificationRoutes from "./routes/notifications.routes";
import adminRoutes from "./routes/admin.routes";
import aiRoutes from "./routes/ai.routes";
import transactionRoutes from "./routes/transactions.routes";
import reviewsRoutes from "./routes/reviews.routes";
import usersRoutes from "./routes/users.routes";
import communityRoutes from "./routes/community.routes";
import uploadRoutes from "./routes/upload.routes";
import contentCasesRoutes from "./routes/content-cases.routes";
import { apiLimiter, webhookLimiter } from "./middlewares/rateLimiter.middleware";
import { receivePaymongoWebhook } from "./controllers/payments.controller";
import { requestContext } from "./middlewares/requestContext.middleware";
import { logger } from "./utils/logger";

const app = express();
app.disable("x-powered-by");
app.use(requestContext);

// ─── Global Middleware ──────────────────────────────────────────────────────

app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true, // allow cookies (refresh token)
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

// This route must receive the unmodified request bytes for signature checks.
app.post("/api/payments/paymongo/webhook", webhookLimiter, express.raw({ type: "application/json", limit: "1mb" }), receivePaymongoWebhook);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Health Check ───────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ServiceHub Cordova API", timestamp: new Date().toISOString() });
});

// ─── Apply General API Rate Limiting ────────────────────────────────────────

app.use("/api", apiLimiter);

// ─── API Routes ─────────────────────────────────────────────────────────────

app.use("/api/auth", authRoutes);
app.use("/api/verifications", verificationRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/requests", requestRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/community", communityRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/content-cases", contentCasesRoutes);

// ─── Global Error Handler ────────────────────────────────────────────────────

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const err = error as Error & { status?: number; statusCode?: number; errors?: unknown; issues?: unknown; code?: string; field?: string };
  const status = err.name === "ZodError" ? 400 : err.status || err.statusCode || 500;
  const requestId = String(res.locals.requestId || "unknown");

  logger.error("request_failed", {
    requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    code: err.code,
    error: err,
  });

  if (err.name === "ZodError") {
    return res.status(400).json({ success: false, error: "Validation failed", errors: err.issues || err.errors, requestId });
  }
  const message = env.NODE_ENV === "production" && status >= 500 ? "Internal server error" : err.message;
  const moderationField = err.code === "CONTENT_REVISION_REQUIRED" && ["title", "description", "category"].includes(err.field || "") ? err.field : undefined;
  const passwordCode = ["CURRENT_PASSWORD_INCORRECT", "CURRENT_PASSWORD_CHANGED", "PASSWORD_NOT_SET", "PASSWORD_ALREADY_SET", "GOOGLE_VERIFICATION_EXPIRED", "GOOGLE_VERIFICATION_FAILED", "GOOGLE_NOT_CONNECTED", "GOOGLE_UNAVAILABLE", "SIGN_IN_METHODS_CHANGED", "SESSION_EXPIRED"].includes(err.code || "") ? err.code : undefined;
  const offerCode = ['REQUEST_RESERVED', 'REQUEST_LISTING_REQUIRED', 'OFFER_LISTING_UNAVAILABLE', 'DUPLICATE_OFFER', 'REQUEST_ALREADY_MATCHED', 'REQUEST_DELETE_BLOCKED', 'REQUEST_STATE_CHANGED', 'PARTICIPANT_INELIGIBLE', 'SEEKER_UNAVAILABLE', 'SELF_TRANSACTION_NOT_ALLOWED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'EMAIL_NOT_VERIFIED', 'VERIFICATION_REQUIRED'].includes(err.code || '') ? err.code : undefined;
  res.status(status).json({ success: false, error: message || "Request failed", ...(moderationField ? { code: "CONTENT_REVISION_REQUIRED", field: moderationField } : {}), ...((passwordCode || offerCode) ? { code: passwordCode || offerCode } : {}), requestId });
});

export default app;

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
import { apiLimiter } from "./middlewares/rateLimiter.middleware";
import { receivePaymongoWebhook } from "./controllers/payments.controller";

const app = express();

// ─── Global Middleware ──────────────────────────────────────────────────────

app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true, // allow cookies (refresh token)
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

// This route must receive the unmodified request bytes for signature checks.
app.post("/api/payments/paymongo/webhook", express.raw({ type: "application/json", limit: "1mb" }), receivePaymongoWebhook);

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

// ─── Global Error Handler ────────────────────────────────────────────────────

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  if (err?.name === "ZodError") {
    return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
  }
  const status = err.status || err.statusCode || 500;
  const message = env.NODE_ENV === "production" ? "Internal server error" : err.message;
  res.status(status).json({ success: false, error: message });
});

export default app;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    DATABASE_URL: zod_1.z.string().min(1, "DATABASE_URL is required"),
    JWT_ACCESS_SECRET: zod_1.z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 chars"),
    JWT_REFRESH_SECRET: zod_1.z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 chars"),
    JWT_ACCESS_EXPIRES_IN: zod_1.z.string().default("15m"),
    JWT_REFRESH_EXPIRES_IN: zod_1.z.string().default("7d"),
    PORT: zod_1.z.string().default("3001"),
    NODE_ENV: zod_1.z.enum(["development", "production", "test"]).default("development"),
    FRONTEND_URL: zod_1.z.string().default("http://localhost:5173"),
    // PayMongo (test mode for capstone)
    PAYMONGO_SECRET_KEY: zod_1.z.string().optional(),
    PAYMONGO_PUBLIC_KEY: zod_1.z.string().optional(),
    // Gemini AI
    GEMINI_API_KEY: zod_1.z.string().optional(),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error("❌ Invalid environment variables:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
}
exports.env = parsed.data;
//# sourceMappingURL=env.js.map
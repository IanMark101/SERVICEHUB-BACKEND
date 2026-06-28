"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateServiceSchema = exports.CreateServiceSchema = void 0;
const zod_1 = require("zod");
exports.CreateServiceSchema = zod_1.z.object({
    categoryId: zod_1.z.string().cuid("Invalid category"),
    title: zod_1.z
        .string()
        .min(10, "Title must be at least 10 characters")
        .max(100, "Title must be at most 100 characters")
        .regex(/^[a-zA-Z0-9\s,.'&()-]+$/, "Title contains invalid characters"),
    description: zod_1.z
        .string()
        .min(30, "Description must be at least 30 characters")
        .max(1000, "Description must be at most 1000 characters"),
    price: zod_1.z
        .number()
        .min(50, "Price must be at least ₱50")
        .max(50000, "Price must be at most ₱50,000"),
    priceType: zod_1.z.enum(["FIXED", "STARTS_AT", "PER_HOUR"]).default("FIXED"),
    estimatedDurationMins: zod_1.z
        .number()
        .min(15, "Duration must be at least 15 minutes")
        .max(480, "Duration must be at most 8 hours (480 minutes)"),
    queueLimit: zod_1.z
        .number()
        .int("Queue limit must be a whole number")
        .min(1, "Queue limit must be at least 1")
        .max(10, "Queue limit must be at most 10"),
    paymentMethods: zod_1.z
        .object({
        gcash: zod_1.z.boolean().default(false),
        maya: zod_1.z.boolean().default(false),
        cash: zod_1.z.boolean().default(false),
    })
        .refine((pm) => pm.gcash || pm.maya || pm.cash, "At least one payment method must be selected"),
});
exports.UpdateServiceSchema = zod_1.z.object({
    title: zod_1.z
        .string()
        .min(10)
        .max(100)
        .regex(/^[a-zA-Z0-9\s,.'&()-]+$/)
        .optional(),
    description: zod_1.z.string().min(30).max(1000).optional(),
    price: zod_1.z.number().min(50).max(50000).optional(),
    priceType: zod_1.z.enum(["FIXED", "STARTS_AT", "PER_HOUR"]).optional(),
    estimatedDurationMins: zod_1.z.number().min(15).max(480).optional(),
    queueLimit: zod_1.z.number().int().min(1).max(10).optional(),
    paymentMethods: zod_1.z
        .object({
        gcash: zod_1.z.boolean(),
        maya: zod_1.z.boolean(),
        cash: zod_1.z.boolean(),
    })
        .optional(),
    categoryId: zod_1.z.string().cuid().optional(),
});
//# sourceMappingURL=services.schema.js.map
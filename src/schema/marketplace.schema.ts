import { z } from "zod";

const Cuid = z.string().cuid();
const Money = z.coerce.number().finite().min(50).max(50_000);
const Text = (max: number) => z.string().trim().max(max);

export const DirectBookingSchema = z.object({
  serviceId: Cuid,
  schedule: Text(500).optional(),
  message: Text(2_000).optional(),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  scheduledTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
}).strict();

export const InitiatePaymentSchema = z.object({
  serviceId: Cuid,
  offerId: Cuid.optional(),
  paymentMethodType: z.enum(["gcash", "paymaya"]).default("gcash"),
}).strict();

export const ConfirmOnlineBookingSchema = z.object({
  serviceId: Cuid,
  paymentIntentId: z.string().trim().min(3).max(255),
  offerId: Cuid.optional(),
}).strict();

export const OfferSchema = z.object({
  requestId: Cuid,
  offeredPrice: Money,
  estimatedDuration: z.coerce.number().int().min(15).max(480),
  availability: Text(500).optional(),
  message: Text(2_000).optional(),
}).strict();

export const ServiceRequestSchema = z.object({
  categoryId: Cuid,
  title: Text(100).min(3),
  description: Text(2_000).min(10),
  budgetMin: Money,
  budgetMax: Money,
  urgency: z.enum(["low", "medium", "high"]).default("medium"),
}).strict().refine((value) => value.budgetMax >= value.budgetMin, {
  message: "budgetMax must be greater than or equal to budgetMin",
  path: ["budgetMax"],
});

export const ServiceRequestUpdateSchema = z.object({
  title: Text(100).min(3).optional(),
  description: Text(2_000).min(10).optional(),
  budgetMin: Money.optional(),
  budgetMax: Money.optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED", "CANCELED"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const ReviewSchema = z.object({
  completedServiceId: Cuid,
  rating: z.coerce.number().int().min(1).max(5),
  text: Text(2_000).optional(),
  tags: z.array(Text(50)).max(10).optional(),
}).strict();

export const ReviewUpdateSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  text: Text(2_000).optional(),
  tags: z.array(Text(50)).max(10).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

const VerificationProofSchema = z.object({
  fileUrl: z.string().regex(
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i,
    "Proof must be a JPEG, PNG, or WebP data URL",
  ).max(10 * 1024 * 1024),
  documentType: z.enum(["GOVERNMENT_ID", "BARANGAY_ID", "PROOF_OF_RESIDENCY"]),
}).strict();

export const VerificationSubmissionSchema = z.object({
  proofs: z.array(VerificationProofSchema).min(1).max(2),
}).strict();

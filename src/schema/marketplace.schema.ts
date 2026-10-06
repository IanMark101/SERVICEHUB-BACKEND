import { z } from "zod";
import { VERIFICATION_PRIVACY_NOTICE_VERSION } from "../config/privacy";

const Cuid = z.string().cuid();
const Money = z.coerce.number().finite().min(50).max(50_000);
const Text = (max: number) => z.string().trim().max(max);
const RequestTitle = z.string().trim().toUpperCase().min(3).max(100);
export const RequestPaymentMethodsSchema = z.object({
  cash: z.boolean(),
  gcash: z.boolean(),
}).strict().refine((methods) => methods.cash || methods.gcash, {
  message: "Select at least one payment method you can use.",
});

export const DirectBookingSchema = z.object({
  serviceId: Cuid,
  quantity: z.number().int().min(1).max(40).default(1),
  schedule: Text(500).optional(),
  message: Text(2_000).optional(),
}).strict();

export const InitiatePaymentSchema = z.object({
  serviceId: Cuid.optional(),
  offerId: Cuid.optional(),
  quantity: z.number().int().min(1).max(40).default(1),
  paymentMethodType: z.literal("gcash").default("gcash"),
}).strict();

export const ConfirmOnlineBookingSchema = z.object({
  serviceId: Cuid.optional(),
  paymentIntentId: z.string().trim().min(3).max(255),
  offerId: Cuid.optional(),
}).strict();

export const OfferSchema = z.object({
  requestId: Cuid,
  serviceId: Cuid.optional(),
  offeredPrice: Money,
  estimatedDuration: z.coerce.number().int().min(15).max(480),
  availability: Text(500).optional(),
  message: Text(2_000).optional(),
}).strict();

export const RequestUrgencySchema = z.enum([
  'ASAP / Today', 'Needs Tomorrow', 'Next 1-2 Days', 'This Week', 'Flexible Schedule',
], { error: 'Select a valid urgency: ASAP / Today, Needs Tomorrow, Next 1-2 Days, This Week, or Flexible Schedule.' });

export const ServiceRequestSchema = z.object({
  categoryId: Cuid,
  title: RequestTitle,
  description: Text(2_000).min(10),
  budgetMin: Money,
  budgetMax: Money,
  urgency: RequestUrgencySchema,
  paymentMethods: RequestPaymentMethodsSchema,
}).strict().refine((value) => value.budgetMax >= value.budgetMin, {
  message: "budgetMax must be greater than or equal to budgetMin",
  path: ["budgetMax"],
});

export const ServiceRequestUpdateSchema = z.object({
  title: RequestTitle.optional(),
  description: Text(2_000).min(10).optional(),
  budgetMin: Money.optional(),
  budgetMax: Money.optional(),
  status: z.enum(["OPEN", "CLOSED"]).optional(),
  paymentMethods: RequestPaymentMethodsSchema.optional(),
  urgency: RequestUrgencySchema.optional(),
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
  storageKey: z.string().trim().min(10).max(500).regex(/^servicehub\/verification\/[A-Za-z0-9_\/-]+\.(?:jpg|jpeg|png|webp)$/i),
  documentType: z.enum([
    "GOVERNMENT_ID",
    "BARANGAY_ID",
    "PROOF_OF_RESIDENCE",
  ]),
}).strict();

export const VerificationSubmissionSchema = z.object({
  proofs: z.array(VerificationProofSchema).min(1).max(2),
  privacyNoticeVersion: z.literal(VERIFICATION_PRIVACY_NOTICE_VERSION),
  privacyAcknowledged: z.literal(true),
}).strict();

export const VerificationProofAccessSchema = z.object({
  action: z.enum(["view", "download"]).default("view"),
}).strict();

const ManagedImageUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname.endsWith("res.cloudinary.com");
}, "Image must be a secure Cloudinary URL");

export const CategorySuggestionSchema = z.object({
  name: Text(80).min(3),
  description: Text(500).min(10),
}).strict();

export const AdminCategoryUpdateSchema = z.object({
  name: Text(80).min(3).optional(),
  isActive: z.boolean().optional(),
  reason: Text(500).min(3),
}).strict().refine((value) => value.name !== undefined || value.isActive !== undefined, {
  message: "A category name or status change is required",
});

export const AdminCategoryCreateSchema = z.object({ name: Text(80).min(3), reason: Text(500).min(3) }).strict();

export const MessageSchema = z.object({
  content: Text(2_000).min(1, "Message content is required"),
}).strict();

export const WaitlistSchema = z.object({ serviceId: Cuid }).strict();

export const DisputeSchema = z.object({
  reason: z.enum(["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE", "SCAM_OR_FRAUD", "INAPPROPRIATE_BEHAVIOR", "OVERPRICING", "NO_SHOW"]),
  description: Text(2_000).min(10),
  evidenceUrl: ManagedImageUrl.optional(),
}).strict();

export const SafetyReportSchema = z.object({
  reason: z.enum(["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE", "SCAM_OR_FRAUD", "INAPPROPRIATE_BEHAVIOR", "OVERPRICING", "NO_SHOW"]),
  description: Text(2_000).min(10),
  evidenceStorageKey: z.string().trim().max(500).optional(),
}).strict();

export const PrivateEvidenceAccessSchema = z.object({
  action: z.enum(["view", "download"]).default("view"),
}).strict();

export const CancellationRequestSchema = z.object({ reason: Text(1_000).min(3) }).strict();
export const CompletionEscalationSchema = z.object({ reason: Text(1_000).min(10) }).strict();
export const AdminCompletionEscalationResolutionSchema = z.object({
  action: z.enum(["release_provider_and_complete", "refund_seeker", "keep_awaiting"]),
  resolution: Text(2_000).min(3),
}).strict();
export const CancellationResponseSchema = z.object({
  approve: z.boolean(),
  responderNote: Text(1_000).optional(),
  // Compatibility for clients released before the neutral responder field.
  providerNote: Text(1_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.approve && (value.responderNote || value.providerNote || "").length < 3) {
    ctx.addIssue({ code: "custom", path: ["responderNote"], message: "Explain why the booking should continue (at least 3 characters)" });
  }
});
export const BooleanDecisionSchema = z.object({
  approve: z.boolean(),
  adminNotes: Text(2_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.approve && (!value.adminNotes || value.adminNotes.length < 3)) {
    ctx.addIssue({
      code: "custom",
      path: ["adminNotes"],
      message: "A clear rejection reason is required",
    });
  }
});
export const DirectResponseSchema = z.object({ accept: z.boolean() }).strict();
export const DirectOfferSchema = z.object({ offerId: Cuid }).strict();
export const TrustAdjustmentSchema = z.object({
  delta: z.coerce.number().int().min(-100).max(100).refine((value) => value !== 0, "Trust adjustment cannot be zero"),
  reason: Text(500).min(3),
  currentPassword: z.string().min(1).max(200),
  operationId: z.string().uuid(),
}).strict();
export const AdminCancellationDecisionSchema = z.object({
  approve: z.boolean(),
  adminNotes: Text(2_000).min(3),
  fault: z.enum(["none", "seeker", "provider"]).default("none"),
}).strict().refine(value => value.approve || value.fault === "none", {
  path: ["fault"], message: "A denied cancellation cannot apply a cancellation penalty",
});
export const ReportResolutionSchema = z.object({
  outcome: z.enum(["dismiss", "resolve_safety", "cancel_booking", "release_provider_and_complete"]),
  penaltyAction: z.enum(["none", "warn", "trust_deduct", "suspend", "ban"]).default("none"),
  adminNotes: Text(2_000).min(3),
}).strict();
export const SuspendUserSchema = z.object({
  reason: Text(500).min(3),
  durationDays: z.coerce.number().int().min(1).max(365),
}).strict();
export const BanUserSchema = z.object({ reason: Text(500).min(3) }).strict();
export const RestoreUserSchema = z.object({ reason: Text(500).min(3) }).strict();
export const ReviewModerationSchema = z.object({
  action: z.enum(["hide", "restore"]),
  reason: Text(1_000).min(3),
}).strict();
export const AiMatchSchema = z.object({ requestId: Cuid }).strict();

export const AnnouncementCreateSchema = z.object({
  title: Text(120).min(5),
  body: Text(1_500).min(10),
  isPublished: z.boolean().optional().default(true),
}).strict();

export const AnnouncementUpdateSchema = z.object({
  title: Text(120).min(5).optional(),
  body: Text(1_500).min(10).optional(),
  isPublished: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

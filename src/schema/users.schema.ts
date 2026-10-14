import { z } from "zod";

// This is a member directory, not the administrator's user-management search.
export const MemberSearchSchema = z.object({
  search: z.string().trim().max(100).optional(),
  role: z.literal("user").optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const UpdateOnboardingStatusSchema = z
  .object({
    status: z.enum(["COMPLETED", "SKIPPED"]),
  })
  .strict();

export type UpdateOnboardingStatusInput = z.infer<typeof UpdateOnboardingStatusSchema>;

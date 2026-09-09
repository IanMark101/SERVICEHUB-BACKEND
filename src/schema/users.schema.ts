import { z } from "zod";

export const UpdateOnboardingStatusSchema = z
  .object({
    status: z.enum(["COMPLETED", "SKIPPED"]),
  })
  .strict();

export type UpdateOnboardingStatusInput = z.infer<typeof UpdateOnboardingStatusSchema>;

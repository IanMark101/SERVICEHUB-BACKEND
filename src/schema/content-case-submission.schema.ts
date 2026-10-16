import { z } from "zod";

export const ContentReportReasonSchema = z.enum([
  "MISLEADING", "SCAM", "INAPPROPRIATE", "UNSAFE", "SPAM", "OTHER",
]);

export const ContentCaseSubmissionSchema = z.object({
  caseType: z.enum(["REPORT", "APPEAL"]),
  contentType: z.enum(["SERVICE_LISTING", "SERVICE_REQUEST"]),
  resourceId: z.string().cuid().optional(),
  reason: z.string().trim().min(10).max(1000),
  // Omitted by older clients and historical records; new report forms require it.
  reportReason: ContentReportReasonSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.caseType === "APPEAL" && value.reportReason !== undefined) {
    context.addIssue({ code: "custom", path: ["reportReason"], message: "A report reason is only used when reporting a listing." });
  }
});

export type ContentCaseInput = z.infer<typeof ContentCaseSubmissionSchema>;

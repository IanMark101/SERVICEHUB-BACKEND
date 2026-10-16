import { z } from "zod";
import { ContentReportReasonSchema } from "./content-case-submission.schema";

export const ContentReportReasonFilterSchema = ContentReportReasonSchema.or(z.literal("UNSPECIFIED"));
export type ContentReportReasonFilter = z.infer<typeof ContentReportReasonFilterSchema>;

export const ContentDecisionSchema = z.object({
  decision: z.enum(["KEEP", "REMOVE", "RESTORE", "KEEP_REMOVED", "GUIDANCE"]),
  penalty: z.enum(["none", "warn", "suspend", "ban"]).default("none"),
  resolution: z.string().trim().min(10).max(1000),
  expectedUpdatedAt: z.string().datetime().optional(),
  expectedOwnerStatus: z.enum(["ACTIVE", "SUSPENDED", "BANNED"]).optional(),
  suspensionDays: z.number().int().min(1).max(30).default(7),
}).strict().superRefine((value, context) => {
  if (["KEEP", "RESTORE", "GUIDANCE"].includes(value.decision) && value.penalty !== "none") context.addIssue({ code: "custom", path: ["penalty"], message: "This decision cannot include an account penalty." });
  if ((["REMOVE", "RESTORE"].includes(value.decision) || value.penalty !== "none") && !value.expectedUpdatedAt) context.addIssue({ code: "custom", path: ["expectedUpdatedAt"], message: "Open the current content before making this decision." });
  if (value.penalty !== "none" && !value.expectedOwnerStatus) context.addIssue({ code: "custom", path: ["expectedOwnerStatus"], message: "Review the owner's current account status first." });
});
export type ContentDecisionInput = z.infer<typeof ContentDecisionSchema>;

export const ContentWorkspaceQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  contentType: z.enum(["SERVICE_LISTING", "SERVICE_REQUEST"]).optional(),
  caseType: z.enum(["REPORT", "APPEAL"]).optional(),
  reportReason: ContentReportReasonFilterSchema.optional(),
  status: z.enum(["OPEN", "RESOLVED"]).default("OPEN"),
  search: z.string().trim().max(100).default(""),
}).refine(value => value.caseType !== "APPEAL" || !value.reportReason, {
  path: ["reportReason"], message: "Report reasons apply to reports from users, not owner appeals.",
});

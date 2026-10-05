/** Keep the workroom and the mutation guard on the same lifecycle policy. */
export function allowedReportOutcomes(report: { reportType: string; status: string; booking: { status: string; statusBeforeDispute: string | null } }) {
  if (!["PENDING", "UNDER_REVIEW"].includes(report.status) || report.reportType === "CANCELLATION_ESCALATION") return [];
  const outcomes = ["dismiss"];
  if (report.reportType === "SAFETY") outcomes.push("resolve_safety");
  if (!["COMPLETED", "CANCELED"].includes(report.booking.status)) outcomes.push("cancel_booking");
  if (report.reportType === "COMPLETION_DISPUTE" && report.booking.statusBeforeDispute === "AWAITING_CONFIRMATION") outcomes.push("release_provider_and_complete");
  return outcomes;
}

export function assertReportDecision(report: Parameters<typeof allowedReportOutcomes>[0], outcome: string, penalty: string) {
  if (outcome === "dismiss" && penalty !== "none") throw Object.assign(new Error("Dismissed reports cannot apply an account penalty. Record a supported finding before penalizing a participant."), { status: 422, code: "DISMISSED_REPORT_PENALTY" });
  if (!allowedReportOutcomes(report).includes(outcome)) throw Object.assign(new Error("This decision is not available for the current case and booking state. Refresh the case before continuing."), { status: 422, code: "INVALID_REPORT_OUTCOME" });
}

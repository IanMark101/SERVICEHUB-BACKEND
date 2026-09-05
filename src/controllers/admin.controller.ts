// Compatibility facade: routes keep importing this path while each admin
// feature is implemented in its focused controller module.
export { getOverview } from "./admin/overview.controller";
export {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement
} from "./admin/announcements.controller";
export {
  listUsers,
  updateTrustScore,
  suspendUser,
  banUser,
  restoreUser,
  restorePostingPrivilege,
  promoteUserToAdmin
} from "./admin/users.controller";
export {
  listPendingServices,
  reviewService,
  listCategorySuggestions,
  resolveCategorySuggestion
} from "./admin/marketplace-moderation.controller";
export { listReports, resolveReport, accessReportEvidence } from "./admin/reports.controller";
export {
  resolveCancellationRequest,
  listEscalatedCancellations
} from "./admin/cancellations.controller";

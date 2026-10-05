import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { disconnectUserSockets, safeBroadcast, safeEmit } from "../lib/socket";
import { lockAccountLifecycle } from "./account-lifecycle.service";
import { NONTERMINAL_BOOKING_STATUSES } from "./data-retention.service";
import { applyPublicContentAction, emitPublicContentAction, type PublicContentType } from "./public-content-actions.service";
import { ContentDecisionSchema, type ContentDecisionInput } from "../schema/content-workspace.schema";

const ownerSelect = { id: true, name: true, email: true, trustScore: true, verificationStatus: true, moderationStatus: true, isActive: true, deactivatedAt: true, role: true, emailVerified: true } as const;
const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
type Reader = Prisma.TransactionClient;
type Query = { page: number; limit: number; contentType?: PublicContentType; caseType?: "REPORT" | "APPEAL"; status?: "OPEN" | "RESOLVED"; search?: string };

export async function readPublicContent(db: Reader, type: PublicContentType, id: string) {
  if (type === "SERVICE_LISTING") {
    const item = await db.service.findUnique({ where: { id }, include: { provider: { select: ownerSelect }, category: { select: { name: true, isActive: true } } } });
    if (!item || item.status === "DELETED") return null;
    const visible = item.status === "ACTIVE" && item.isAvailable && item.provider.isActive && item.provider.moderationStatus === "ACTIVE" && item.provider.emailVerified && item.provider.verificationStatus === "APPROVED" && ["FIXED", "PER_HOUR", "PER_DAY", "PER_PROJECT"].includes(item.priceType) && Number(item.price) >= 50;
    return { id, contentType: type, title: item.title, description: item.description, category: item.category.name, owner: item.provider, status: item.status, visibility: visible ? "Public" : item.status === "INACTIVE" ? "Paused" : item.moderationReasonCode === "ADMIN_REMOVED" ? "Removed by admin" : "Hidden", moderationReasonCode: item.moderationReasonCode, adminNotes: item.adminNotes, createdAt: item.createdAt, updatedAt: item.updatedAt, price: item.price === null ? null : Number(item.price), priceType: item.priceType, budgetMin: null, budgetMax: null, urgency: null, canRemove: ["ACTIVE", "INACTIVE"].includes(item.status), canRestore: item.status === "SUSPENDED" && item.moderationReasonCode === "ADMIN_REMOVED", actionBlock: null as string | null };
  }
  const item = await db.serviceRequest.findUnique({ where: { id }, include: { seeker: { select: ownerSelect }, category: { select: { name: true, isActive: true } }, offers: { select: { id: true } } } });
  if (!item || item.targetServiceId) return null;
  const offerIds = item.offers.map(offer => offer.id);
  const bookings = await db.booking.count({ where: { offerId: { in: offerIds }, status: { notIn: ["DECLINED", "CANCELED", "REMOVED"] } } });
  const payments = await db.paymentAttempt.count({ where: { offerId: { in: offerIds }, status: { in: ["PENDING", "SUCCEEDED", "REFUND_REQUIRED"] } } });
  const visible = item.status === "OPEN" && !bookings && !payments && item.seeker.isActive && item.seeker.moderationStatus === "ACTIVE" && item.seeker.emailVerified && item.seeker.verificationStatus === "APPROVED";
  return { id, contentType: type, title: item.title, description: item.description, category: item.category.name, owner: item.seeker, status: item.status, visibility: visible ? "Public" : item.moderationReasonCode === "ADMIN_REMOVED" ? "Removed by admin" : item.status === "CLOSED" ? "Paused" : bookings || payments ? "In booking / payment" : "Hidden", moderationReasonCode: item.moderationReasonCode, adminNotes: item.adminNotes, createdAt: item.createdAt, updatedAt: item.updatedAt, price: null, priceType: null, budgetMin: Number(item.budgetMin), budgetMax: Number(item.budgetMax), urgency: item.urgency, canRemove: ["OPEN", "CLOSED"].includes(item.status) && !bookings && !payments, canRestore: item.status === "CANCELED" && item.moderationReasonCode === "ADMIN_REMOVED" && !bookings && !payments, actionBlock: bookings || payments ? "Handle the linked booking or payment in Disputes & Reports first." : null };
}

export type WorkspaceContent = NonNullable<Awaited<ReturnType<typeof readPublicContent>>>;
export function contentSnapshot(content: WorkspaceContent) {
  return { id: content.id, contentType: content.contentType, title: content.title, description: content.description, category: content.category, ownerId: content.owner.id, ownerName: content.owner.name, updatedAt: content.updatedAt.toISOString(), price: content.price, priceType: content.priceType, budgetMin: content.budgetMin, budgetMax: content.budgetMax, urgency: content.urgency };
}

export async function listWorkspaceContent(query: Query) {
  const text = query.search?.trim();
  const matches = text ? { OR: [{ title: { contains: text, mode: "insensitive" as const } }, { description: { contains: text, mode: "insensitive" as const } }] } : {};
  const serviceWhere: Prisma.ServiceWhereInput = { status: { not: "DELETED" }, ...matches };
  const requestWhere: Prisma.ServiceRequestWhereInput = { targetServiceId: null, ...matches };
  // Fetch only the prefix needed for the merged page, then apply one stable order.
  const take = query.page * query.limit;
  const [services, requests, serviceCount, requestCount] = await Promise.all([
    query.contentType === "SERVICE_REQUEST" ? [] : prisma.service.findMany({ where: serviceWhere, select: { id: true, updatedAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take }),
    query.contentType === "SERVICE_LISTING" ? [] : prisma.serviceRequest.findMany({ where: requestWhere, select: { id: true, updatedAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take }),
    query.contentType === "SERVICE_REQUEST" ? 0 : prisma.service.count({ where: serviceWhere }),
    query.contentType === "SERVICE_LISTING" ? 0 : prisma.serviceRequest.count({ where: requestWhere }),
  ]);
  const selected = [...services.map(item => ({ ...item, type: "SERVICE_LISTING" as const })), ...requests.map(item => ({ ...item, type: "SERVICE_REQUEST" as const }))].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id)).slice((query.page - 1) * query.limit, take);
  const items = (await Promise.all(selected.map(item => readPublicContent(prisma, item.type, item.id)))).filter(item => item !== null);
  const total = serviceCount + requestCount;
  return { items, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
}

export async function listWorkspaceCases(query: Query) {
  const where: Prisma.ContentModerationCaseWhereInput = { status: query.status ?? "OPEN", ...(query.contentType && { contentType: query.contentType }), ...(query.caseType && { caseType: query.caseType }) };
  const [cases, total] = await Promise.all([
    prisma.contentModerationCase.findMany({ where, include: { submitter: { select: { id: true, name: true, email: true } } }, orderBy: [{ createdAt: query.status === "RESOLVED" ? "desc" : "asc" }, { id: "asc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
    prisma.contentModerationCase.count({ where }),
  ]);
  const items = await Promise.all(cases.map(async item => {
    const content = item.resourceId ? await readPublicContent(prisma, item.contentType as PublicContentType, item.resourceId) : null;
    const saved = item.contentSnapshot as { title?: string; ownerName?: string; category?: string } | null;
    return { ...item, title: saved?.title || content?.title || "Publication check appeal", ownerName: saved?.ownerName || content?.owner.name || null, category: saved?.category || content?.category || null, currentVisibility: content?.visibility || "Content unavailable" };
  }));
  return { items, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
}

export async function getWorkspaceCase(id: string) {
  const item = await prisma.contentModerationCase.findUnique({ where: { id }, include: { submitter: { select: { id: true, name: true, email: true } } } });
  if (!item) throw fail("Content case not found.", 404);
  const content = item.resourceId ? await readPublicContent(prisma, item.contentType as PublicContentType, item.resourceId) : null;
  const ownerId = item.contentOwnerId || content?.owner.id;
  const history = ownerId ? await prisma.adminAuditLog.findMany({ where: { targetUserId: ownerId, action: { in: ["CONTENT_CASE_RESOLVED", "USER_BANNED", "USER_SUSPENDED", "CONTENT_OWNER_WARNED", "SERVICE_CONTENT_REMOVED", "REQUEST_CONTENT_REMOVED", "SERVICE_CONTENT_RESTORED", "REQUEST_CONTENT_RESTORED"] } }, select: { id: true, action: true, reason: true, createdAt: true, resourceId: true }, orderBy: { createdAt: "desc" }, take: 10 }) : [];
  const obligations = ownerId ? {
    bookings: await prisma.booking.count({ where: { OR: [{ seekerId: ownerId }, { providerId: ownerId }], status: { in: [...NONTERMINAL_BOOKING_STATUSES] } } }),
    heldPayments: await prisma.booking.count({ where: { OR: [{ seekerId: ownerId }, { providerId: ownerId }], paymentStatus: { in: ["PAID_HELD", "FROZEN_HELD"] } } }),
    pendingPayments: await prisma.paymentAttempt.count({ where: { OR: [{ seekerId: ownerId }, { providerId: ownerId }], status: { in: ["PENDING", "REFUND_REQUIRED"] } } }),
    unstartedProviderBookings: await prisma.booking.count({ where: { providerId: ownerId, started: false, status: { in: ["PENDING_APPROVAL", "WAITING", "ACCEPTED"] } } }),
  } : { bookings: 0, heldPayments: 0, pendingPayments: 0, unstartedProviderBookings: 0 };
  const allowedDecisions: string[] = item.status !== "OPEN" ? [] : !content ? ["GUIDANCE"] : item.caseType === "REPORT" ? ["KEEP", ...(content.canRemove ? ["REMOVE"] : []), ...(content.moderationReasonCode === "ADMIN_REMOVED" ? ["KEEP_REMOVED"] : [])] : [...(content.moderationReasonCode === "ADMIN_REMOVED" ? ["KEEP_REMOVED"] : []), ...(content.canRestore ? ["RESTORE"] : []), "GUIDANCE"];
  const saved = item.contentSnapshot as { title?: string; ownerName?: string; category?: string } | null;
  return { ...item, title: saved?.title || content?.title || "Publication check appeal", ownerName: saved?.ownerName || content?.owner.name || null, category: saved?.category || content?.category || null, currentVisibility: content?.visibility || "Content unavailable", content, allowedDecisions, obligations, history };
}

export async function decideWorkspaceCase(id: string, adminId: string, rawInput: ContentDecisionInput) {
  const input = ContentDecisionSchema.parse(rawInput);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`content-case-decision:${id}`}))`;
    const item = await tx.contentModerationCase.findUnique({ where: { id } });
    if (!item) throw fail("Content case not found.", 404);
    if (item.status === "RESOLVED") {
      const prior = item.decisionResult as { suspensionDays?: number } | null;
      if (item.decision === input.decision && item.penalty === input.penalty && item.resolution === input.resolution && (input.penalty !== "suspend" || prior?.suspensionDays === input.suspensionDays)) return { replay: true as const, item, effect: null, ownerId: null };
      throw fail("This case already has a different decision. Open History to review it.");
    }
    // Lock content before re-reading. This matches each content lifecycle's lock order.
    if (item.resourceId && item.contentType === "SERVICE_REQUEST") await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${item.resourceId}`}))`;
    let content = item.resourceId ? await readPublicContent(tx, item.contentType as PublicContentType, item.resourceId) : null;
    const ownerId = item.contentOwnerId || content?.owner.id;
    if (ownerId) await lockAccountLifecycle(tx, ownerId);
    if (content && item.contentType === "SERVICE_LISTING") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${ownerId}`}))`;
    }
    if (content) content = await readPublicContent(tx, item.contentType as PublicContentType, item.resourceId!);
    if (content && ownerId !== content.owner.id) throw fail("The content owner has changed. Reload the case.");
    if (!content && input.decision !== "GUIDANCE") throw fail("The original content is unavailable. Send an explanation without changing an account.");
    if (input.decision === "GUIDANCE" && input.penalty !== "none") throw fail("Guidance cannot include an account penalty.");
    if (item.caseType === "APPEAL" && (input.penalty !== "none" || input.decision === "REMOVE" || input.decision === "KEEP")) throw fail("Choose an appeal outcome without an account penalty.");
    if (item.caseType === "REPORT" && input.decision === "RESTORE") throw fail("Restoration must be reviewed through an owner's appeal or the content view.");
    if (input.decision === "KEEP_REMOVED" && content?.moderationReasonCode !== "ADMIN_REMOVED") throw fail("This content is not currently removed by an admin.");
    if (content && (["REMOVE", "RESTORE"].includes(input.decision) || input.penalty !== "none") && content.updatedAt.toISOString() !== input.expectedUpdatedAt) throw fail("The content changed while you reviewed it. Reload the case before deciding.");
    if (content && input.penalty !== "none" && content.owner.moderationStatus !== input.expectedOwnerStatus) throw fail("The owner's account status changed. Reload the case before deciding.");
    if (input.penalty !== "none") {
      if (!content || !ownerId || ownerId === adminId || content.owner.role !== "user" || !content.owner.isActive || content.owner.deactivatedAt) throw fail("This account cannot receive a penalty through this case.");
      if (input.penalty === "suspend") {
        if (content.owner.moderationStatus !== "ACTIVE") throw fail("Only an active account can be suspended.");
        const blockers = await tx.booking.count({ where: { providerId: ownerId, started: false, status: { in: ["PENDING_APPROVAL", "WAITING", "ACCEPTED"] } } });
        if (blockers) throw fail(`Handle this provider's ${blockers} unstarted booking(s) in Disputes & Reports before suspension.`);
      }
      if (input.penalty === "ban" && content.owner.moderationStatus === "BANNED") throw fail("The owner is already banned. Choose no additional penalty.");
    }
    const effect = content && ["REMOVE", "RESTORE"].includes(input.decision) ? await applyPublicContentAction(tx, item.contentType as PublicContentType, content.id, adminId, input.decision as "REMOVE" | "RESTORE", input.resolution) : null;
    if (input.penalty !== "none" && ownerId) {
      if (input.penalty === "suspend" || input.penalty === "ban") await tx.user.update({ where: { id: ownerId }, data: { moderationStatus: input.penalty === "ban" ? "BANNED" : "SUSPENDED", suspendedUntil: input.penalty === "suspend" ? new Date(Date.now() + input.suspensionDays * 86400000) : null, moderationReason: input.resolution } });
      await tx.notification.create({ data: { userId: ownerId, title: input.penalty === "warn" ? "Content warning" : input.penalty === "ban" ? "Account banned" : "Account suspended", body: `An admin reviewed a report about your content. Reason: ${input.resolution}${input.penalty === "suspend" ? ` Suspension: ${input.suspensionDays} days.` : ""}`, link: input.penalty === "ban" ? "/account-banned" : item.contentType === "SERVICE_LISTING" ? "/provider/service-manager" : "/seeker/request-manager" } });
      await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: ownerId, action: input.penalty === "warn" ? "CONTENT_OWNER_WARNED" : input.penalty === "ban" ? "USER_BANNED" : "USER_SUSPENDED", resourceType: "User", resourceId: ownerId, reason: input.resolution, metadata: { sourceContentCaseId: id, obligationsReviewRequired: input.penalty === "ban" } } });
    }
    const decisionResult = { decision: input.decision, penalty: input.penalty, contentStatus: effect ? input.decision === "REMOVE" ? item.contentType === "SERVICE_LISTING" ? "SUSPENDED" : "CANCELED" : item.contentType === "SERVICE_LISTING" ? "ACTIVE" : "OPEN" : content?.status ?? null, ownerStatus: input.penalty === "ban" ? "BANNED" : input.penalty === "suspend" ? "SUSPENDED" : content?.owner.moderationStatus ?? null, suspensionDays: input.penalty === "suspend" ? input.suspensionDays : null };
    const updated = await tx.contentModerationCase.update({ where: { id }, data: { status: "RESOLVED", adminId, resolution: input.resolution, decision: input.decision, penalty: input.penalty, decisionResult, decidedAt: new Date(), contentOwnerId: ownerId } });
    await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: ownerId ?? item.submitterId, action: "CONTENT_CASE_RESOLVED", resourceType: "ContentModerationCase", resourceId: id, reason: input.resolution, metadata: { ...decisionResult, contentResourceId: item.resourceId, submitterId: item.submitterId } } });
    await tx.notification.create({ data: { userId: item.submitterId, title: "Content Review Updated", body: `An admin reviewed your ${item.caseType === "REPORT" ? "report" : "appeal"}. ${decisionMessage(input.decision)} Explanation: ${input.resolution}`, link: "/community" } });
    return { replay: false as const, item: updated, effect, ownerId };
  });
  if (!result.replay) {
    if (result.effect) emitPublicContentAction(result.effect);
    safeEmit(`user:${result.item.submitterId}`, "notification", { title: "Content Review Updated" });
    if (result.ownerId && input.penalty !== "none") {
      safeEmit(`user:${result.ownerId}`, "notification", { title: "Account review updated" });
      if (input.penalty === "ban") await disconnectUserSockets(result.ownerId, "Your account has been banned by an admin.", "ACCOUNT_BANNED");
      if (input.penalty === "suspend") safeEmit(`user:${result.ownerId}`, "accountStatusChanged", { status: "SUSPENDED" });
      safeBroadcast("SERVICE_LISTINGS_CHANGED", { ownerId: result.ownerId });
      safeBroadcast("SERVICE_REQUESTS_CHANGED", { ownerId: result.ownerId });
    }
    safeEmit("admin", "CONTENT_CASES_CHANGED", { id });
  }
  return result.item;
}

function decisionMessage(decision: string) {
  return ({ KEEP: "The report was dismissed; the content was kept.", REMOVE: "The content was removed.", RESTORE: "The content was restored.", KEEP_REMOVED: "The content remains removed.", GUIDANCE: "The admin sent guidance; no content or account was changed." } as Record<string, string>)[decision];
}

export async function changeWorkspaceContent(type: PublicContentType, id: string, adminId: string, input: { action: "REMOVE" | "RESTORE"; reason: string; expectedUpdatedAt: string }) {
  const result = await prisma.$transaction(async tx => {
    if (type === "SERVICE_REQUEST") await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${id}`}))`;
    let content = await readPublicContent(tx, type, id);
    if (!content) throw fail("Content not found.", 404);
    await lockAccountLifecycle(tx, content.owner.id);
    if (type === "SERVICE_LISTING") await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${content.owner.id}`}))`;
    content = await readPublicContent(tx, type, id);
    if (!content || content.updatedAt.toISOString() !== input.expectedUpdatedAt) throw fail("The content changed. Reload it before taking action.");
    return applyPublicContentAction(tx, type, id, adminId, input.action, input.reason);
  });
  emitPublicContentAction(result);
  return readPublicContent(prisma, type, id);
}

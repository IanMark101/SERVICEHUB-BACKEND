import type { Prisma } from "@prisma/client";
import { safeBroadcast, safeEmit } from "../lib/socket";
import { lockAccountLifecycle, assertActiveMarketplaceAccount } from "./account-lifecycle.service";
import { assessMarketplaceContent } from "./content-moderation.service";

export type PublicContentType = "SERVICE_LISTING" | "SERVICE_REQUEST";
export type PublicContentAction = "REMOVE" | "RESTORE";
const fail = (message: string) => Object.assign(new Error(message), { status: 409 });

export async function applyPublicContentAction(tx: Prisma.TransactionClient, type: PublicContentType, id: string, adminId: string, action: PublicContentAction, reason: string) {
  let affectedProviders: string[] = [];
  let ownerId: string;
  if (type === "SERVICE_LISTING") {
    const first = await tx.service.findUnique({ where: { id }, select: { providerId: true } });
    if (!first) throw fail("This service listing no longer exists.");
    ownerId = first.providerId;
    await lockAccountLifecycle(tx, ownerId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${ownerId}`}))`;
    const content = await tx.service.findUniqueOrThrow({ where: { id }, include: { category: true, provider: true } });
    if (action === "REMOVE") {
      if (!["ACTIVE", "INACTIVE"].includes(content.status)) throw fail("Only a published or paused service can be removed.");
      await tx.service.update({ where: { id }, data: { status: "SUSPENDED", isAvailable: false, moderationReasonCode: "ADMIN_REMOVED", adminNotes: reason, reviewedById: adminId, reviewedAt: new Date() } });
    } else {
      if (content.status !== "SUSPENDED" || content.moderationReasonCode !== "ADMIN_REMOVED") throw fail("Only a service removed by an admin can be restored.");
      await assertRestorable(tx, ownerId, content.category.isActive);
      const check = assessMarketplaceContent({ kind: type, categoryName: content.category.name, title: content.title, description: content.description });
      if (check.outcome !== "PASS") throw fail(`This listing does not meet the current posting rules. Send guidance asking the provider to post a corrected listing. ${check.message}`);
      if (!["FIXED", "PER_HOUR", "PER_DAY", "PER_PROJECT"].includes(content.priceType) || content.price === null || Number(content.price) < 50 || Number(content.price) > 50000) throw fail("This older listing needs a supported price. Send guidance asking the provider to post a corrected listing.");
      if (await tx.service.count({ where: { providerId: ownerId, status: "ACTIVE" } }) >= 3) throw fail("The provider must pause a service before this one can be restored.");
      if (await tx.service.count({ where: { id: { not: id }, providerId: ownerId, status: "ACTIVE", titleNormalized: content.titleNormalized } })) throw fail("The provider already has an active listing with this title. Keep this one removed or ask them to pause the duplicate.");
      await tx.service.update({ where: { id }, data: { status: "ACTIVE", isAvailable: true, moderationReasonCode: "ADMIN_RESTORED", adminNotes: reason, reviewedById: adminId, reviewedAt: new Date(), publishedAt: content.publishedAt ?? new Date() } });
    }
  } else {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${id}`}))`;
    const content = await tx.serviceRequest.findUnique({ where: { id }, include: { category: true } });
    if (!content) throw fail("This service request no longer exists.");
    ownerId = content.seekerId;
    await lockAccountLifecycle(tx, ownerId);
    if (content.targetServiceId) throw fail("A private booking inquiry must be handled through its booking flow.");
    const offers = await tx.offer.findMany({ where: { requestId: id }, select: { id: true, providerId: true, status: true } });
    const offerIds = offers.map(offer => offer.id);
    const matched = await tx.booking.count({ where: { offerId: { in: offerIds }, status: { notIn: ["DECLINED", "CANCELED", "REMOVED"] } } });
    const payments = await tx.paymentAttempt.count({ where: { offerId: { in: offerIds }, status: { in: ["PENDING", "SUCCEEDED", "REFUND_REQUIRED"] } } });
    if (matched || payments) throw fail("This request has a booking or payment that needs handling in Disputes & Reports first.");
    if (action === "REMOVE") {
      if (content.status !== "OPEN" && content.status !== "CLOSED") throw fail("Only an open or paused public request can be removed.");
      await tx.serviceRequest.update({ where: { id }, data: { status: "CANCELED", moderationReasonCode: "ADMIN_REMOVED", adminNotes: reason, reviewedById: adminId, reviewedAt: new Date() } });
      await tx.offer.updateMany({ where: { requestId: id, status: "PENDING" }, data: { status: "REJECTED" } });
      affectedProviders = [...new Set(offers.filter(offer => offer.status === "PENDING").map(offer => offer.providerId))];
      if (affectedProviders.length) await tx.notification.createMany({ data: affectedProviders.map(userId => ({ userId, title: "Offer closed", body: "An admin removed the request you responded to. Your pending offer has been closed.", link: "/provider/browse-services" })) });
    } else {
      if (content.status !== "CANCELED" || content.moderationReasonCode !== "ADMIN_REMOVED") throw fail("Only a request removed by an admin can be restored.");
      await assertRestorable(tx, ownerId, content.category.isActive);
      const check = assessMarketplaceContent({ kind: type, categoryName: content.category.name, title: content.title, description: content.description });
      if (check.outcome !== "PASS") throw fail(`This request does not meet the current posting rules. Send guidance asking the seeker to post a corrected request. ${check.message}`);
      const duplicates = await tx.serviceRequest.findMany({ where: { id: { not: id }, seekerId: ownerId, categoryId: content.categoryId, status: { in: ["OPEN", "PAYMENT_PENDING", "IN_PROGRESS"] } }, select: { title: true } });
      const normalized = (title: string) => title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
      if (duplicates.some(item => normalized(item.title) === normalized(content.title))) throw fail("The seeker already has an active request with this title and category.");
      await tx.serviceRequest.update({ where: { id }, data: { status: "OPEN", moderationReasonCode: "ADMIN_RESTORED", adminNotes: reason, reviewedById: adminId, reviewedAt: new Date() } });
      // Closed offers stay closed. Restoration invites fresh offers.
    }
  }
  const noun = type === "SERVICE_LISTING" ? "Listing" : "Request";
  await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: ownerId, action: `${type === "SERVICE_LISTING" ? "SERVICE" : "REQUEST"}_CONTENT_${action === "REMOVE" ? "REMOVED" : "RESTORED"}`, resourceType: type === "SERVICE_LISTING" ? "Service" : "ServiceRequest", resourceId: id, reason } });
  await tx.notification.create({ data: { userId: ownerId, title: `${noun} ${action === "REMOVE" ? "Removed from" : "Restored to"} Marketplace`, body: action === "REMOVE" ? `Your ${noun.toLowerCase()} was removed from public view. Reason: ${reason}` : `Your ${noun.toLowerCase()} is available again. Reason: ${reason}`, link: type === "SERVICE_LISTING" ? `/provider/service-manager?id=${id}` : action === "REMOVE" ? `/seeker/post-request?appealRequestId=${id}` : "/seeker/request-manager" } });
  return { type, id, ownerId, action, affectedProviders };
}

async function assertRestorable(tx: Prisma.TransactionClient, ownerId: string, categoryActive: boolean) {
  await assertActiveMarketplaceAccount(tx, ownerId);
  const owner = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { emailVerified: true, verificationStatus: true, postingSuspended: true } });
  if (!categoryActive || !owner.emailVerified || owner.verificationStatus !== "APPROVED" || owner.postingSuspended) throw fail("The owner must have a verified account and the category must be available before restoration.");
}

export function emitPublicContentAction(result: Awaited<ReturnType<typeof applyPublicContentAction>>) {
  safeEmit(`user:${result.ownerId}`, "notification", { title: "Content updated" });
  result.affectedProviders.forEach(id => safeEmit(`user:${id}`, "notification", { title: "Offer closed" }));
  safeBroadcast(result.type === "SERVICE_LISTING" ? "SERVICE_LISTINGS_CHANGED" : "SERVICE_REQUESTS_CHANGED", { id: result.id });
  if (result.type === "SERVICE_REQUEST") {
    if (result.action === "REMOVE") safeBroadcast("SERVICE_REQUEST_DELETED", { id: result.id });
    safeBroadcast("OFFERS_CHANGED", { requestId: result.id });
  }
}

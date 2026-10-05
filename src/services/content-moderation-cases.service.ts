import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import { PUBLIC_SERVICE_WHERE } from "./services.service";
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from "./account-lifecycle.service";
import { readPublicContent, contentSnapshot, decideWorkspaceCase } from "./content-workspace.service";

export type ContentCaseInput = {
  caseType: "REPORT" | "APPEAL";
  contentType: "SERVICE_LISTING" | "SERVICE_REQUEST";
  resourceId?: string;
  reason: string;
};

export async function submitContentCase(submitterId: string, input: ContentCaseInput) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`content-case:${submitterId}`}))`;
    if (input.caseType === "REPORT") {
      if (!input.resourceId) throw Object.assign(new Error("Choose public content to report"), { status: 400 });
      if (input.contentType === "SERVICE_LISTING") {
        const listing = await tx.service.findFirst({ where: { id: input.resourceId, ...PUBLIC_SERVICE_WHERE }, select: { providerId: true } });
        if (!listing) throw Object.assign(new Error("This listing is no longer public"), { status: 404 });
        if (listing.providerId === submitterId) throw Object.assign(new Error("You cannot report your own listing"), { status: 409 });
        await lockAccountLifecycle(tx, submitterId, listing.providerId);
        await assertActiveMarketplaceAccount(tx, submitterId);
        await assertActiveMarketplaceAccount(tx, listing.providerId);
      } else {
        const request = await tx.serviceRequest.findFirst({
          where: {
            id: input.resourceId, status: "OPEN",
            seeker: { isActive: true, moderationStatus: "ACTIVE", emailVerified: true, verificationStatus: "APPROVED" },
          },
          select: { seekerId: true },
        });
          if (!request) throw Object.assign(new Error("This request is no longer public"), { status: 404 });
        if (request.seekerId === submitterId) throw Object.assign(new Error("You cannot report your own request"), { status: 409 });
        await lockAccountLifecycle(tx, submitterId, request.seekerId);
        await assertActiveMarketplaceAccount(tx, submitterId);
        await assertActiveMarketplaceAccount(tx, request.seekerId);
      }
    } else if (input.resourceId) {
      await lockAccountLifecycle(tx, submitterId);
      await assertActiveMarketplaceAccount(tx, submitterId);
      const owned = input.contentType === "SERVICE_LISTING"
        ? await tx.service.findFirst({ where: { id: input.resourceId, providerId: submitterId, status: { in: ["REJECTED", "SUSPENDED"] } }, select: { id: true } })
        : await tx.serviceRequest.findFirst({ where: { id: input.resourceId, seekerId: submitterId, status: "CANCELED", moderationReasonCode: "ADMIN_REMOVED" }, select: { id: true } });
      if (!owned) throw Object.assign(new Error("Only your removed or rejected content can be appealed here"), { status: 409 });
    } else {
      await lockAccountLifecycle(tx, submitterId);
      await assertActiveMarketplaceAccount(tx, submitterId);
      const recentFailure = await tx.contentModerationEvent.findFirst({ where: {
        actorId: submitterId, contentType: input.contentType, outcome: "REVISE",
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }, select: { id: true } });
      if (!recentFailure) throw Object.assign(new Error("No recent content check to appeal. Please revise and submit first."), { status: 409 });
    }
    const existing = await tx.contentModerationCase.findFirst({ where: {
      submitterId, caseType: input.caseType, contentType: input.contentType,
      resourceId: input.resourceId ?? null, status: "OPEN",
    }, select: { id: true } });
    if (existing) throw Object.assign(new Error("You already have an open review for this content"), { status: 409 });
    const content = input.resourceId ? await readPublicContent(tx, input.contentType, input.resourceId) : null;
    if (input.caseType === "REPORT" && (!content || content.visibility !== "Public")) throw Object.assign(new Error("This content is no longer public."), { status: 409 });
    const submitted = await tx.contentModerationCase.create({ data: {
      submitterId, caseType: input.caseType, contentType: input.contentType,
      resourceId: input.resourceId ?? null, reason: input.reason.trim(),
      contentOwnerId: content?.owner.id ?? (input.caseType === "APPEAL" ? submitterId : null),
      ...(content && { contentSnapshot: contentSnapshot(content) }),
    } });
    const admins = await tx.user.findMany({ where: { role: "admin", isActive: true, moderationStatus: "ACTIVE" }, select: { id: true } });
    if (admins.length) await tx.notification.createMany({ data: admins.map((admin) => ({
      userId: admin.id, title: input.caseType === "REPORT" ? "Public Content Report" : "Content Appeal",
      body: "A report or appeal needs your review.", link: `/admin/content-cases?caseId=${submitted.id}`,
    })) });
    return { submitted, adminIds: admins.map((admin) => admin.id) };
  });
  result.adminIds.forEach((id) => safeEmit(`user:${id}`, "notification", { title: "Content Case Needs Review", link: `/admin/content-cases?caseId=${result.submitted.id}` }));
  safeEmit("admin", "CONTENT_CASES_CHANGED", { id: result.submitted.id });
  return result.submitted;
}

export async function listMyContentCases(submitterId: string) {
  return prisma.contentModerationCase.findMany({ where: { submitterId }, orderBy: { createdAt: "desc" }, take: 50 });
}

export async function listAdminContentCases(page: number, limit: number, status: "OPEN" | "RESOLVED") {
  const where = { status };
  const [items, total] = await Promise.all([
    prisma.contentModerationCase.findMany({ where, include: { submitter: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" }, skip: (page - 1) * limit, take: limit }),
    prisma.contentModerationCase.count({ where }),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// Compatibility for internal callers that explicitly record a no-action decision.
export async function resolveContentCase(caseId: string, adminId: string, resolution: string) {
  const item = await prisma.contentModerationCase.findUniqueOrThrow({ where: { id: caseId } });
  return decideWorkspaceCase(caseId, adminId, { decision: item.caseType === "REPORT" ? "KEEP" : "GUIDANCE", penalty: "none", resolution, suspensionDays: 7 });
}

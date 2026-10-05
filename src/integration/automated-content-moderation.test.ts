import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { CreateServiceSchema } from "../schema/services.schema";
import { browseServices, createService, getServiceById, updateService, toggleServiceAvailability } from "../services/services.service";
import { createRequest, listRequests, updateRequest } from "../services/requests.service";
import { removePublishedService, restoreRemovedService } from "../services/admin-moderation.service";
import { listAdminPublicRequests, removePublicRequest } from "../services/admin-request-moderation.service";
import { listAdminContentCases, resolveContentCase, submitContentCase } from "../services/content-moderation-cases.service";

test("direct publication, revision-only failures, legacy recovery and post-publication moderation", async (t) => {
  const suffix = randomUUID();
  const provider = await prisma.user.create({ data: {
    name: "Moderation Provider", email: `moderation-provider-${suffix}@example.test`, passwordHash: "test-only",
    phone: `p-${suffix}`, location: "Cordova", emailVerified: true, verificationStatus: "APPROVED",
  } });
  const seeker = await prisma.user.create({ data: {
    name: "Moderation Seeker", email: `moderation-seeker-${suffix}@example.test`, passwordHash: "test-only",
    phone: `s-${suffix}`, location: "Cordova", emailVerified: true, verificationStatus: "APPROVED",
  } });
  const admin = await prisma.user.create({ data: {
    name: "Moderation Admin", email: `moderation-admin-${suffix}@example.test`, passwordHash: "test-only",
    phone: `a-${suffix}`, location: "Cordova", role: "admin", emailVerified: true,
  } });
  const category = await prisma.category.create({ data: { name: `Moderation fixture ${suffix}` } });
  const actorIds = [provider.id, seeker.id, admin.id];
  t.after(async () => {
    await prisma.contentModerationCase.deleteMany({ where: { submitterId: { in: actorIds } } });
    await prisma.contentModerationEvent.deleteMany({ where: { actorId: { in: actorIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: admin.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: actorIds } } });
    await prisma.serviceRequest.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.service.deleteMany({ where: { providerId: provider.id } });
    await prisma.user.deleteMany({ where: { id: { in: actorIds } } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.$disconnect();
  });

  const listingInput = (title: string, description = "Careful local repair work with clear scheduling and pricing.") =>
    CreateServiceSchema.parse({ categoryId: category.id, title, description, price: 500,
      estimatedDurationMins: 60, queueLimit: 3, paymentMethods: { cash: true, gcash: false } });
  const clean = await createService(provider.id, listingInput(`Careful local repair ${suffix}`));
  assert.equal(clean.status, "ACTIVE");
  assert.equal(clean.isAvailable, true);
  assert.ok(clean.publishedAt);
  assert.equal(clean.reviewedAt, null, "automatic publication is not an Admin approval");
  assert.equal((await browseServices({})).some((item) => item.id === clean.id), true);
  assert.equal((await getServiceById(clean.id)).id, clean.id);

  const trustBefore = (await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).trustScore;
  await assert.rejects(createService(provider.id, listingInput(`Bad local service ${suffix}`, "I will sell illegal drugs as a paid service.")),
    (error: any) => error?.status === 422);
  assert.equal(await prisma.service.count({ where: { providerId: provider.id } }), 1);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).trustScore, trustBefore);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).postingSuspended, false);
  await assert.rejects(createService(provider.id, listingInput(`niggernigger repair ${suffix}`)),
    (error: any) => error?.status === 422 && error?.code === "CONTENT_REVISION_REQUIRED" && error?.field === "title");
  assert.equal(await prisma.service.count({ where: { providerId: provider.id } }), 1);

  await assert.rejects(createService(provider.id, listingInput(`Unsupported service ${suffix}`, "I can provide a private security service to local clients.")),
    (error: any) => error?.status === 422 && error?.code === "CONTENT_REVISION_REQUIRED");
  assert.equal(await prisma.service.count({ where: { providerId: provider.id } }), 1);
  assert.equal(await prisma.service.count({ where: { providerId: provider.id, status: "PENDING_REVIEW" } }), 0);
  assert.equal(await prisma.notification.count({ where: { userId: admin.id, title: { in: ["New Service Listing Pending Review", "Service Listing Changes Pending Review"] } } }), 0);
  const published = await createService(provider.id, listingInput(`Corrected local repair ${suffix}`));
  assert.equal(published.status, "ACTIVE");
  assert.equal(published.reviewedAt, null);

  await assert.rejects(updateService(clean.id, provider.id, { description: "I will sell illegal drugs as a paid service." }),
    (error: any) => error?.status === 422);
  const unchanged = await prisma.service.findUniqueOrThrow({ where: { id: clean.id } });
  assert.equal(unchanged.description, clean.description);
  assert.equal(unchanged.status, "ACTIVE");
  const firstPublishedAt = unchanged.publishedAt?.getTime();
  const edited = await updateService(clean.id, provider.id, { description: "Careful local repair with clearer information about pricing." });
  assert.equal(edited.status, "ACTIVE");
  assert.equal(edited.publishedAt?.getTime(), firstPublishedAt);

  const requestInput = (title: string, description = "The kitchen faucet needs careful repair this week.") => ({
    categoryId: category.id, title, description, budgetMin: 500, budgetMax: 500, urgency: "Flexible Schedule",
  });
  const request = await createRequest(seeker.id, requestInput(`Repair kitchen faucet ${suffix}`));
  assert.equal(request.status, "OPEN");
  assert.equal((await listRequests()).some((item) => item.id === request.id), true);
  await assert.rejects(createRequest(seeker.id, requestInput(`  REPAIR   KITCHEN  FAUCET ${suffix.toUpperCase()}  `)),
    (error: any) => error?.code === "DUPLICATE_REQUEST");
  await assert.rejects(createRequest(seeker.id, requestInput(`Unsafe request ${suffix}`, "Please sell illegal drugs as part of this task.")),
    (error: any) => error?.status === 422);
  assert.equal(await prisma.serviceRequest.count({ where: { seekerId: seeker.id } }), 1);
  await assert.rejects(createRequest(seeker.id, requestInput(`nigger repair ${suffix}`)),
    (error: any) => error?.status === 422 && error?.code === "CONTENT_REVISION_REQUIRED" && error?.field === "title");
  assert.equal(await prisma.serviceRequest.count({ where: { seekerId: seeker.id } }), 1);
  await assert.rejects(updateRequest(request.id, seeker.id, { description: "Please sell illegal drugs as part of this task." }),
    (error: any) => error?.status === 422);
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).description, request.description);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: seeker.id } })).postingSuspended, false);

  const listingReport = await submitContentCase(seeker.id, {
    caseType: "REPORT", contentType: "SERVICE_LISTING", resourceId: clean.id,
    reason: "Please inspect this public listing for a policy concern.",
  });
  await assert.rejects(submitContentCase(provider.id, {
    caseType: "REPORT", contentType: "SERVICE_LISTING", resourceId: clean.id,
    reason: "I am trying to report my own listing.",
  }), (error: any) => error?.status === 409);
  const requestReport = await submitContentCase(provider.id, {
    caseType: "REPORT", contentType: "SERVICE_REQUEST", resourceId: request.id,
    reason: "Please inspect this public request for a policy concern.",
  });
  const appeal = await submitContentCase(seeker.id, {
    caseType: "APPEAL", contentType: "SERVICE_REQUEST",
    reason: "My earlier request was blocked and I would like a human review.",
  });
  const fixtureCaseIds = [listingReport.id, requestReport.id, appeal.id];
  assert.equal((await listAdminContentCases(1, 100, "OPEN")).items.filter((item) => fixtureCaseIds.includes(item.id)).length, 3);
  await resolveContentCase(listingReport.id, admin.id, "Reviewed the report; keep the listing public for now.");
  assert.equal((await listAdminContentCases(1, 10, "RESOLVED")).items.some((item) => item.id === listingReport.id), true);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: clean.id } })).status, "ACTIVE");
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, "OPEN");
  assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: listingReport.id, action: "CONTENT_CASE_RESOLVED" } }), 1);
  assert.ok(requestReport.id && appeal.id);

  await removePublishedService(published.id, admin.id, "Service rules violation after a report");
  assert.equal((await browseServices({})).some((item) => item.id === published.id), false);
  assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: published.id, action: "SERVICE_CONTENT_REMOVED" } }), 1);
  await prisma.category.update({ where: { id: category.id }, data: { isActive: false } });
  await assert.rejects(restoreRemovedService(published.id, admin.id, "Review the removal"), (error: any) => error?.status === 409);
  await prisma.category.update({ where: { id: category.id }, data: { isActive: true } });
  await restoreRemovedService(published.id, admin.id, "Reviewed the removal appeal and restored the service");
  assert.equal((await browseServices({})).some((item) => item.id === published.id), true);
  assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: published.id, action: "SERVICE_CONTENT_RESTORED" } }), 1);

  await toggleServiceAvailability(clean.id, provider.id);
  const pausedEdit = await updateService(clean.id, provider.id, { description: "Clear repair details updated while the provider takes a break." });
  assert.equal(pausedEdit.status, "INACTIVE");
  assert.equal(pausedEdit.isAvailable, false);
  assert.equal(pausedEdit.publishedAt?.getTime(), firstPublishedAt);
  await toggleServiceAvailability(clean.id, provider.id);
  const legacy = await prisma.service.create({ data: { ...listingInput(`Older unpublished repair ${suffix}`), titleNormalized: `older unpublished repair ${suffix}`, providerId: provider.id, status: "PENDING_REVIEW", isAvailable: false } });
  const republished = await updateService(legacy.id, provider.id, {});
  assert.equal(republished.status, "ACTIVE");
  assert.equal(republished.isAvailable, true);
  assert.ok(republished.publishedAt);
  assert.equal(republished.reviewedAt, null);
  assert.equal(await prisma.service.count({ where: { providerId: provider.id, status: "PENDING_REVIEW" } }), 0);
  assert.equal(await prisma.notification.count({ where: { userId: admin.id, title: { in: ["New Service Listing Pending Review", "Service Listing Changes Pending Review"] } } }), 0);

  assert.equal((await listAdminPublicRequests(1, 10)).items.some((item) => item.id === request.id), true);
  await removePublicRequest(request.id, admin.id, "Public content policy violation");
  assert.equal((await listRequests()).some((item) => item.id === request.id), false);
  assert.equal((await prisma.notification.findFirstOrThrow({ where: { userId: seeker.id, title: "Request Removed from Marketplace" } })).link,
    `/seeker/post-request?appealRequestId=${request.id}`);
  const removalAppeal = await submitContentCase(seeker.id, {
    caseType: "APPEAL", contentType: "SERVICE_REQUEST", resourceId: request.id,
    reason: "Please review why my request was removed from the marketplace.",
  });
  assert.equal(removalAppeal.status, "OPEN");
  assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: request.id, action: "REQUEST_CONTENT_REMOVED" } }), 1);
  assert.equal(await prisma.contentModerationEvent.count({ where: { actorId: { in: [provider.id, seeker.id] } } }) >= 7, true);
});

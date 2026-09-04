import { prisma } from "../lib/prisma";
import { safeBroadcast, safeEmit } from "../lib/socket";
import { settleCompletedBooking } from "./bookings/completion.service";

const WAIT_MS = 72 * 60 * 60 * 1000;
const RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function httpError(message: string, status: number, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

export async function createCompletionEscalation(bookingId: string, providerId: string, reason: string) {
  const escalation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`completion-escalation:${bookingId}`}))`;
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.providerId !== providerId) throw httpError("Booking not found or access denied", 404);
    if (booking.status !== "AWAITING_CONFIRMATION") throw httpError("Only a booking awaiting seeker confirmation can be escalated", 409);
    if (booking.updatedAt.getTime() + WAIT_MS > Date.now()) throw httpError("Completion can be escalated after 72 hours without a seeker response", 409, "ESCALATION_WAIT_PERIOD");

    const previous = await tx.completionEscalation.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } });
    if (previous?.status === "PENDING") throw httpError("A completion escalation is already pending", 409, "DUPLICATE_ESCALATION");
    if (previous?.resolvedAt && previous.resolvedAt.getTime() + RETRY_COOLDOWN_MS > Date.now()) {
      throw httpError("Wait 24 hours before submitting another completion escalation", 409, "ESCALATION_COOLDOWN");
    }
    const created = await tx.completionEscalation.create({ data: { bookingId, requestedBy: providerId, reason } });
    return { created, seekerId: booking.seekerId };
  });
  safeEmit("admin", "ADMIN_MODERATION_CHANGED", { type: "completion_escalation", bookingId });
  return escalation.created;
}

export async function listCompletionEscalations(page = 1, limit = 20) {
  const [items, total] = await Promise.all([
    prisma.completionEscalation.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, skip: (page - 1) * limit, take: limit }),
    prisma.completionEscalation.count({ where: { status: "PENDING" } }),
  ]);
  const bookingIds = items.map((item) => item.bookingId);
  const bookings = await prisma.booking.findMany({
    where: { id: { in: bookingIds } },
    include: { seeker: { select: { id: true, name: true } }, provider: { select: { id: true, name: true } }, service: { select: { title: true } }, messages: { orderBy: { createdAt: "asc" }, take: 100 } },
  });
  const byId = new Map(bookings.map((booking) => [booking.id, booking]));
  return { items: items.map((item) => ({ ...item, booking: byId.get(item.bookingId) || null })), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function resolveCompletionEscalation(params: {
  escalationId: string;
  adminId: string;
  action: "release_provider_and_complete" | "dismiss";
  resolution: string;
}) {
  const escalation = await prisma.completionEscalation.findUnique({ where: { id: params.escalationId } });
  if (!escalation) throw httpError("Completion escalation not found", 404);
  if (escalation.status !== "PENDING") throw httpError("Completion escalation has already been resolved", 409);

  const reviewClaim = await prisma.completionEscalation.updateMany({
    where: { id: escalation.id, status: "PENDING" },
    data: { status: "UNDER_REVIEW", adminId: params.adminId, resolution: params.resolution },
  });
  if (reviewClaim.count !== 1) throw httpError("Completion escalation is already being resolved", 409);

  try {
    if (params.action === "release_provider_and_complete") {
      await settleCompletedBooking(escalation.bookingId, { type: "ADMIN", userId: params.adminId });
    }
  } catch (cause) {
    await prisma.completionEscalation.updateMany({
      where: { id: escalation.id, status: "UNDER_REVIEW", adminId: params.adminId },
      data: { status: "PENDING", adminId: null, resolution: null },
    });
    throw cause;
  }
  const claimed = await prisma.$transaction(async (tx) => {
    const update = await tx.completionEscalation.updateMany({
      where: { id: escalation.id, status: "UNDER_REVIEW", adminId: params.adminId },
      data: { status: params.action === "dismiss" ? "DISMISSED" : "RESOLVED", adminId: params.adminId, resolution: params.resolution, resolvedAt: new Date() },
    });
    if (update.count !== 1) throw httpError("Completion escalation has already been resolved", 409);
    await tx.adminAuditLog.create({
      data: { actorId: params.adminId, targetUserId: escalation.requestedBy, action: `COMPLETION_ESCALATION_${params.action.toUpperCase()}`, resourceType: "CompletionEscalation", resourceId: escalation.id, reason: params.resolution, metadata: { bookingId: escalation.bookingId } },
    });
    return update;
  });
  safeBroadcast("ADMIN_MODERATION_CHANGED", { type: "completion_escalation_resolved", bookingId: escalation.bookingId });
  return claimed;
}

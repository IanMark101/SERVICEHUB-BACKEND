import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";

export type WaitlistNotification = {
  seekerId: string;
  title: string;
};

export async function lockProviderQueue(
  tx: Prisma.TransactionClient,
  providerId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-queue:${providerId}`}))`;
}

/**
 * Reindexes a provider's active paid FCFS queue while the caller's transaction
 * owns the provider advisory lock. Keeping this inside the lifecycle mutation
 * prevents another payment, start, completion, or cancellation from observing
 * a partially shifted queue.
 */
export async function recalculateQueueInTransaction(
  tx: Prisma.TransactionClient,
  providerId: string,
): Promise<void> {
  await lockProviderQueue(tx, providerId);

  // Queue occupancy belongs to Queue, not Booking. A safety report can freeze
  // an in-progress booking as DISPUTED while its provider is still SERVING.
  const serving = await tx.queue.findFirst({
    where: { providerId, status: "SERVING" },
    include: { booking: { select: { estimatedDurationMins: true } } },
  });
  const cashInProgress = serving ? null : await tx.booking.findFirst({
    where: { providerId, paymentMethod: "On-site Cash", started: true, status: { in: ["ONGOING", "DISPUTED", "UNDER_REVIEW"] } },
    select: { estimatedDurationMins: true },
  });
  const waitingEntries = await tx.queue.findMany({
    where: { providerId, status: "WAITING" },
    orderBy: [{ position: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
    include: { booking: { select: { id: true, estimatedDurationMins: true } } },
  });

  let estimatedWait = serving?.booking?.estimatedDurationMins ?? cashInProgress?.estimatedDurationMins ?? 0;
  if (serving && (serving.position !== 1 || serving.estimatedWait !== 0)) {
    await tx.queue.update({ where: { id: serving.id }, data: { position: 1, estimatedWait: 0 } });
  }
  // Queue positions only compress downward under the provider-scoped unique index.
  for (let index = 0; index < waitingEntries.length; index += 1) {
    const entry = waitingEntries[index];
    const position = (serving ? 2 : 1) + index;

    if (entry.position !== position || entry.estimatedWait !== estimatedWait) {
      await tx.queue.update({ where: { id: entry.id }, data: { position, estimatedWait } });
    }
    if (entry.booking) {
      await tx.booking.updateMany({
        where: { id: entry.booking.id, queuePosition: { not: position } },
        data: { queuePosition: position },
      });
    }
    estimatedWait += entry.booking?.estimatedDurationMins ?? 60;
  }
}

/**
 * Atomically consumes the first QueueNotify row and creates its durable
 * notification. The socket event is intentionally emitted only after commit.
 */
export async function notifyWaitlistInTransaction(
  tx: Prisma.TransactionClient,
  providerId: string,
): Promise<WaitlistNotification | null> {
  await lockProviderQueue(tx, providerId);

  const provider = await tx.user.findUnique({
    where: { id: providerId },
    select: { onlineQueueLimit: true },
  });
  if (!provider) return null;

  const waitingCount = await tx.queue.count({
    where: { providerId, status: "WAITING" },
  });
  if (waitingCount >= provider.onlineQueueLimit) return null;

  const firstWaiting = await tx.queueNotify.findFirst({
    where: { service: { providerId } },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: { id: true, seekerId: true, serviceId: true },
  });
  if (!firstWaiting) return null;

  const title = "Queue slot available";
  await tx.notification.create({
    data: {
      userId: firstWaiting.seekerId,
      title,
      body: "A place opened in this provider's paid work queue. Book while space remains.",
      link: `/seeker/seek-services?service=${firstWaiting.serviceId}`,
    },
  });
  await tx.queueNotify.delete({ where: { id: firstWaiting.id } });
  return { seekerId: firstWaiting.seekerId, title };
}

export function emitWaitlistNotification(notification: WaitlistNotification | null): void {
  if (!notification) return;
  safeEmit(`user:${notification.seekerId}`, "notification", { title: notification.title });
}

/** Refresh every affected participant after a committed provider-wide reorder. */
export async function emitProviderQueueUpdates(providerId: string): Promise<void> {
  const [waiting, services] = await Promise.all([
    prisma.queue.findMany({ where: { providerId, status: "WAITING" }, select: { seekerId: true } }),
    prisma.service.findMany({ where: { providerId, status: "ACTIVE", isAvailable: true }, select: { id: true } }),
  ]);
  safeEmit(`user:${providerId}`, "ENGAGEMENT_CHANGED", { type: "provider_queue_changed" });
  for (const seekerId of new Set(waiting.map((row) => row.seekerId))) {
    safeEmit(`user:${seekerId}`, "ENGAGEMENT_CHANGED", { type: "provider_queue_changed" });
  }
  for (const service of services) {
    safeEmit(`service:${service.id}`, "queue_update", { serviceId: service.id, currentSize: waiting.length, delta: 0 });
  }
}

export async function recalculateQueue(providerId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await recalculateQueueInTransaction(tx, providerId);
  });
  await emitProviderQueueUpdates(providerId);
}

export async function notifyWaitlist(providerId: string): Promise<void> {
  const notification = await prisma.$transaction(async (tx) =>
    notifyWaitlistInTransaction(tx, providerId),
  );
  emitWaitlistNotification(notification);
}

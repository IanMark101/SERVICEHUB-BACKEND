import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";

export type WaitlistNotification = {
  seekerId: string;
  title: string;
};

export async function lockServiceQueue(
  tx: Prisma.TransactionClient,
  serviceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`service:${serviceId}`}))`;
}

/**
 * Reindexes one listing's active FCFS queue while the caller's transaction
 * owns the listing advisory lock. Keeping this inside the lifecycle mutation
 * prevents another payment, start, completion, or cancellation from observing
 * a partially shifted queue.
 */
export async function recalculateQueueInTransaction(
  tx: Prisma.TransactionClient,
  serviceId: string,
): Promise<void> {
  await lockServiceQueue(tx, serviceId);

  const service = await tx.service.findUnique({
    where: { id: serviceId },
    select: { estimatedDurationMins: true },
  });
  if (!service) return;

  const activeOngoingCount = await tx.booking.count({
    where: { serviceId, status: "ONGOING" },
  });
  const waitingEntries = await tx.queue.findMany({
    where: { serviceId, status: "WAITING" },
    orderBy: [{ position: "asc" }, { joinedAt: "asc" }, { id: "asc" }],
    select: { id: true, bookingId: true },
  });

  // Queue positions only compress downward, so updating in ascending order
  // keeps every destination free under the partial unique database index.
  for (let index = 0; index < waitingEntries.length; index += 1) {
    const entry = waitingEntries[index];
    const position = activeOngoingCount + index + 1;
    const estimatedWait = service.estimatedDurationMins * (position - 1);

    await tx.queue.update({
      where: { id: entry.id },
      data: { position, estimatedWait },
    });
    if (entry.bookingId) {
      await tx.booking.updateMany({
        where: { id: entry.bookingId },
        data: { queuePosition: position },
      });
    }
  }
}

/**
 * Atomically consumes the first QueueNotify row and creates its durable
 * notification. The socket event is intentionally emitted only after commit.
 */
export async function notifyWaitlistInTransaction(
  tx: Prisma.TransactionClient,
  serviceId: string,
): Promise<WaitlistNotification | null> {
  await lockServiceQueue(tx, serviceId);

  const service = await tx.service.findUnique({
    where: { id: serviceId },
    select: { queueLimit: true },
  });
  if (!service) return null;

  const activeOngoingCount = await tx.booking.count({
    where: { serviceId, status: "ONGOING" },
  });
  const waitingCount = await tx.queue.count({
    where: { serviceId, status: "WAITING" },
  });
  if (activeOngoingCount + waitingCount >= service.queueLimit) return null;

  const firstWaiting = await tx.queueNotify.findFirst({
    where: { serviceId },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: { id: true, seekerId: true },
  });
  if (!firstWaiting) return null;

  const title = "Queue slot available";
  await tx.notification.create({
    data: {
      userId: firstWaiting.seekerId,
      title,
      body: "A slot opened for a service on your waitlist. Book it before the queue fills again.",
      link: "/seeker/seek-services",
    },
  });
  await tx.queueNotify.delete({ where: { id: firstWaiting.id } });
  return { seekerId: firstWaiting.seekerId, title };
}

export function emitWaitlistNotification(notification: WaitlistNotification | null): void {
  if (!notification) return;
  safeEmit(`user:${notification.seekerId}`, "notification", { title: notification.title });
}

export async function recalculateQueue(serviceId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await recalculateQueueInTransaction(tx, serviceId);
  });
}

export async function notifyWaitlist(serviceId: string): Promise<void> {
  const notification = await prisma.$transaction(async (tx) =>
    notifyWaitlistInTransaction(tx, serviceId),
  );
  emitWaitlistNotification(notification);
}

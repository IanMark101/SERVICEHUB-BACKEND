import { prisma } from "../../lib/prisma";
import { assertDistinctAccounts } from "../../utils/security";
import { lockServiceQueue } from "../queue.service";

export async function joinWaitlist(serviceId: string, seekerId: string) {
  return prisma.$transaction(async (tx) => {
    await lockServiceQueue(tx, serviceId);
    const service = await tx.service.findUnique({
      where: { id: serviceId },
      select: {
        providerId: true,
        status: true,
        isAvailable: true,
        queueLimit: true,
        provider: { select: { isActive: true, moderationStatus: true } },
      },
    });
    if (
      !service ||
      service.status !== "ACTIVE" ||
      !service.isAvailable ||
      !service.provider.isActive ||
      service.provider.moderationStatus !== "ACTIVE"
    ) {
      const error = new Error("This service is not available") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    assertDistinctAccounts(seekerId, service.providerId, "join service waitlist");

    const activeBooking = await tx.booking.findFirst({
      where: {
        seekerId,
        serviceId,
        status: {
          in: [
            "PENDING_APPROVAL",
            "WAITING",
            "ONGOING",
            "ACCEPTED",
            "AWAITING_CONFIRMATION",
            "UNDER_REVIEW",
            "DISPUTED",
          ],
        },
      },
      select: { id: true },
    });
    if (activeBooking) {
      const error = new Error(
        "You already have an active booking for this service in progress. Please check your Activity tab.",
      ) as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const existing = await tx.queueNotify.findUnique({
      where: { serviceId_seekerId: { serviceId, seekerId } },
    });
    if (existing) {
      const error = new Error("You are already on the waitlist for this service") as Error & { status?: number };
      error.status = 409;
      throw error;
    }

    const ongoingCount = await tx.booking.count({ where: { serviceId, status: "ONGOING" } });
    const waitingCount = await tx.queue.count({ where: { serviceId, status: "WAITING" } });
    if (ongoingCount + waitingCount < service.queueLimit) {
      const error = new Error("A queue slot is currently available; start the online payment flow instead") as Error & {
        status?: number;
        code?: string;
      };
      error.status = 409;
      error.code = "QUEUE_SLOT_AVAILABLE";
      throw error;
    }

    return tx.queueNotify.create({ data: { serviceId, seekerId } });
  });
}

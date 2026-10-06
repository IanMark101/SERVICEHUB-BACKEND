import type { Prisma } from "@prisma/client";

export type BookingProgressKind =
  | "ACCEPTED" | "STARTED" | "WORK_MARKED_COMPLETE" | "COMPLETION_CONFIRMED"
  | "DECLINED" | "CANCELLATION_REQUESTED" | "CANCELLATION_APPROVED"
  | "CANCELLATION_DECLINED" | "CANCELLATION_ESCALATED" | "CANCELED";
export type BookingProgressActor = "SEEKER" | "PROVIDER" | "ADMIN" | "SYSTEM";

export function bookingActorRole(
  booking: { seekerId: string; providerId: string },
  actorId?: string,
): BookingProgressActor {
  if (!actorId) return "SYSTEM";
  if (actorId === booking.seekerId) return "SEEKER";
  if (actorId === booking.providerId) return "PROVIDER";
  return "ADMIN";
}

export async function recordBookingProgress(
  tx: Prisma.TransactionClient,
  bookingId: string,
  kind: BookingProgressKind,
  actorRole: BookingProgressActor,
  eventKey: string = kind,
) {
  // Retries retain the first successful action's server timestamp.
  // The caller's transaction rolls the event back if the action fails.
  return tx.bookingProgressEvent.upsert({
    where: { bookingId_eventKey: { bookingId, eventKey } },
    create: { bookingId, kind, actorRole, eventKey, occurredAt: new Date() },
    update: {},
  });
}

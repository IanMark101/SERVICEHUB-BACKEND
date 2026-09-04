import { prisma } from "../../lib/prisma";

// ── FCFS Queue Logic ──────────────────────────────────────────────────────────

export async function getNextQueuePosition(serviceId: string): Promise<number> {
  const lastEntry = await prisma.queue.findFirst({
    where: { serviceId, status: "WAITING" },
    orderBy: { position: "desc" },
  });

  if (lastEntry) {
    return lastEntry.position + 1;
  }

  // If no entry in Queue table, check if the provider is currently serving an ONGOING booking on this service
  const activeOngoing = await prisma.booking.findFirst({
    where: { serviceId, status: "ONGOING" },
  });

  // If there's an ongoing job, position 1 is active, so the next queue entrant is position 2
  return activeOngoing ? 2 : 1;
}
export async function calculateEstimatedWait(
  serviceId: string,
  position: number
): Promise<number> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { estimatedDurationMins: true },
  });
  if (!service) return 0;
  return service.estimatedDurationMins * (position - 1);
}

export async function resolveFinalPrice(booking: any): Promise<number> {
  if (booking.agreedAmount != null) return Number(booking.agreedAmount);
  if (booking.directRequest) return Number(booking.directRequest.agreedPrice);
  if (booking.offer) return Number(booking.offer.offeredPrice);
  if (booking.service) return Number(booking.service.price);
  if (booking.serviceId) {
    const service = await prisma.service.findUnique({
      where: { id: booking.serviceId },
      select: { price: true },
    });
    return service ? Number(service.price) : 0;
  }
  return 0;
}

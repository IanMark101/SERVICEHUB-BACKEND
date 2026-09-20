import { prisma } from "../../lib/prisma";

// ── FCFS Queue Logic ──────────────────────────────────────────────────────────

export async function getNextQueuePosition(serviceId: string): Promise<number> {
  const lastEntry = await prisma.queue.findFirst({
    where: { serviceId, status: { in: ["SERVING", "WAITING"] } },
    orderBy: { position: "desc" },
  });
  return lastEntry ? lastEntry.position + 1 : 1;
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

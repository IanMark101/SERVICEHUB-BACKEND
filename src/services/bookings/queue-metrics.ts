import { prisma } from "../../lib/prisma";

// ── FCFS Queue Logic ──────────────────────────────────────────────────────────

export async function getNextQueuePosition(providerId: string): Promise<number> {
  const lastEntry = await prisma.queue.findFirst({
    where: { providerId, status: { in: ["SERVING", "WAITING"] } },
    orderBy: { position: "desc" },
  });
  return lastEntry ? lastEntry.position + 1 : 1;
}
export async function calculateEstimatedWait(
  providerId: string,
  position: number
): Promise<number> {
  const ahead = await prisma.queue.findMany({
    where: { providerId, status: { in: ["SERVING", "WAITING"] }, position: { lt: position } },
    include: { booking: { select: { estimatedDurationMins: true } } },
  });
  return ahead.reduce((sum, entry) => sum + (entry.booking?.estimatedDurationMins ?? 60), 0);
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

import { prisma } from "../lib/prisma";
export async function recalculateQueue(serviceId) {
    const activeEntries = await prisma.queue.findMany({
        where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
        orderBy: { position: "asc" },
    });
    const service = await prisma.service.findUnique({
        where: { id: serviceId },
        select: { estimatedDurationMins: true },
    });
    if (!service)
        return;
    // Re-number all positions sequentially and recalculate wait times
    // ALSO sync the corresponding Booking.queuePosition (Spec Part 4)
    for (let i = 0; i < activeEntries.length; i++) {
        const newPosition = i + 1;
        const newWait = service.estimatedDurationMins * (newPosition - 1);
        await prisma.queue.update({
            where: { id: activeEntries[i].id },
            data: { position: newPosition, estimatedWait: newWait },
        });
        // Keep Booking.queuePosition in sync
        if (activeEntries[i].bookingId) {
            await prisma.booking.update({
                where: { id: activeEntries[i].bookingId },
                data: { queuePosition: newPosition },
            });
        }
    }
}
export async function notifyWaitlist(serviceId) {
    const service = await prisma.service.findUnique({
        where: { id: serviceId },
        select: { queueLimit: true },
    });
    if (!service)
        return;
    const currentQueueSize = await prisma.queue.count({
        where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
    });
    if (currentQueueSize < service.queueLimit) {
        // Notify the first person on the waitlist
        const firstWaiting = await prisma.queueNotify.findFirst({
            where: { serviceId },
            orderBy: { requestedAt: "asc" },
            include: { seeker: { select: { id: true, name: true } } },
        });
        if (firstWaiting) {
            await prisma.notification.create({
                data: {
                    userId: firstWaiting.seekerId,
                    title: "Queue Slot Available! 🎉",
                    body: "A slot just opened up for a service you were waiting for. Book now before it fills up.",
                    link: `/seeker/seek-services`,
                },
            });
            // Remove from waitlist
            await prisma.queueNotify.delete({ where: { id: firstWaiting.id } });
        }
    }
}
//# sourceMappingURL=queue.service.js.map
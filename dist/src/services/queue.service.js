import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
export async function recalculateQueue(serviceId) {
    const activeEntries = await prisma.queue.findMany({
        where: { serviceId, status: "WAITING" },
        orderBy: { position: "asc" },
    });
    const service = await prisma.service.findUnique({
        where: { id: serviceId },
        select: { estimatedDurationMins: true },
    });
    if (!service)
        return;
    // An active job occupies the first slot while its Queue record is retained
    // as SERVING for payment traceability. Waiting entries retain a one-based offset so
    // the next customer is position 2 (not position 1 with a zero-minute wait).
    const activeOngoingCount = await prisma.booking.count({
        where: { serviceId, status: "ONGOING" },
    });
    // Re-number all positions sequentially and recalculate wait times
    // ALSO sync the corresponding Booking.queuePosition (Spec Part 4)
    for (let i = 0; i < activeEntries.length; i++) {
        const newPosition = activeOngoingCount + i + 1;
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
    const activeOngoingCount = await prisma.booking.count({
        where: { serviceId, status: "ONGOING" },
    });
    const queueCount = await prisma.queue.count({
        where: { serviceId, status: "WAITING" },
    });
    const currentQueueSize = activeOngoingCount + queueCount;
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
            safeEmit(`user:${firstWaiting.seekerId}`, "notification", { title: "Queue Slot Available! 🎉" });
            // Remove from waitlist
            await prisma.queueNotify.delete({ where: { id: firstWaiting.id } });
        }
    }
}
//# sourceMappingURL=queue.service.js.map
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { lockProviderQueue, recalculateQueueInTransaction } from "../../services/queue.service";
import { paidStartBlockReason } from "../../services/bookings/paid-start-readiness";

const capacitySchema = z.object({ onlineQueueLimit: z.number().int().min(1).max(10) }).strict();

export async function getProviderWorkload(req: Request, res: Response, next: NextFunction) {
  try {
    const providerId = (req as AuthenticatedRequest).user.id;
    const [provider, paidJobs, cashJobs] = await Promise.all([
      prisma.user.findUnique({ where: { id: providerId }, select: { onlineQueueLimit: true } }),
      prisma.queue.findMany({
        where: { providerId, status: { in: ["WAITING", "SERVING"] } },
        orderBy: { position: "asc" },
        select: { id: true, bookingId: true, position: true, status: true, paymentStatus: true, estimatedWait: true,
          booking: { select: { estimatedDurationMins: true, status: true, started: true, paymentStatus: true, seeker: { select: { name: true } },
            service: { select: { title: true } }, offer: { select: { request: { select: { title: true } } } } } } },
      }),
      prisma.booking.findMany({
        where: { providerId, paymentMethod: "On-site Cash", status: { in: ["PENDING_APPROVAL", "ACCEPTED", "ONGOING", "DISPUTED", "UNDER_REVIEW", "AWAITING_CONFIRMATION"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, started: true, seeker: { select: { name: true } }, service: { select: { title: true } },
          offer: { select: { request: { select: { title: true } } } } },
      }),
    ]);
    const currentJob = paidJobs.some((job) => job.status === "SERVING")
      || cashJobs.some((job) => job.started && ["ONGOING", "DISPUTED", "UNDER_REVIEW"].includes(job.status));
    const firstWaitingId = paidJobs.find((job) => job.status === "WAITING")?.id;
    const visiblePaidJobs = paidJobs.map((job) => {
      const startBlockedReason = job.status !== "WAITING" || job.id !== firstWaitingId
        ? "Earlier paid work must finish before this booking can start."
        : currentJob
          ? "Finish your current job before starting another one."
          : job.booking
            ? paidStartBlockReason({
                bookingStatus: job.booking.status,
                bookingStarted: job.booking.started,
                bookingPaymentStatus: job.booking.paymentStatus,
                queueStatus: job.status,
                queuePaymentStatus: job.paymentStatus,
              })
            : "This queue entry has no booking. Contact support before starting work.";
      return { ...job, canStart: startBlockedReason === null, startBlockedReason };
    });
    res.json({ success: true, data: { onlineQueueLimit: provider?.onlineQueueLimit ?? 5, paidJobs: visiblePaidJobs, cashJobs } });
  } catch (error) { next(error); }
}

export async function setProviderWorkloadCapacity(req: Request, res: Response, next: NextFunction) {
  try {
    const providerId = (req as AuthenticatedRequest).user.id;
    const { onlineQueueLimit } = capacitySchema.parse(req.body);
    const provider = await prisma.$transaction(async (tx) => {
      await lockProviderQueue(tx, providerId);
      const updated = await tx.user.update({ where: { id: providerId }, data: { onlineQueueLimit }, select: { onlineQueueLimit: true } });
      await recalculateQueueInTransaction(tx, providerId);
      return updated;
    });
    res.json({ success: true, data: provider });
  } catch (error) { next(error); }
}

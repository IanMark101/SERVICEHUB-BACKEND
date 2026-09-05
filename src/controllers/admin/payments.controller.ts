import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { refundCapturedAttempt } from "../../services/payment-attempt.service";

export async function listPaymentReconciliation(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const where = { status: "REFUND_REQUIRED" as const };
    const [data, total] = await Promise.all([prisma.paymentAttempt.findMany({
      where,
      orderBy: { updatedAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      select: { id: true, seekerId: true, providerId: true, serviceId: true, offerId: true, providerIntentId: true, providerPaymentId: true, amount: true, paymentMethod: true, status: true, failureReason: true, createdAt: true, updatedAt: true },
    }), prisma.paymentAttempt.count({ where })]);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
}
export async function retryPaymentReconciliation(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = (req as AuthenticatedRequest).user.id;
    const attemptId = req.params.id as string;
    const result = await refundCapturedAttempt(attemptId);
    await prisma.adminAuditLog.create({
      data: { actorId: adminId, action: "PAYMENT_RECONCILIATION_RETRIED", resourceType: "PaymentAttempt", resourceId: attemptId, reason: "Administrator retried automatic captured-payment refund" },
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}

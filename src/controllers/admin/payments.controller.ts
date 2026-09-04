import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { refundCapturedAttempt } from "../../services/payment-attempt.service";

export async function listPaymentReconciliation(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await prisma.paymentAttempt.findMany({
      where: { status: "REFUND_REQUIRED" },
      orderBy: { updatedAt: "asc" },
      take: 100,
      select: { id: true, seekerId: true, providerId: true, serviceId: true, offerId: true, providerIntentId: true, providerPaymentId: true, amount: true, paymentMethod: true, status: true, failureReason: true, createdAt: true, updatedAt: true },
    });
    res.json({ success: true, data });
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

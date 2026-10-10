import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { ConfirmOnlineBookingSchema, InitiatePaymentSchema } from "../../schema/marketplace.schema";
import { initiateOnlinePayment, reconcileOnlinePaymentReturn } from "../../services/payment-attempt.service";

export async function initiatePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const input = InitiatePaymentSchema.parse(req.body);
    const attempt = await initiateOnlinePayment({
      seekerId: user.id,
      retryPaymentIntentId: input.retryPaymentIntentId,
      serviceId: input.serviceId,
      offerId: input.offerId,
      quantity: input.quantity,
      jobLocation: input.jobLocation,
      paymentMethod: input.paymentMethodType,
    });
    return res.json({
      success: true,
      message: "Payment attempt created. Complete the provider checkout to continue.",
      data: {
        attemptId: attempt.id,
        paymentIntentId: attempt.providerIntentId,
        clientKey: attempt.providerClientKey,
        redirectUrl: attempt.redirectUrl,
        expectedAmount: Number(attempt.amount),
        expiresAt: attempt.expiresAt,
      },
    });
  } catch (error: any) {
    if (error?.name === "ZodError") return res.status(400).json({ success: false, error: "Validation failed", errors: error.issues });
    next(error);
  }
}
// A browser redirect is informational. The backend independently verifies
// PayMongo's intent before using the same idempotent finalizer as the webhook.
export async function confirmOnlineBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { paymentIntentId } = ConfirmOnlineBookingSchema.parse(req.body);
    const attempt = await reconcileOnlinePaymentReturn(user.id, paymentIntentId);
    return res.json({
      success: true,
      message: attempt.status === "SUCCEEDED"
        ? "Payment confirmed and booking created."
        : attempt.status === "PENDING"
          ? "Payment return received. Waiting for secure provider confirmation."
          : "Payment could not be completed.",
      data: attempt,
    });
  } catch (error: any) {
    if (error?.name === "ZodError") return res.status(400).json({ success: false, error: "Validation failed", errors: error.issues });
    next(error);
  }
}

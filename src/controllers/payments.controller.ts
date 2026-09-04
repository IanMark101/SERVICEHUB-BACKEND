import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { getPaymentIntent } from "../services/paymongo.service";
import { finalizeSuccessfulPayment, markPaymentAttemptFailed, refundCapturedAttempt } from "../services/payment-attempt.service";

function secureEqualHex(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
export function validPaymongoSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!env.PAYMONGO_WEBHOOK_SECRET || !header) return false;
  const raw = rawBody.toString("utf8");
  const direct = crypto.createHmac("sha256", env.PAYMONGO_WEBHOOK_SECRET).update(raw).digest("hex");
  if (secureEqualHex(header.trim(), direct)) return true;

  const parts = Object.fromEntries(header.split(",").map((part) => {
    const [key, value = ""] = part.trim().split("=", 2);
    return [key, value];
  }));
  const timestamp = parts.t;
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const timestamped = crypto.createHmac("sha256", env.PAYMONGO_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex");
  return [parts.te, parts.li].some((candidate) => secureEqualHex(candidate || "", timestamped));
}

function paymentIntentIdFromEvent(payload: any): string | undefined {
  const data = payload?.data?.attributes?.data;
  return data?.attributes?.payment_intent_id || (data?.type === "payment_intent" ? data?.id : undefined);
}

export async function receivePaymongoWebhook(req: Request, res: Response, next: NextFunction) {
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody) || !validPaymongoSignature(rawBody, req.get("paymongo-signature"))) {
    return res.status(401).json({ success: false, error: "Invalid webhook signature" });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, error: "Invalid webhook payload" });
  }

  const eventId = payload?.data?.id;
  const eventType = payload?.data?.attributes?.type;
  if (typeof eventId !== "string" || typeof eventType !== "string") {
    return res.status(400).json({ success: false, error: "Webhook event identity is missing" });
  }

  try {
    const event = await prisma.processedWebhookEvent.upsert({
      where: { provider_eventId: { provider: "PAYMONGO", eventId } },
      create: { provider: "PAYMONGO", eventId, eventType, status: "PROCESSING" },
      update: {},
    });
    if (event.status === "PROCESSED") return res.status(200).json({ success: true, duplicate: true });

    if (!["payment.paid", "payment_intent.succeeded", "payment.failed", "payment_intent.payment_failed"].includes(eventType)) {
      await prisma.processedWebhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
      return res.status(200).json({ success: true, ignored: true });
    }

    const paymentIntentId = paymentIntentIdFromEvent(payload);
    if (!paymentIntentId) throw new Error("Webhook does not identify a payment intent");

    if (["payment.failed", "payment_intent.payment_failed"].includes(eventType)) {
      await markPaymentAttemptFailed(paymentIntentId, eventType);
    } else {
      const intent = await getPaymentIntent(paymentIntentId);
      if (intent.status !== "succeeded") throw new Error("Payment intent has not reached succeeded state");
      const finalized = await finalizeSuccessfulPayment({
        paymentIntentId: intent.id,
        paymentId: intent.paymentId,
        amount: intent.amount,
        currency: intent.currency,
        metadata: intent.metadata,
      });
      if (finalized.refundRequired && finalized.attempt?.id) await refundCapturedAttempt(finalized.attempt.id);
    }

    await prisma.processedWebhookEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", failureReason: null, processedAt: new Date() },
    });
    return res.status(200).json({ success: true });
  } catch (error: any) {
    await prisma.processedWebhookEvent.updateMany({
      where: { provider: "PAYMONGO", eventId },
      data: { status: "FAILED", failureReason: String(error?.code || error?.message || "WEBHOOK_FAILED").slice(0, 500) },
    }).catch(() => undefined);
    next(error);
  }
}

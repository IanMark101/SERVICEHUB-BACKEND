import crypto from "crypto";
import { env } from "../config/env";
import { getPaymentIntent } from "../services/paymongo.service";
import { addToQueue } from "../services/bookings.service";
function validSignature(rawBody, header) {
    if (!env.PAYMONGO_WEBHOOK_SECRET || !header)
        return false;
    const parts = Object.fromEntries(header.split(",").map((part) => {
        const [key, value = ""] = part.trim().split("=", 2);
        return [key, value];
    }));
    const timestamp = parts.t;
    if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
        return false;
    const expected = crypto.createHmac("sha256", env.PAYMONGO_WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody.toString("utf8")}`)
        .digest("hex");
    return [parts.te, parts.li].some((signature) => {
        if (!signature || !/^[a-f0-9]{64}$/i.test(signature) || signature.length !== expected.length)
            return false;
        return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
    });
}
export async function receivePaymongoWebhook(req, res, next) {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody) || !validSignature(rawBody, req.get("paymongo-signature"))) {
        return res.status(401).json({ success: false, error: "Invalid webhook signature" });
    }
    try {
        const event = JSON.parse(rawBody.toString("utf8"))?.data?.attributes;
        if (!event || !["payment.paid", "payment_intent.succeeded"].includes(event.type)) {
            return res.status(200).json({ success: true, ignored: true });
        }
        const paymentData = event.data;
        const paymentIntentId = paymentData?.attributes?.payment_intent_id ||
            (paymentData?.type === "payment_intent" ? paymentData?.id : undefined);
        if (typeof paymentIntentId !== "string")
            return res.status(200).json({ success: true, ignored: true });
        const intent = await getPaymentIntent(paymentIntentId);
        const metadata = intent.metadata;
        const expectedAmount = Number(metadata.servicehub_expected_amount);
        const methodMap = { gcash: "GCash", paymaya: "Maya", card: "Card" };
        const paymentMethod = methodMap[metadata.servicehub_payment_method];
        if (intent.status !== "succeeded" || intent.currency !== "PHP" || !metadata.servicehub_service_id ||
            !metadata.servicehub_seeker_id || !paymentMethod || !Number.isFinite(expectedAmount) ||
            Math.abs(intent.amount - expectedAmount) >= 0.005) {
            return res.status(200).json({ success: true, ignored: true });
        }
        await addToQueue({
            serviceId: metadata.servicehub_service_id,
            seekerId: metadata.servicehub_seeker_id,
            offerId: metadata.servicehub_offer_id || undefined,
            paymentId: intent.id,
            paymongoPaymentId: intent.paymentId,
            amount: intent.amount,
            paymentMethod,
        });
        return res.status(200).json({ success: true });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=payments.controller.js.map
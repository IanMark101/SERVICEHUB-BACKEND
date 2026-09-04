/**
 * PayMongo Service — Test Mode Integration
 * 
 * During capstone development, PayMongo test mode is used exclusively.
 * No real money moves. Test cards/GCash numbers are provided by PayMongo docs.
 * 
 * PayMongo charges immediately. PAID_HELD is only ServiceHub's internal
 * fulfillment state and is not represented to users as regulated escrow.
 */

import { env } from "../config/env";

const PAYMONGO_BASE = "https://api.paymongo.com/v1";

function getAuthHeader(): string {
  const key = env.PAYMONGO_SECRET_KEY;
  if (!key) {
    const err = new Error("PayMongo is not configured") as any;
    err.status = 503;
    err.code = "PAYMONGO_NOT_CONFIGURED";
    throw err;
  }
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

async function paymongoFetch(path: string, options: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try {
    response = await fetch(`${PAYMONGO_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Authorization": getAuthHeader(),
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (cause: any) {
    const err = new Error(cause?.name === "AbortError" ? "PayMongo request timed out" : "PayMongo is unavailable") as any;
    err.status = 503;
    err.code = "PAYMONGO_UNAVAILABLE";
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.json() as any;

  if (!response.ok) {
    const err = new Error(
      body?.errors?.[0]?.detail || "PayMongo API error"
    ) as any;
    err.status = response.status;
    err.code = "PAYMONGO_API_ERROR";
    throw err;
  }

  return body;
}

// ── Create Payment Intent ─────────────────────────────────────────────────────

export async function createPaymentIntent(params: {
  amount: number; // in PHP cents (multiply pesos by 100)
  currency?: string;
  description: string;
  statementDescriptor?: string;
  metadata?: Record<string, string>;
  paymentMethod: "gcash" | "paymaya" | "card";
  idempotencyKey: string;
}): Promise<{ id: string; clientKey: string; status: string }> {
  const body = await paymongoFetch("/payment_intents", {
    method: "POST",
    body: JSON.stringify({
      data: {
        attributes: {
          amount: Math.round(params.amount * 100), // convert to cents
          currency: params.currency || "PHP",
          payment_method_allowed: [params.paymentMethod],
          description: params.description,
          statement_descriptor: params.statementDescriptor || "ServiceHub Cordova",
          metadata: params.metadata,
          capture_type: "automatic",
        },
      },
    }),
    headers: { "Idempotency-Key": params.idempotencyKey },
  });

  return {
    id: body.data.id,
    clientKey: body.data.attributes.client_key,
    status: body.data.attributes.status,
  };
}

// ── Retrieve Payment Intent (check status after webhook or frontend callback) ─

export async function getPaymentIntent(paymentIntentId: string): Promise<{
  id: string;
  paymentId?: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}> {
  const body = await paymongoFetch(`/payment_intents/${paymentIntentId}`);
  return {
    id: body.data.id,
    paymentId: body.data.attributes.payments?.[0]?.id,
    status: body.data.attributes.status,
    amount: body.data.attributes.amount / 100, // convert back to PHP
    currency: body.data.attributes.currency,
    metadata: body.data.attributes.metadata || {},
  };
}

// ── Verify Payment Succeeded ───────────────────────────────────────────────────

export async function verifyPaymentSuccess(paymentIntentId: string): Promise<boolean> {
  const intent = await getPaymentIntent(paymentIntentId);
  return intent.status === "succeeded";
}

// ── Create Refund ─────────────────────────────────────────────────────────────

export async function createRefund(params: {
  paymentId: string;
  amount?: number; // partial refund in PHP (optional — full refund if omitted)
  reason: string;
  idempotencyKey?: string;
}): Promise<{ id: string; status: string }> {
  const body = await paymongoFetch("/refunds", {
    method: "POST",
    ...(params.idempotencyKey ? { headers: { "Idempotency-Key": params.idempotencyKey } } : {}),
    body: JSON.stringify({
      data: {
        attributes: {
          payment_id: params.paymentId,
          ...(params.amount && { amount: Math.round(params.amount * 100) }),
          reason: params.reason || "others",
          notes: "ServiceHub Cordova — admin approved refund",
        },
      },
    }),
  });

  return {
    id: body.data.id,
    status: body.data.attributes.status,
  };
}

// ── Create Payment Method ──────────────────────────────────────────────────────

export async function createPaymentMethod(type: string): Promise<string> {
  if (!['gcash', 'paymaya', 'card'].includes(type)) {
    const err = new Error('Unsupported payment method') as any;
    err.status = 400;
    throw err;
  }
  const body = await paymongoFetch("/payment_methods", {
    method: "POST",
    body: JSON.stringify({
      data: {
        attributes: {
          type,
        },
      },
    }),
  });
  return body.data.id;
}

// ── Attach Payment Method to Intent ────────────────────────────────────────────

export async function attachPaymentMethod(params: {
  paymentIntentId: string;
  paymentMethodId: string;
  clientKey: string;
  returnUrl: string;
}): Promise<{ status: string; nextAction: any }> {
  const body = await paymongoFetch(`/payment_intents/${params.paymentIntentId}/attach`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        attributes: {
          payment_method: params.paymentMethodId,
          client_key: params.clientKey,
          return_url: params.returnUrl,
        },
      },
    }),
  });

  return {
    status: body.data.attributes.status,
    nextAction: body.data.attributes.next_action,
  };
}

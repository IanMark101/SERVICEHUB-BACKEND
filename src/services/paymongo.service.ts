/**
 * PayMongo Service — Test Mode Integration
 * 
 * During capstone development, PayMongo test mode is used exclusively.
 * No real money moves. Test cards/GCash numbers are provided by PayMongo docs.
 * 
 * Escrow simulation: PayMongo charges immediately, but ServiceHub's own DB
 * tracks payment_status (PAID_HELD → RELEASED/FROZEN_HELD/REFUNDED) to
 * represent "held in escrow" as described in master prompt Section 17.
 */

import { env } from "../config/env";

const PAYMONGO_BASE = "https://api.paymongo.com/v1";

function getAuthHeader(): string {
  const key = env.PAYMONGO_SECRET_KEY || "sk_test_placeholder";
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

async function paymongoFetch(path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`${PAYMONGO_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": getAuthHeader(),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const body = await response.json() as any;

  if (!response.ok) {
    const err = new Error(
      body?.errors?.[0]?.detail || "PayMongo API error"
    ) as any;
    err.status = response.status;
    err.paymongoErrors = body?.errors;
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
}): Promise<{ id: string; clientKey: string; status: string }> {
  const body = await paymongoFetch("/payment_intents", {
    method: "POST",
    body: JSON.stringify({
      data: {
        attributes: {
          amount: Math.round(params.amount * 100), // convert to cents
          currency: params.currency || "PHP",
          payment_method_allowed: ["gcash", "paymaya", "card"],
          description: params.description,
          statement_descriptor: params.statementDescriptor || "ServiceHub Cordova",
          capture_type: "automatic",
        },
      },
    }),
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
  status: string;
  amount: number;
}> {
  const body = await paymongoFetch(`/payment_intents/${paymentIntentId}`);
  return {
    id: body.data.id,
    status: body.data.attributes.status,
    amount: body.data.attributes.amount / 100, // convert back to PHP
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
}): Promise<{ id: string; status: string }> {
  const body = await paymongoFetch("/refunds", {
    method: "POST",
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

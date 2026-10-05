type RequestPaymentSource = { paymentMethods?: unknown; preferredPaymentMethod?: string | null };

export function getRequestPaymentMethods(request: RequestPaymentSource) {
  const raw = request.paymentMethods;
  const methods = raw == null ? { cash: true, gcash: true } : {
    cash: typeof raw === "object" && (raw as { cash?: unknown }).cash === true,
    gcash: typeof raw === "object" && (raw as { gcash?: unknown }).gcash === true,
  };
  return {
    cash: methods.cash && (!request.preferredPaymentMethod || request.preferredPaymentMethod === "On-site Cash"),
    gcash: methods.gcash && (!request.preferredPaymentMethod || request.preferredPaymentMethod === "GCash"),
  };
}

export function assertRequestPaymentMethod(request: RequestPaymentSource, method: "cash" | "gcash") {
  if (!getRequestPaymentMethods(request)[method]) {
    throw Object.assign(new Error("Choose a payment method selected on this request."), {
      status: 409, code: "REQUEST_PAYMENT_METHOD_UNAVAILABLE",
    });
  }
}

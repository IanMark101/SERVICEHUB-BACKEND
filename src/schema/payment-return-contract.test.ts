import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfirmOnlineBookingSchema, InitiatePaymentSchema } from './marketplace.schema';
import { attachPaymentMethod, getPaymentIntent } from '../services/paymongo.service';

test('return reconciliation needs only the owned intent and payment creation remains GCash-only', () => {
  assert.equal(ConfirmOnlineBookingSchema.parse({ paymentIntentId: 'pi_test_123' }).paymentIntentId, 'pi_test_123');
  assert.equal(InitiatePaymentSchema.safeParse({ serviceId: 'ckwq1x3mb0000l5s63ygoqaa0', paymentMethodType: 'gcash' }).success, true);
  assert.equal(InitiatePaymentSchema.safeParse({ serviceId: 'ckwq1x3mb0000l5s63ygoqaa0', paymentMethodType: 'paymaya' }).success, false);
  assert.equal(InitiatePaymentSchema.safeParse({ serviceId: 'ckwq1x3mb0000l5s63ygoqaa0', paymentMethodType: 'card' }).success, false);
});

test('PayMongo attach sends the explicit ServiceHub return route and failed provider status is readable', async () => {
  const previousFetch = globalThis.fetch;
  let sentReturnUrl = '';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/attach')) {
      sentReturnUrl = JSON.parse(String(init?.body)).data.attributes.return_url;
      return Response.json({ data: { attributes: { status: 'awaiting_next_action', next_action: { type: 'redirect', redirect: { url: 'https://test-sources.paymongo.com/sources/test' } } } } });
    }
    if (url.endsWith('/payment_intents/pi_test_123')) {
      return Response.json({ data: { id: 'pi_test_123', attributes: { status: 'awaiting_payment_method', amount: 7000, currency: 'PHP' } } });
    }
    throw new Error(`Unexpected provider test request: ${url}`);
  };
  try {
    const returnUrl = 'http://localhost:3000/seeker/payment-return?payment_intent_id=pi_test_123';
    await attachPaymentMethod({ paymentIntentId: 'pi_test_123', paymentMethodId: 'pm_test', clientKey: 'client_test', returnUrl });
    assert.equal(sentReturnUrl, returnUrl);
    assert.equal((await getPaymentIntent('pi_test_123')).status, 'awaiting_payment_method');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

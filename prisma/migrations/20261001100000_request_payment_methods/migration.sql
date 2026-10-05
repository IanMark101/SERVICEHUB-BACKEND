-- Older public requests keep NULL: no payment preference was collected.
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "paymentMethods" JSONB;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_payment_methods_check"
CHECK ("paymentMethods" IS NULL OR (
  jsonb_typeof("paymentMethods") = 'object'
  AND "paymentMethods" ? 'cash' AND "paymentMethods" ? 'gcash'
  AND jsonb_typeof("paymentMethods" -> 'cash') = 'boolean'
  AND jsonb_typeof("paymentMethods" -> 'gcash') = 'boolean'
  AND ("paymentMethods" -> 'cash' = 'true'::jsonb OR "paymentMethods" -> 'gcash' = 'true'::jsonb)
  AND "paymentMethods" - 'cash' - 'gcash' = '{}'::jsonb
));

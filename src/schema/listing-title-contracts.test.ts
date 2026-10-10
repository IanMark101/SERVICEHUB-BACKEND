import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateServiceSchema, UpdateServiceSchema } from './services.schema';
import { ServiceRequestSchema, ServiceRequestUpdateSchema } from './marketplace.schema';

const title = '  Aircon cleaning & TV repair  ';
const description = 'I will clean the unit and repair the leaking pipe.';

test('service creation and editing save uppercase titles while preserving descriptions', () => {
  const created = CreateServiceSchema.parse({ serviceLocation: { latitude: 10.3, longitude: 123.9, label: 'Cebu' },
    categoryId: 'category-id', title, description, price: 500,
    estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: false },
  });
  const edited = UpdateServiceSchema.parse({ title, description });
  assert.equal(created.title, 'AIRCON CLEANING & TV REPAIR');
  assert.equal(edited.title, created.title);
  assert.equal(created.description, description);
  assert.equal(edited.description, description);
  assert.equal(UpdateServiceSchema.parse({ price: 500 }).title, undefined);
});

test('request creation and editing save uppercase titles while preserving descriptions', () => {
  const created = ServiceRequestSchema.parse({ jobLocation: { latitude: 10.3, longitude: 123.9, label: 'Cebu' },
    categoryId: 'ckx1234567890123456789012', title, description,
    budgetMin: 500, budgetMax: 500,
    urgency: 'Flexible Schedule',
    paymentMethods: { cash: true, gcash: false },
  });
  const edited = ServiceRequestUpdateSchema.parse({ title, description });
  assert.equal(created.title, 'AIRCON CLEANING & TV REPAIR');
  assert.equal(edited.title, created.title);
  assert.equal(created.description, description);
  assert.equal(edited.description, description);
  assert.equal(ServiceRequestUpdateSchema.parse({ status: 'CLOSED' }).title, undefined);
});

test('normalizing titles retains length and character validation', () => {
  assert.equal(UpdateServiceSchema.safeParse({ title: 'short' }).success, false);
  assert.equal(UpdateServiceSchema.safeParse({ title: 'Repair <script>unsafe</script>' }).success, false);
  assert.equal(ServiceRequestUpdateSchema.safeParse({ title: 'ab' }).success, false);
  assert.equal(ServiceRequestUpdateSchema.safeParse({ title: 'a'.repeat(101) }).success, false);
  assert.equal(ServiceRequestUpdateSchema.safeParse({ title: 'ß'.repeat(100) }).success, false);
});

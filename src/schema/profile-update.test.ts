import assert from 'node:assert/strict';
import test from 'node:test';
import { UpdateProfileSchema } from './auth.schema';

test('profile links can be updated without submitting private contact or general-area fields', () => {
  const links = {
    facebookUrl: 'https://www.facebook.com/john', instagramUrl: 'https://www.instagram.com/john/',
    websiteUrl: 'https://john.vercel.app/',
  };
  assert.deepEqual(UpdateProfileSchema.parse(links), links);
  assert.deepEqual(UpdateProfileSchema.parse({ location: '  Day-as, Cordova, Cebu  ' }), { location: 'Day-as, Cordova, Cebu' });
});

test('phone and general-area edits still reject empty/invalid values with understandable messages', () => {
  for (const phone of ['', '123', '+1 555 123 4567']) {
    const result = UpdateProfileSchema.safeParse({ phone });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.issues[0].message, 'Enter a valid Philippine mobile number, such as 0917 123 4567 or +63 917 123 4567.');
  }
  const result = UpdateProfileSchema.safeParse({ location: ' ' });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues[0].message, 'Enter your general city or municipality and barangay.');
  for (const phone of ['09171234567', '0917 123 4567', '+63 917 123 4567']) {
    assert.equal(UpdateProfileSchema.parse({ phone }).phone, phone);
  }
});

test('links can be cleared but unsafe/invalid URLs and privileged fields remain rejected', () => {
  assert.deepEqual(UpdateProfileSchema.parse({ websiteUrl: '' }), { websiteUrl: '' });
  for (const websiteUrl of ['javascript:alert(1)', 'http://example.com', 'not a url']) {
    assert.equal(UpdateProfileSchema.safeParse({ websiteUrl }).success, false);
  }
  assert.equal(UpdateProfileSchema.safeParse({ websiteUrl: 'https://example.com', role: 'admin' }).success, false);
  assert.equal(UpdateProfileSchema.safeParse({ verificationStatus: 'APPROVED' }).success, false);
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { initSocket } from '../lib/socket';
import { publishPublicRequestChange } from '../lib/request-events';

test('public request events contain only invalidation data for every connected account', t => {
  const io = initSocket(createServer());
  t.after(() => { io.close(); });
  const emitted: { event: string; data: unknown }[] = [];
  t.mock.method(io, 'emit', (event: string, data: unknown) => { emitted.push({ event, data }); return true; });
  const request = {
    id: 'public-request', status: 'OPEN', title: 'Customer repair request', description: 'Full request details',
    budgetMin: 100, budgetMax: 500, privateAddress: 'Private address', latitude: 10, longitude: 123,
    seeker: { id: 'customer', name: 'Customer' }, photos: [{ url: 'https://example.test/photo' }],
  };
  for (const event of ['CREATED', 'UPDATED'] as const) {
    emitted.length = 0;
    publishPublicRequestChange(event, request);
    assert.deepEqual(emitted, [
      { event: `SERVICE_REQUEST_${event}`, data: { id: request.id, status: request.status } },
      { event: 'SERVICE_REQUESTS_CHANGED', data: { id: request.id, status: request.status } },
    ]);
  }
});

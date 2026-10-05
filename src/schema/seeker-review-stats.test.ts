import assert from 'node:assert/strict';
import test from 'node:test';
import { getSeekerReviewStats } from '../lib/seeker-review-stats';

test('client ratings exclude reviews earned as provider, including another client in the same result set', () => {
  const stats = getSeekerReviewStats([
    { targetId: 'resident-a', rating: 5, completedService: { seekerId: 'resident-b' } },
    { targetId: 'resident-a', rating: 3, completedService: { seekerId: 'resident-a' } },
    { targetId: 'resident-a', rating: 4, completedService: { seekerId: 'resident-a' } },
    { targetId: 'resident-b', rating: 2, completedService: { seekerId: 'resident-b' } },
  ]);
  assert.deepEqual(stats.get('resident-a'), { clientRating: 3.5, clientReviewCount: 2 });
  assert.deepEqual(stats.get('resident-b'), { clientRating: 2, clientReviewCount: 1 });
  assert.equal(getSeekerReviewStats([]).size, 0);
});

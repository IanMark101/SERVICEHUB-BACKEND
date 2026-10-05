// Read-only verification. Never creates offers, sessions, bookings or fixtures.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma';
import { listRequests } from '../src/services/requests.service';
import { assertOfferTarget } from '../src/services/offer-eligibility';

async function main() {
  const obsolete = await prisma.serviceRequest.count({ where: { targetServiceId: null, targetProviderId: { not: null } } });
  assert.equal(obsolete, 0, 'Unrepaired provider-only restrictions remain.');
  const providers = await prisma.user.findMany({
    where: { role: 'user', isActive: true, moderationStatus: 'ACTIVE', deactivatedAt: null, emailVerified: true, verificationStatus: 'APPROVED' },
    select: { id: true },
  });
  const publicJobs = await prisma.serviceRequest.findMany({
    where: {
      status: 'OPEN', targetServiceId: null,
      seeker: { isActive: true, moderationStatus: 'ACTIVE', emailVerified: true, verificationStatus: 'APPROVED' },
      offers: { none: { booking: { is: { status: { notIn: ['DECLINED', 'CANCELED', 'REMOVED'] } } } } },
    }, select: { id: true, seekerId: true, targetServiceId: true, targetProviderId: true },
  });
  const expected = publicJobs.map(item => item.id).sort();
  for (const provider of providers) {
    const listed = await listRequests(undefined, provider.id);
    assert.deepEqual(listed.filter(item => !item.targetServiceId).map(item => item.id).sort(), expected, 'Public visibility differs by viewer.');
    for (const job of publicJobs) {
      assert.equal(job.targetProviderId, null);
      assert.doesNotThrow(() => assertOfferTarget(job, provider.id));
    }
    assert.ok(listed.every(item => !item.targetServiceId || item.targetProviderId === provider.id || item.seekerId === provider.id), 'A listing inquiry was exposed to a non-participant.');
  }
  console.log(JSON.stringify({ eligibleAccountsChecked: providers.length, openPublicJobsPerAccount: publicJobs.length, obsoleteProviderRestrictions: obsolete, identicalPublicVisibility: true, readOnly: true }));
}
main().catch(error => {
  console.error('Public visibility audit failed.', error instanceof assert.AssertionError ? error.message : (error as { code?: string }).code || 'AUDIT_ERROR');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());

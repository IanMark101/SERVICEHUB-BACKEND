// Read-only diagnostic: excludes credentials and private verification documents.
import { prisma } from '../src/lib/prisma';
import { assertOfferParticipant, assertOfferTarget } from '../src/services/offer-eligibility';

async function main() {
  const users = await prisma.user.findMany({
    where: { OR: ['buenaflor', 'john', 'vincent'].map(name => ({ name: { contains: name, mode: 'insensitive' as const } })) },
    select: { id: true, name: true, role: true, isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true, postingSuspended: true, deactivatedAt: true,
      services: { select: { id: true, categoryId: true, status: true, isAvailable: true } } },
  });
  const requests = await prisma.serviceRequest.findMany({
    where: { title: { contains: 'JAMMED', mode: 'insensitive' } },
    select: { id: true, seekerId: true, title: true, status: true, categoryId: true, targetProviderId: true, targetServiceId: true, preferredPaymentMethod: true, paymentMethods: true,
      offers: { select: { id: true, providerId: true, serviceId: true, status: true, booking: { select: { status: true } } } } },
  });
  const constraints = await prisma.$queryRaw`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'offers'`;
  const failing = requests.find(request => request.targetProviderId && !request.targetServiceId);
  let eligibility: unknown;
  let workingOffers: unknown;
  if (failing?.targetProviderId) {
    const providerId = failing.targetProviderId;
    assertOfferTarget(failing, providerId);
    await prisma.$transaction(async tx => {
      await assertOfferParticipant(tx, providerId, 'provider');
      await assertOfferParticipant(tx, failing.seekerId, 'seeker');
    });
    eligibility = { requestId: failing.id, providerId, oldListingCheckIncorrectlyRejected: failing.targetServiceId !== undefined, correctedTargetCheckPassed: true, bothAccountsEligible: true };
    workingOffers = await prisma.offer.findMany({ where: { providerId: failing.seekerId, request: { seekerId: providerId } }, select: {
      id: true, status: true, serviceId: true, request: { select: { id: true, targetProviderId: true, targetServiceId: true, category: { select: { name: true } } } },
    }, orderBy: { createdAt: 'desc' }, take: 3 });
  }
  const relevantIds = new Set(requests.flatMap(request => [request.seekerId, request.targetProviderId].filter(Boolean)));
  console.log(JSON.stringify({ users: users.filter(user => relevantIds.has(user.id)), requests, eligibility, workingOffers, constraints }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());

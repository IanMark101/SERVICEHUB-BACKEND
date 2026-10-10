import type { Prisma } from '@prisma/client';

export function assertOfferTarget(request: { targetProviderId: string | null; targetServiceId: string | null }, providerId: string, serviceId?: string) {
  // Public posts have no selected listing. Ignore obsolete provider-only metadata
  // so every eligible provider can respond while existing data is being repaired.
  if (!request.targetServiceId) return;
  if (!request.targetProviderId || request.targetProviderId !== providerId) {
    throw Object.assign(new Error('This request is reserved for another provider. Choose an open request instead.'), { status: 403, code: 'REQUEST_RESERVED' });
  }
  if (request.targetServiceId !== serviceId) {
    throw Object.assign(new Error('The seeker requested a specific listing. Use that listing to send your quote.'), { status: 403, code: 'REQUEST_LISTING_REQUIRED' });
  }
}

export async function assertOfferParticipant(tx: Prisma.TransactionClient, userId: string, participant: 'provider' | 'seeker') {
  const user = await tx.user.findUnique({ where: { id: userId }, select: {
    role: true, isActive: true, deactivatedAt: true, moderationStatus: true, emailVerified: true, verificationStatus: true,
  } });
  let reason: string | undefined;
  let code = 'PARTICIPANT_INELIGIBLE';
  if (!user || user.deactivatedAt) reason = 'This account is no longer available.';
  else if (user.role !== 'user') reason = 'Only a marketplace member can send an offer.';
  else if (user.moderationStatus === 'BANNED') { reason = 'Your account is banned from marketplace transactions.'; code = 'ACCOUNT_BANNED'; }
  else if (user.moderationStatus === 'SUSPENDED') { reason = 'Your account is suspended. You can send offers after the suspension ends.'; code = 'ACCOUNT_SUSPENDED'; }
  else if (!user.isActive || user.moderationStatus !== 'ACTIVE') reason = 'Your account is inactive. Restore your account before sending offers.';
  else if (!user.emailVerified) { reason = 'Verify your email address before sending an offer.'; code = 'EMAIL_NOT_VERIFIED'; }
  else if (user.verificationStatus !== 'APPROVED') {
    reason = user.verificationStatus === 'PENDING_REVIEW'
      ? 'Your identity and residency verification is under review. Wait for approval before sending an offer.'
      : 'Complete identity and residency verification before sending an offer.';
    code = 'VERIFICATION_REQUIRED';
  }
  if (reason) throw Object.assign(new Error(participant === 'provider' ? reason : 'The seeker is no longer eligible to receive offers. Choose another request.'), { status: 403, code: participant === 'provider' ? code : 'SEEKER_UNAVAILABLE' });
}

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { applyTrustEventInTransaction } from '../services/trust.service';
import { lockBookingLifecycle } from '../services/booking-lifecycle.service';
import { safeEmit } from '../lib/socket';
import { invalidateReviewSummaries } from '../services/ai.service';

const message = z.string().trim().min(20).max(2000);
export const TrustCaseSchema = z.object({ reviewId: z.string().min(1).optional(), trustEventId: z.string().min(1).optional(), description: message })
  .strict().refine(value => !!value.reviewId !== !!value.trustEventId, 'Select one review or trust penalty');
export const TrustCaseDecisionSchema = z.object({ uphold: z.boolean(), reason: message,
  violation: z.enum(['MANIPULATION', 'HARASSMENT', 'FABRICATED', 'IRRELEVANT', 'OTHER_POLICY']).optional() }).strict();
const fail = (text: string, status = 422) => Object.assign(new Error(text), { status });
const actor = (req: Request) => (req as AuthenticatedRequest).user.id;
const include = { review: { include: { author: { select: { id: true, name: true } }, target: { select: { id: true, name: true } }, completedService: { select: { bookingId: true } } } },
  trustEvent: true, user: { select: { id: true, name: true } }, respondent: { select: { id: true, name: true } } } as const;

export async function submitTrustCase(req: Request, res: Response, next: NextFunction) {
  try {
    const input = TrustCaseSchema.parse(req.body); const userId = actor(req);
    const item = await prisma.$transaction(async tx => {
      const review = input.reviewId ? await tx.review.findUnique({ where: { id: input.reviewId } }) : null;
      const event = input.trustEventId ? await tx.trustScoreEvent.findUnique({ where: { id: input.trustEventId }, include: { reversal: true } }) : null;
      if (input.reviewId && (!review || review.targetId !== userId || review.visibility !== 'VISIBLE')) throw fail('Only the recipient can dispute a visible review', 403);
      if (input.trustEventId && (!event || event.userId !== userId || event.reversal || !['REPORT_PENALTY', 'CANCELLATION_PENALTY'].includes(event.category))) throw fail('Select an uncorrected penalty on your own account', 403);
      const prior = await tx.trustCase.findFirst({ where: input.reviewId ? { reviewId: input.reviewId } : { trustEventId: input.trustEventId } });
      if (prior) throw fail('A case has already been submitted for this review or penalty', 409);
      const created = await tx.trustCase.create({ data: { ...input, userId, respondentId: review?.authorId } });
      if (review) await tx.notification.create({ data: { userId: review.authorId, title: 'Review disputed',
        body: 'The recipient reported a possible review policy violation. You can explain your experience in Trust History.', link: '/seeker/user-profile?tab=trust' } });
      return created;
    });
    safeEmit('admin', 'ADMIN_MODERATION_CHANGED', { trustCaseId: item.id });
    res.status(201).json({ success: true, data: item });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return res.status(409).json({ success: false, error: 'A case already exists for this source' });
    next(error);
  }
}

export async function listTrustCases(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user.role === 'admin';
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1)); const limit = admin ? 12 : 50;
    const where = admin ? {} : { OR: [{ userId: actor(req) }, { respondentId: actor(req) }] };
    const [items, total] = await Promise.all([prisma.trustCase.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: (page - 1) * limit }), prisma.trustCase.count({ where })]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: items, pagination: { page, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
}

export async function respondToTrustCase(req: Request, res: Response, next: NextFunction) {
  try {
    const input = z.object({ response: message }).strict().parse(req.body);
    const result = await prisma.trustCase.updateMany({ where: { id: req.params.id as string, respondentId: actor(req), status: 'PENDING' }, data: input });
    if (!result.count) throw fail('Only the other participant can respond to a pending review dispute', 403);
    res.json({ success: true });
  } catch (error) { next(error); }
}

export async function decideTrustCase(req: Request, res: Response, next: NextFunction) {
  try {
    const input = TrustCaseDecisionSchema.parse(req.body); const adminId = actor(req);
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`trust-case:${req.params.id as string}`}))::text`;
      const item = await tx.trustCase.findUnique({ where: { id: req.params.id as string }, include });
      if (!item) throw fail('Case not found', 404);
      if (item.status !== 'PENDING') throw fail('This case has already been decided', 409);
      if ([item.userId, item.respondentId].includes(adminId)) throw fail('An administrator cannot decide their own case', 403);
      if (item.trustEvent?.actorAdminId === adminId && await tx.user.count({ where: { id: { not: adminId }, role: 'admin', isActive: true, moderationStatus: 'ACTIVE' } })) {
        throw fail('Another active administrator must review an appeal against your finding', 403);
      }
      let changedTrust = false;
      if (input.uphold && item.review) {
        if (!input.violation) throw fail('Identify a review policy violation; disagreement with a rating is not sufficient');
        if (!item.response && item.createdAt.getTime() > Date.now() - 48 * 3600000) throw fail('Give the review author 48 hours to respond before upholding this dispute', 409);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`review:${item.review.id}`}))::text`;
        await tx.review.update({ where: { id: item.review.id }, data: { visibility: 'HIDDEN', moderationReason: `${input.violation}: ${input.reason}`, moderatedById: adminId, moderatedAt: new Date(), contentVersion: { increment: 1 } } });
      }
      if (input.uphold && item.trustEvent) {
        const original = item.trustEvent;
        if (original.bookingId) await lockBookingLifecycle(tx, original.bookingId);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`trust:${item.userId}`}))::text`;
        const already = await tx.trustScoreEvent.findUnique({ where: { reversesEventId: original.id } });
        if (!already) {
          const reversal = await applyTrustEventInTransaction(tx, { userId: item.userId, delta: -original.delta,
            reason: `Penalty appeal upheld: ${input.reason}`, actorAdminId: adminId, category: 'CORRECTION',
            reversesEventId: original.id, bookingId: original.bookingId ?? undefined, eventKey: `trust-appeal:${item.id}` });
          changedTrust = reversal.applied;
        }
      }
      const decided = await tx.trustCase.update({ where: { id: item.id }, data: { status: input.uphold ? 'UPHELD' : 'REJECTED', adminId, decisionReason: input.reason, decidedAt: new Date() } });
      await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: item.userId, action: 'TRUST_CASE_DECIDED', resourceType: 'TrustCase', resourceId: item.id, reason: input.reason,
        metadata: { upheld: input.uphold, violation: input.violation, originalEventId: item.trustEventId, sameAdministrator: item.trustEvent?.actorAdminId === adminId } } });
      await tx.notification.createMany({ data: [item.userId, item.respondentId].filter((id): id is string => !!id).map(userId => ({ userId, title: 'Review or trust appeal decided', body: input.reason, link: '/seeker/user-profile?tab=trust' })) });
      return { decided, changedTrust, targetId: item.review?.targetId };
    });
    if (result.targetId) invalidateReviewSummaries(result.targetId);
    safeEmit(`user:${result.decided.userId}`, 'accountStatusChanged', { trustChanged: result.changedTrust });
    res.json({ success: true, data: result.decided });
  } catch (error) { next(error); }
}

export async function respondToReview(req: Request, res: Response, next: NextFunction) {
  try {
    const input = z.object({ response: z.string().trim().min(10).max(1000) }).strict().parse(req.body);
    const result = await prisma.review.updateMany({ where: { id: req.params.id as string, targetId: actor(req), visibility: 'VISIBLE' }, data: { ...input, respondedAt: new Date() } });
    if (!result.count) throw fail('Only the recipient can respond to a visible review', 403);
    res.json({ success: true });
  } catch (error) { next(error); }
}

export async function listTrustCorrections(req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await prisma.trustScoreEvent.findMany({ where: { userId: req.params.id as string,
      delta: { not: 0 }, reversesEventId: null, reversal: null,
      category: { notIn: ['POLICY_TRANSITION', 'LEGACY_DUPLICATE_PENALTY', 'REVIEW_LEGACY'] },
      OR: [{ eventKey: null }, { NOT: { OR: [{ eventKey: { startsWith: 'account-baseline:' } }, { eventKey: { startsWith: 'review:' } }] } }],
    }, select: { id: true, delta: true, reason: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
    res.json({ success: true, data: rows });
  } catch (error) { next(error); }
}

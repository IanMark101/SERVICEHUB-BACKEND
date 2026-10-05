import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import type { AuthenticatedRequest } from '../../middlewares/auth.middleware';

export const UserRecordsQuery = z.object({
  kind: z.enum(['trust', 'reviews', 'moderation', 'services', 'requests', 'bookings']),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// Deliberately separate from marketplace profiles: private contact and account
// information is selected only behind the admin router's authorization gates.
export async function getAdminUserProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({ where: { id }, select: {
      id: true, name: true, email: true, phone: true, role: true, avatarUrl: true,
      bio: true, location: true, facebookUrl: true, instagramUrl: true, websiteUrl: true,
      trustScore: true, verificationStatus: true, emailVerified: true, isActive: true,
      moderationStatus: true, suspendedUntil: true, moderationReason: true,
      postingSuspended: true, postingSuspendReason: true, createdAt: true, deactivatedAt: true,
    } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const [completedAsProvider, completedAsSeeker, services, requests, bookings, providerReviews, seekerReviews] = await Promise.all([
      prisma.completedService.count({ where: { providerId: id } }),
      prisma.completedService.count({ where: { seekerId: id } }),
      prisma.service.count({ where: { providerId: id } }),
      prisma.serviceRequest.count({ where: { seekerId: id } }),
      prisma.booking.count({ where: { OR: [{ seekerId: id }, { providerId: id }] } }),
      prisma.review.aggregate({ where: { targetId: id, visibility: 'VISIBLE', completedService: { providerId: id } }, _avg: { rating: true }, _count: true }),
      prisma.review.aggregate({ where: { targetId: id, visibility: 'VISIBLE', completedService: { seekerId: id } }, _avg: { rating: true }, _count: true }),
    ]);
    await prisma.adminAuditLog.create({ data: {
      actorId: (req as AuthenticatedRequest).user.id, targetUserId: id, action: 'USER_PROFILE_VIEWED',
      resourceType: 'User', resourceId: id, reason: 'Administrator viewed account details from User Management',
    } });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, data: { user, activity: { completedAsProvider, completedAsSeeker, services, requests, bookings },
      ratings: { provider: { average: providerReviews._avg.rating, count: providerReviews._count }, seeker: { average: seekerReviews._avg.rating, count: seekerReviews._count } } } });
  } catch (error) { next(error); }
}

export async function getAdminUserRecords(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as string;
    const { kind, page, limit } = UserRecordsQuery.parse(req.query);
    if (!await prisma.user.findUnique({ where: { id }, select: { id: true } })) return res.status(404).json({ success: false, error: 'User not found' });
    const paging = { skip: (page - 1) * limit, take: limit, orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }] };
    let data: unknown[] = [], total = 0;
    if (kind === 'trust') {
      const where = { userId: id };
      const [rows, count] = await Promise.all([
        prisma.trustScoreEvent.findMany({ where, ...paging, select: { id: true, reason: true, delta: true, scoreBefore: true, scoreAfter: true, createdAt: true, actorAdmin: { select: { name: true } } } }), prisma.trustScoreEvent.count({ where }),
      ]);
      total = count; data = rows.map(row => ({ id: row.id, title: row.reason, createdAt: row.createdAt, delta: row.delta, scoreBefore: row.scoreBefore, scoreAfter: row.scoreAfter, actorName: row.actorAdmin?.name }));
    } else if (kind === 'reviews') {
      const where = { targetId: id };
      const [rows, count] = await Promise.all([
        prisma.review.findMany({ where, ...paging, select: { id: true, text: true, rating: true, visibility: true, moderationReason: true, createdAt: true, author: { select: { name: true } }, completedService: { select: { providerId: true } } } }), prisma.review.count({ where }),
      ]);
      total = count; data = rows.map(row => ({ id: row.id, title: row.author.name, description: row.text, rating: row.rating, status: row.visibility, moderationReason: row.moderationReason, createdAt: row.createdAt, reviewContext: row.completedService.providerId === id ? 'Provider' : 'Seeker' }));
    } else if (kind === 'moderation') {
      const where = { action: { not: 'USER_PROFILE_VIEWED' }, OR: [{ targetUserId: id }, { resourceType: 'User', resourceId: id }] };
      const [rows, count] = await Promise.all([
        prisma.adminAuditLog.findMany({ where, ...paging, select: { id: true, action: true, reason: true, createdAt: true, actor: { select: { name: true } } } }), prisma.adminAuditLog.count({ where }),
      ]);
      total = count; data = rows.map(row => ({ id: row.id, title: row.action.replaceAll('_', ' '), description: row.reason, createdAt: row.createdAt, actorName: row.actor.name }));
    } else if (kind === 'services') {
      const where = { providerId: id };
      const [rows, count] = await Promise.all([
        prisma.service.findMany({ where, ...paging, select: { id: true, title: true, status: true, createdAt: true } }), prisma.service.count({ where }),
      ]);
      total = count; data = rows.map(row => ({ ...row, link: `/admin/content-cases?view=content&type=SERVICE_LISTING&contentId=${encodeURIComponent(row.id)}` }));
    } else if (kind === 'requests') {
      const where = { seekerId: id };
      const [rows, count] = await Promise.all([
        prisma.serviceRequest.findMany({ where, ...paging, select: { id: true, title: true, status: true, targetServiceId: true, createdAt: true } }), prisma.serviceRequest.count({ where }),
      ]);
      total = count; data = rows.map(row => ({ id: row.id, title: row.title, status: row.status, createdAt: row.createdAt, description: row.targetServiceId ? 'Private booking inquiry. Review through related bookings.' : undefined,
        link: row.targetServiceId ? `/admin/reports?userId=${encodeURIComponent(id)}` : `/admin/content-cases?view=content&type=SERVICE_REQUEST&contentId=${encodeURIComponent(row.id)}` }));
    } else {
      const where = { OR: [{ seekerId: id }, { providerId: id }] };
      const [rows, count] = await Promise.all([
        prisma.booking.findMany({ where, ...paging, select: { id: true, status: true, paymentMethod: true, paymentStatus: true, agreedAmount: true, createdAt: true, seekerId: true,
          service: { select: { title: true } }, offer: { select: { request: { select: { title: true } } } }, directRequest: { select: { service: { select: { title: true } } } } } }), prisma.booking.count({ where }),
      ]);
      total = count; data = rows.map(row => ({ id: row.id, title: row.service?.title || row.offer?.request.title || row.directRequest?.service.title || 'Service engagement', status: row.status, createdAt: row.createdAt,
        description: `${row.seekerId === id ? 'Seeker' : 'Provider'} · ${row.paymentMethod} · ${row.paymentStatus.replaceAll('_', ' ')}`, amount: Number(row.agreedAmount || 0), link: `/admin/reports?userId=${encodeURIComponent(id)}&bookingId=${encodeURIComponent(row.id)}` }));
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
}

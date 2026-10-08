import { Prisma } from '@prisma/client';
import type { ReviewContext } from './review-summary';

/** Shared by profile reviews, request-card ratings and digests. Queries must join reviews r,
 * completed_services cs, and (optionally) bookings b with these aliases. */
export function reviewEligibilitySql(userId: string | Prisma.Sql, context?: ReviewContext) {
  const asProvider = Prisma.sql`cs."providerId" = ${userId} AND r."authorId" = cs."seekerId"`;
  const asSeeker = Prisma.sql`cs."seekerId" = ${userId} AND r."authorId" = cs."providerId"`;
  const participant = context === 'provider' ? asProvider : context === 'seeker' ? asSeeker
    : Prisma.sql`((${asProvider}) OR (${asSeeker}))`;
  return Prisma.sql`r."targetId" = ${userId} AND r.visibility = 'VISIBLE'
    AND r.rating BETWEEN 1 AND 5 AND cs."seekerId" <> cs."providerId"
    AND (${participant}) AND (cs."bookingId" IS NULL OR (b.status = 'COMPLETED'
      AND b."seekerId" = cs."seekerId" AND b."providerId" = cs."providerId"))`;
}

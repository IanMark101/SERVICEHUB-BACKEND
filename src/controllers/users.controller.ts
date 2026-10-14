import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { MemberSearchSchema, UpdateOnboardingStatusSchema } from "../schema/users.schema";
import { memberDirectoryWhere } from "../services/member-directory.service";

// ── GET /users ──────────────────────────────────────────────────────────────
export async function searchUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const { search, page: pageNum, limit: limitNum } = MemberSearchSchema.parse(req.query);
    const skip = (pageNum - 1) * limitNum;

    const where = memberDirectoryWhere(search);

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          location: true,
          bio: true,
          role: true,
          trustScore: true,
          verificationStatus: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /users/me/onboarding
// Reopening the tour does not reset this durable preference.
export async function updateOnboardingStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { status } = UpdateOnboardingStatusSchema.parse(req.body);
    const userId = (req as AuthenticatedRequest).user.id;
    const user = await prisma.user.update({
      where: { id: userId },
      data: { onboardingStatus: status },
      select: { onboardingStatus: true },
    });

    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
}

import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

// ── GET /users ──────────────────────────────────────────────────────────────
export async function searchUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const { search, role, page = "1", limit = "10" } = req.query;
    const pageNum = Math.max(1, Math.min(10_000, parseInt(page as string, 10) || 1));
    const limitNum = Math.max(1, Math.min(50, parseInt(limit as string, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { isActive: true };

    if (search) {
      const q = search as string;
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { location: { contains: q, mode: "insensitive" } },
        { bio: { contains: q, mode: "insensitive" } },
      ];
    }

    if (role) {
      where.role = role as string;
    }

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

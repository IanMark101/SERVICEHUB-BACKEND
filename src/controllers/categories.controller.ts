import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

// ── GET /categories ───────────────────────────────────────────────────────────
export async function getCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    const cats = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });

    res.json({ success: true, data: cats });
  } catch (err) {
    next(err);
  }
}

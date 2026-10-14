import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { officialCategoryForName } from '../lib/category-catalog';

// ── GET /categories ───────────────────────────────────────────────────────────
export async function getCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    const cats = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
    });

    res.json({ success: true, data: cats.map(category => {
      const family = officialCategoryForName(category.name);
      return { ...category, description: family?.examples, aliases: family?.aliases ?? [] };
    }) });
  } catch (err) {
    next(err);
  }
}

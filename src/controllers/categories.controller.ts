import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";
import { CategorySuggestionSchema } from "../schema/marketplace.schema";

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

// ── POST /categories/suggest ──────────────────────────────────────────────────
export async function suggestCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, description } = CategorySuggestionSchema.parse(req.body);
    const suggestion = await prisma.categorySuggested.create({
      data: {
        submitterId: (req as AuthenticatedRequest).user.id,
        name,
        description,
        status: "PENDING",
      },
    });
    res.status(201).json({ success: true, data: suggestion });
  } catch (err) {
    next(err);
  }
}

// ── GET /categories/suggestions/mine ──────────────────────────────────────────
export async function getMySuggestions(req: Request, res: Response, next: NextFunction) {
  try {
    const suggestions = await prisma.categorySuggested.findMany({
      where: { submitterId: (req as AuthenticatedRequest).user.id },
      orderBy: { submittedAt: "desc" },
    });
    res.json({ success: true, data: suggestions });
  } catch (err) {
    next(err);
  }
}

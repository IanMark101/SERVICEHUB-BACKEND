import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { listAdminPublicRequests, removePublicRequest } from "../../services/admin-request-moderation.service";

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const Removal = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

export async function listPublicRequestContent(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit } = ListQuery.parse(req.query);
    const result = await listAdminPublicRequests(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) { next(error); }
}

export async function removeRequestContent(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = Removal.parse(req.body);
    const request = await removePublicRequest(req.params.id as string, (req as AuthenticatedRequest).user.id, reason);
    res.json({ success: true, data: request });
  } catch (error) { next(error); }
}

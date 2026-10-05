import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { ContentDecisionSchema, ContentWorkspaceQuery } from "../../schema/content-workspace.schema";
import { changeWorkspaceContent, decideWorkspaceCase, getWorkspaceCase, listWorkspaceCases, listWorkspaceContent, readPublicContent } from "../../services/content-workspace.service";
import { prisma } from "../../lib/prisma";

const Id = z.string().cuid();
const Type = z.enum(["SERVICE_LISTING", "SERVICE_REQUEST"]);
const Action = z.object({ action: z.enum(["REMOVE", "RESTORE"]), reason: z.string().trim().min(10).max(1000), expectedUpdatedAt: z.string().datetime() }).strict();

export async function listCases(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await listWorkspaceCases(ContentWorkspaceQuery.parse(req.query));
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) { next(error); }
}

export async function resolveCase(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await decideWorkspaceCase(Id.parse(req.params.id), (req as AuthenticatedRequest).user.id, ContentDecisionSchema.parse(req.body));
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}

export async function getContentCase(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await getWorkspaceCase(Id.parse(req.params.id)) }); }
  catch (error) { next(error); }
}
export async function listMarketplaceContent(req: Request, res: Response, next: NextFunction) {
  try { const result = await listWorkspaceContent(ContentWorkspaceQuery.parse(req.query)); res.json({ success: true, data: result.items, pagination: result.pagination }); }
  catch (error) { next(error); }
}
export async function getMarketplaceContent(req: Request, res: Response, next: NextFunction) {
  try { const item = await readPublicContent(prisma, Type.parse(req.params.type), Id.parse(req.params.id)); if (!item) return res.status(404).json({ success: false, message: "Content not found." }); res.json({ success: true, data: item }); }
  catch (error) { next(error); }
}
export async function actOnMarketplaceContent(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await changeWorkspaceContent(Type.parse(req.params.type), Id.parse(req.params.id), (req as AuthenticatedRequest).user.id, Action.parse(req.body)) }); }
  catch (error) { next(error); }
}

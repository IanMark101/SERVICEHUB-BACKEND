import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { disconnectUserSockets } from "../../lib/socket";
import { FinalizeAccountDeletionSchema } from "../../schema/marketplace.schema";
import { getUserActiveCaseCounts } from "../../services/data-retention.service";

export async function listAccountDeletionRequests(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const where = status ? { status: status as never } : {};
    const [items, total] = await Promise.all([
      prisma.accountDeletionRequest.findMany({ where, include: { user: { select: { id: true, name: true, email: true, isActive: true } } }, orderBy: { requestedAt: "asc" }, skip: (page - 1) * limit, take: limit }),
      prisma.accountDeletionRequest.count({ where }),
    ]);
    res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}

export async function finalizeAccountDeletion(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = FinalizeAccountDeletionSchema.parse(req.body);
    const adminId = (req as AuthenticatedRequest).user.id;
    const targetId = req.params.userId as string;
    if (adminId === targetId) return res.status(409).json({ success: false, error: "Administrators cannot deactivate themselves" });
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-deletion:${targetId}`}))`;
      const request = await tx.accountDeletionRequest.findUnique({ where: { userId: targetId }, include: { user: true } });
      if (!request || request.status !== "PENDING") {
        const error = new Error("An eligible pending deletion request is required") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      if (request.user.role === "admin") {
        const error = new Error("Administrator accounts require a separate governance process") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      const blockers = await getUserActiveCaseCounts(tx, targetId);
      if (Object.values(blockers).some((count) => count > 0)) {
        await tx.accountDeletionRequest.update({ where: { userId: targetId }, data: { status: "BLOCKED", blockers } });
        return { blocked: true };
      }
      await tx.user.update({ where: { id: targetId }, data: { isActive: false, deactivatedAt: new Date() } });
      await tx.refreshToken.deleteMany({ where: { userId: targetId } });
      await tx.accountDeletionRequest.update({ where: { userId: targetId }, data: { status: "COMPLETED", blockers: [], completedAt: new Date() } });
      await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: targetId, action: "ACCOUNT_DEACTIVATED", resourceType: "User", resourceId: targetId, reason, metadata: { recordsRetained: true } } });
      return { blocked: false };
    });
    if (outcome.blocked) return res.status(409).json({ success: false, error: "Account deletion is blocked by active marketplace or moderation obligations" });
    await disconnectUserSockets(targetId, "Your account deletion request was completed.");
    res.json({ success: true, message: "Account deactivated; required transaction, moderation, and audit records were retained" });
  } catch (error) {
    next(error);
  }
}

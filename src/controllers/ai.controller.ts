import type { Request, Response, NextFunction } from "express";
import { summarizeProviderReviews, matchProvidersToRequest } from "../services/ai.service";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { AiMatchSchema } from "../schema/marketplace.schema";

export async function getProviderSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId } = req.params;
    const { serviceId, fast } = req.query;
    const result = await summarizeProviderReviews(
      providerId as string,
      serviceId as string | undefined,
      true,
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function matchProviders(req: Request, res: Response, next: NextFunction) {
  try {
    const { requestId } = AiMatchSchema.parse(req.body);

    const result = await matchProvidersToRequest(requestId, (req as AuthenticatedRequest).user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

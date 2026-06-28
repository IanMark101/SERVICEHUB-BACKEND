import type { Request, Response, NextFunction } from "express";
import { summarizeProviderReviews, matchProvidersToRequest } from "../services/ai.service";

export async function getProviderSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId } = req.params;
    const result = await summarizeProviderReviews(providerId as string);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function matchProviders(req: Request, res: Response, next: NextFunction) {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ success: false, error: "Missing requestId" });
    }

    const result = await matchProvidersToRequest(requestId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

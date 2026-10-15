import { suggestCategories, CategorySuggestionSchema, RequestMatchesSchema, matchRequestsToService } from '../services/ai-marketplace.service';
import type { Request, Response, NextFunction } from "express";
import { summarizeProviderReviews, summarizeSeekerReviews, matchProvidersToRequest } from "../services/ai.service";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { AiMatchSchema } from "../schema/marketplace.schema";
import { assertMemberProfile } from "../services/member-directory.service";

export async function getProviderSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId } = req.params;
    await assertMemberProfile(providerId as string);
    const { serviceId, fast } = req.query;
    const result = await summarizeProviderReviews(
      providerId as string,
      serviceId as string | undefined,
      fast === '1',
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getSeekerSummary(req: Request, res: Response, next: NextFunction) {
  try {
    await assertMemberProfile(req.params.seekerId as string);
    const result = await summarizeSeekerReviews(req.params.seekerId as string, req.query.fast === '1');
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

export async function categorySuggestions(req:Request,res:Response,next:NextFunction) {
  try {res.json({success:true,data:await suggestCategories(CategorySuggestionSchema.parse(req.body),(req as AuthenticatedRequest).user.id)});}catch(error){next(error);}
}
export async function matchRequests(req:Request,res:Response,next:NextFunction) {
  try {const {serviceId}=RequestMatchesSchema.parse(req.body);res.json({success:true,data:await matchRequestsToService(serviceId,(req as AuthenticatedRequest).user.id)});}catch(error){next(error);}
}

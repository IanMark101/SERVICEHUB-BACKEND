import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { SavedListingParamsSchema, SavedListingsQuerySchema, SavedListingStatusSchema } from '../schema/saved-listings.schema';
import { getSavedListings, getSavedListingStatus, saveListing, unsaveListing } from '../services/saved-listings.service';

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { contentType, page, limit } = SavedListingsQuerySchema.parse(req.query);
    res.json({ success: true, data: await getSavedListings((req as AuthenticatedRequest).user.id, contentType, page, limit) });
  } catch (error) { next(error); }
}
export async function status(req: Request, res: Response, next: NextFunction) {
  try {
    const { contentType, ids } = SavedListingStatusSchema.parse(req.query);
    res.json({ success: true, data: await getSavedListingStatus((req as AuthenticatedRequest).user.id, contentType, ids) });
  } catch (error) { next(error); }
}
export async function save(req: Request, res: Response, next: NextFunction) {
  try {
    const { contentType, listingId } = SavedListingParamsSchema.parse(req.params);
    await saveListing((req as AuthenticatedRequest).user.id, contentType, listingId);
    res.json({ success: true, data: { listingId, saved: true } });
  } catch (error) { next(error); }
}
export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { contentType, listingId } = SavedListingParamsSchema.parse(req.params);
    await unsaveListing((req as AuthenticatedRequest).user.id, contentType, listingId);
    res.json({ success: true, data: { listingId, saved: false } });
  } catch (error) { next(error); }
}

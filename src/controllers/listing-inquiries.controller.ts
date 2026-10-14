import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { createListingInquiry, declineListingInquiry } from '../services/listing-inquiries.service';

export async function createInquiry(req: Request, res: Response, next: NextFunction) {
  try { res.status(201).json({ success: true, data: await createListingInquiry((req as AuthenticatedRequest).user.id, req.body) }); }
  catch (error) { next(error); }
}
export async function declineInquiry(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await declineListingInquiry((req as AuthenticatedRequest).user.id, req.params.id as string) }); }
  catch (error) { next(error); }
}

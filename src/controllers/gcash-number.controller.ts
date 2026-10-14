import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { getOwnGCashNumber, updateOwnGCashNumber } from '../services/auth/gcash-number.service';

export async function getGCashNumber(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ success: true, data: await getOwnGCashNumber((req as AuthenticatedRequest).user.id) });
  } catch (error) { next(error); }
}

export async function putGCashNumber(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const auth = req as AuthenticatedRequest;
    const data = await updateOwnGCashNumber(auth.user.id, auth.sessionId, req.body);
    res.json({ success: true, data });
  } catch (error) { next(error); }
}

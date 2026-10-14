import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from './auth.middleware';
import { securityContext } from '../lib/security-context';
import { recordSecurityEvent, type SecurityAction } from '../services/security-history.service';

const actions: Record<string, [SecurityAction, string]> = {
  '/api/services': ['SERVICE_PUBLISHED', 'Published a service listing'],
  '/api/requests': ['REQUEST_PUBLISHED', 'Published a service request'],
  '/api/offers': ['OFFER_SENT', 'Sent an offer'],
  '/api/bookings/direct': ['BOOKING_REQUESTED', 'Requested a service booking'],
  '/api/bookings/direct-from-offer': ['BOOKING_CREATED', 'Accepted an offer and created a booking'],
};

export function securityActivity(req: Request, res: Response, next: NextFunction) {
  const action = req.method === 'POST' ? actions[req.path.replace(/\/$/, '')] : undefined;
  if (action) {
    const context = securityContext(req, res);
    res.once('finish', () => {
      const { user, sessionId } = req as AuthenticatedRequest;
      if (res.statusCode >= 200 && res.statusCode < 300 && user?.id && sessionId) void recordSecurityEvent(context, user.id, action[0], action[1], undefined, sessionId);
    });
  }
  next();
}

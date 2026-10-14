import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { sessionReference, type SecurityContext } from '../lib/security-context';
import { logger } from '../utils/logger';

export type SecurityAction = 'SIGN_IN_SUCCESS' | 'SIGN_IN_FAILED' | 'SIGN_OUT' | 'SERVICE_PUBLISHED' | 'REQUEST_PUBLISHED' | 'BOOKING_REQUESTED' | 'BOOKING_CREATED' | 'OFFER_SENT';

export function securityEventData(context: SecurityContext, userId: string | null, action: SecurityAction, reason: string, method?: 'PASSWORD' | 'GOOGLE' | 'REGISTRATION', sessionId?: string) {
  return { ...context, userId, action, reason, method, sessionReference: sessionReference(sessionId) };
}

// Denied sign-ins and post-response action records must not change the public
// response or expose whether an account exists. Successful sign-ins are atomic
// with session creation in authentication.service instead.
export async function recordSecurityEvent(context: SecurityContext | undefined, userId: string | null, action: SecurityAction, reason: string, method?: 'PASSWORD' | 'GOOGLE' | 'REGISTRATION', sessionId?: string) {
  if (!context) return;
  try {
    await prisma.securityEvent.create({ data: securityEventData(context, userId, action, reason, method, sessionId) });
  } catch {
    // No IP, email, token, password, user-agent, or request body in server logs.
    logger.error('security_history_write_failed', { action, requestId: context.requestId ?? undefined });
  }
}

export function securityHistoryCutoff(now = new Date()) {
  return new Date(now.getTime() - env.SECURITY_LOG_RETENTION_DAYS * 86_400_000);
}

export async function pruneSecurityHistory() {
  return prisma.securityEvent.deleteMany({ where: { createdAt: { lt: securityHistoryCutoff() } } });
}

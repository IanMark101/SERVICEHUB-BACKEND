type ErrorDetails = { name?: string; code?: string; message?: string };

function detailsOf(value: unknown, depth = 0): ErrorDetails[] {
  if (!value || typeof value !== 'object' || depth > 3) return [];
  const record = value as Record<string, unknown>;
  const detail: ErrorDetails = {};
  for (const key of ['name', 'code', 'message'] as const) {
    if (typeof record[key] === 'string') detail[key] = record[key];
  }
  return [detail, ...['meta', 'cause', 'driverAdapterError', 'originalError']
    .flatMap(key => detailsOf(record[key], depth + 1))];
}

const connectionCodes = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01', '53000', '53300', '53400', '57P01', '57P02', '57P03']);

/** Database outages must not look like expired user sessions or expose queries. */
export function getDatabaseAvailabilityError(error: unknown) {
  const details = detailsOf(error);
  const databaseError = details.some(detail => detail.name?.startsWith('PrismaClient')
    || (detail.code && connectionCodes.has(detail.code)));
  if (!databaseError) return null;
  const quotaExceeded = details.some(detail => detail.message
    && /\b(?:exceeded|exhausted)\b[^\n]*\bquota\b|\bquota\b[^\n]*\b(?:exceeded|exhausted)\b/i.test(detail.message));
  if (!quotaExceeded && !details.some(detail => detail.code && connectionCodes.has(detail.code))) return null;
  return {
    status: 503,
    code: quotaExceeded ? 'DATABASE_QUOTA_EXCEEDED' : 'DATABASE_UNAVAILABLE',
    error: 'ServiceHub is temporarily unavailable. Please try again later.',
  } as const;
}

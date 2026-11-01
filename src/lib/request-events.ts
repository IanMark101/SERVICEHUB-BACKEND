import { safeBroadcast } from './socket';

/** Contents must be fetched through the viewer-authorized request endpoint.
 * Global invalidations also reach expired providers who still need booking chat. */
export function publishPublicRequestChange(event: 'CREATED' | 'UPDATED', request: { id: string; status: string }) {
  const change = { id: request.id, status: request.status };
  safeBroadcast(`SERVICE_REQUEST_${event}`, change);
  safeBroadcast('SERVICE_REQUESTS_CHANGED', change);
}

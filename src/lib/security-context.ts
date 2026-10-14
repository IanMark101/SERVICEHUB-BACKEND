import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { Request, Response } from 'express';
import geoip from 'geoip-lite';

export interface SecurityContext {
  ipAddress: string | null;
  locationStatus: 'APPROXIMATE' | 'LOCAL_NETWORK' | 'UNAVAILABLE';
  city: string | null;
  region: string | null;
  country: string | null;
  browser: string;
  device: string;
  userAgent: string | null;
  requestId: string | null;
}

const localNetworks = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) localNetworks.addSubnet(address, prefix, 'ipv4');
localNetworks.addAddress('::', 'ipv6');
localNetworks.addAddress('::1', 'ipv6');
localNetworks.addSubnet('fc00::', 7, 'ipv6');
localNetworks.addSubnet('fe80::', 10, 'ipv6');

export function safeText(value: unknown, length: number): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, length) || null;
}

export function normalizeClientIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (/^::ffff:/i.test(ip) && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

export function sessionReference(sessionId?: string): string | null {
  return sessionId ? createHash('sha256').update(`security-session:${sessionId}`).digest('hex') : null;
}

export function describeClient(userAgent: string | null) {
  const ua = userAgent || '';
  const browser = /Edg(?:e|A|iOS)?\//.test(ua) ? 'Microsoft Edge'
    : /(?:OPR|Opera)\//.test(ua) ? 'Opera'
    : /(?:Firefox|FxiOS)\//.test(ua) ? 'Firefox'
    : /(?:Chrome|CriOS)\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Unknown browser';
  const device = /iPad/.test(ua) ? 'iPad' : /iPhone|iPod/.test(ua) ? 'iPhone'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  return { browser, device };
}

export function resolveIpArea(ipAddress: string | null, lookup: typeof geoip.lookup = geoip.lookup): Pick<SecurityContext, 'locationStatus' | 'city' | 'region' | 'country'> {
  const empty = { city: null, region: null, country: null };
  if (!ipAddress) return { ...empty, locationStatus: 'UNAVAILABLE' };
  if (localNetworks.check(ipAddress, isIP(ipAddress) === 4 ? 'ipv4' : 'ipv6')) return { ...empty, locationStatus: 'LOCAL_NETWORK' };
  try {
    const area = lookup(ipAddress);
    if (!area?.country) return { ...empty, locationStatus: 'UNAVAILABLE' };
    // Deliberately discard latitude/longitude, postcode, and accuracy coordinates.
    return { locationStatus: 'APPROXIMATE', city: safeText(area.city, 100), region: safeText(area.region, 100), country: safeText(area.country, 2) };
  } catch {
    return { ...empty, locationStatus: 'UNAVAILABLE' };
  }
}

export function securityContext(req: Request, res: Response): SecurityContext {
  // Express resolves this using the configured trusted proxy CIDRs. Do not read
  // X-Forwarded-For, client-supplied coordinates, or the account's profile area.
  const ipAddress = normalizeClientIp(req.ip || req.socket?.remoteAddress);
  const userAgent = safeText(req.get('user-agent'), 500);
  return { ipAddress, ...resolveIpArea(ipAddress), userAgent, ...describeClient(userAgent), requestId: safeText(res.locals.requestId, 100) };
}

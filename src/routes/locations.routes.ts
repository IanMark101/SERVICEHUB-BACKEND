import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, requireMarketplaceUser } from '../middlewares/auth.middleware';

const router = Router();
const SearchSchema = z.object({ q: z.string().trim().min(3).max(80) }).strict();
type Place = { latitude: number; longitude: number; label: string };
const cache = new Map<string, { expires: number; places: Place[] }>();
const pending = new Map<string, Promise<Place[]>>();
let lastRequest = 0;
let chain: Promise<unknown> = Promise.resolve();

// Explicit locality searches only: no autocomplete, reverse lookup, or private addresses.
// Single-process development limiter meets the public Nominatim 1 request/second limit.
async function searchPlaces(q: string) {
  const key = q.toLocaleLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.places;
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 10) throw Object.assign(new Error('Location search is busy. Try again shortly, or select a pin on the map.'), { status: 429 });
  const work = chain.catch(() => undefined).then(async () => {
    const delay = Math.max(0, 1100 - (Date.now() - lastRequest));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequest = Date.now();
    const url = new URL(process.env.LOCATION_SEARCH_URL || 'https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', countrycodes: 'ph', limit: '5', 'accept-language': 'en' }).toString();
    const response = await fetch(url, { headers: { 'User-Agent': process.env.LOCATION_SEARCH_USER_AGENT || 'ServiceHub-ProximityDevelopment/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Object.assign(new Error('Location search is unavailable. You can still select a pin on the map.'), { status: 503 });
    const raw = await response.json() as Array<{ lat: string; lon: string; address?: Record<string, string>; display_name: string }>;
    if (!Array.isArray(raw)) throw Object.assign(new Error('Location search is unavailable. Select a pin on the map instead.'), { status:503 });
    const places = raw.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const latitude = Number(item.lat), longitude = Number(item.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
      const a = item.address || {};
      const label = [...new Set([a.suburb || a.village || a.neighbourhood, a.city || a.town || a.municipality, a.state || a.province].filter(Boolean))].join(', ') || item.display_name;
      if (typeof label !== 'string' || label.trim().length < 2) return [];
      return [{ latitude, longitude, label: label.trim().slice(0, 160) }];
    });
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 86400000, places });
    return places;
  });
  pending.set(key, work);
  chain = work;
  return work.finally(() => pending.delete(key));
}

router.get('/search', requireAuth, requireMarketplaceUser,
  rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }),
  async (req, res, next) => {
    try {
      const parsed = SearchSchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ success:false, error:'Enter a city or barangay name between 3 and 80 characters.' });
      const { q } = parsed.data;
      res.json({ success: true, data: await searchPlaces(q), attribution: '© OpenStreetMap contributors' });
    } catch (error) { next(error); }
  });
export default router;

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, requireMarketplaceUser } from '../middlewares/auth.middleware';
import { localityLabel } from '../lib/place-label';

const router = Router();
const SearchSchema = z.object({ q: z.string().trim().min(3).max(80) }).strict();
const ReverseSchema = z.object({ latitude:z.coerce.number().finite().min(-90).max(90), longitude:z.coerce.number().finite().min(-180).max(180) }).strict();
type Place = { latitude: number; longitude: number; label: string };
const cache = new Map<string, { expires: number; places: Place[] }>();
const pending = new Map<string, Promise<Place[]>>();
let lastRequest = 0;
let chain: Promise<unknown> = Promise.resolve();
const reverseCache = new Map<string, { expires:number; label:string | null }>();
const reversePending = new Map<string, Promise<string | null>>();

// Explicit searches and point selections only; never look up map pans/zoom or private directions.
// Single-process development limiter meets the public Nominatim 1 request/second limit.
async function searchPlaces(q: string) {
  const key = q.toLocaleLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.places;
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size + reversePending.size >= 10) throw Object.assign(new Error('Location search is busy. Try again shortly, or select a pin on the map.'), { status: 429 });
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

const locationLimiter = rateLimit({ windowMs:60000, limit:20, standardHeaders:'draft-8', legacyHeaders:false });
router.use(requireAuth, requireMarketplaceUser, locationLimiter);
router.get('/search',
  async (req, res, next) => {
    try {
      const parsed = SearchSchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ success:false, error:'Enter a city or barangay name between 3 and 80 characters.' });
      const { q } = parsed.data;
      res.json({ success: true, data: await searchPlaces(q), attribution: '© OpenStreetMap contributors' });
    } catch (error) { next(error); }
  });

async function reversePlace(latitude:number, longitude:number) {
  const key = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  const cached = reverseCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.label;
  if (reversePending.has(key)) return reversePending.get(key)!;
  if (pending.size + reversePending.size >= 10) throw Object.assign(new Error('Place lookup is busy. Enter the city or barangay yourself, or try again shortly.'), { status:429 });
  const work = chain.catch(() => undefined).then(async () => {
    const delay = Math.max(0, 1100 - (Date.now() - lastRequest));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastRequest = Date.now();
    const searchUrl = new URL(process.env.LOCATION_SEARCH_URL || 'https://nominatim.openstreetmap.org/search');
    const url = new URL(process.env.LOCATION_REVERSE_URL || 'reverse', searchUrl);
    url.search = new URLSearchParams({ lat:String(latitude), lon:String(longitude), zoom:'14', format:'jsonv2', addressdetails:'1', 'accept-language':'en' }).toString();
    const response = await fetch(url, { headers:{ 'User-Agent':process.env.LOCATION_SEARCH_USER_AGENT || 'ServiceHub-ProximityDevelopment/1.0', Accept:'application/json' }, signal:AbortSignal.timeout(8000) });
    if (!response.ok && response.status !== 404) throw Object.assign(new Error('Place lookup is unavailable. Enter the city or barangay yourself.'), { status:503 });
    const raw = response.status === 404 ? null : await response.json() as { address?:unknown };
    const label = localityLabel(raw?.address);
    if (reverseCache.size >= 500) reverseCache.delete(reverseCache.keys().next().value!);
    reverseCache.set(key, { expires:Date.now() + (label ? 86400000 : 60000), label });
    return label;
  });
  reversePending.set(key, work); chain = work;
  return work.finally(() => reversePending.delete(key));
}

router.get('/reverse', async (req, res, next) => {
  try {
    const input = ReverseSchema.safeParse(req.query);
    if (!input.success) return res.status(400).json({ success:false, error:'Choose a valid point on the map.' });
    const { latitude, longitude } = input.data;
    res.json({ success:true, data:{ label:await reversePlace(latitude, longitude) }, attribution:'© OpenStreetMap contributors' });
  } catch (error) { next(error); }
});
export default router;

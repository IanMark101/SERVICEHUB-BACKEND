import type { PlaceSuggestionQuery } from '../schema/location.schema';

type Place = { latitude: number; longitude: number; label: string };
type Options = { fetcher?: typeof fetch; now?: () => number; endpoint?: () => string };
const unavailable = () => Object.assign(new Error('Place suggestions are unavailable. Use Search or choose a pin on the map.'), { status: 503 });
const busy = () => Object.assign(new Error('Place suggestions are busy. Try again shortly, or use Search.'), { status: 429 });

/** Photon supports autocomplete. Never send type-ahead requests to public Nominatim. */
export function createPlaceSuggester({ fetcher = fetch, now = Date.now, endpoint = () => process.env.LOCATION_SUGGEST_URL || 'https://photon.komoot.io/api/' }: Options = {}) {
  const cache = new Map<string, { expires: number; places: Place[] }>();
  const pending = new Map<string, Promise<Place[]>>();
  let recentStarts: number[] = [];
  let retryAfter = 0;

  return async (input: PlaceSuggestionQuery): Promise<Place[]> => {
    const query = input.q.trim().replace(/\s+/g, ' ');
    const url = new URL(endpoint());
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname === 'nominatim.openstreetmap.org') throw unavailable();
    const latitude = input.latitude?.toFixed(2), longitude = input.longitude?.toFixed(2);
    const key = `${url.href}:${query.toLowerCase()}:${latitude ?? ''}:${longitude ?? ''}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.places;
    if (pending.has(key)) return pending.get(key)!;
    if (retryAfter > now()) throw unavailable();
    // Bound concurrency and burst traffic instead of queueing every user's keystrokes.
    recentStarts = recentStarts.filter(start => now() - start < 1000);
    if (pending.size >= 4 || recentStarts.length >= 4) throw busy();
    recentStarts.push(now());
    url.searchParams.set('q', query);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('countrycode', 'PH');
    url.searchParams.set('limit', '5');
    url.searchParams.delete('layer');
    for (const layer of ['locality', 'district', 'city', 'county', 'state']) url.searchParams.append('layer', layer);
    url.searchParams.delete('lat'); url.searchParams.delete('lon');
    if (latitude !== undefined && longitude !== undefined) {
      // A coarse bias improves local matches without disclosing an exact private pin.
      url.searchParams.set('lat', latitude); url.searchParams.set('lon', longitude);
    }
    const work = (async () => {
      try {
        const response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': process.env.LOCATION_SEARCH_USER_AGENT || 'ServiceHub-PlaceSearch/1.0' }, signal: AbortSignal.timeout(6500) });
        if (!response.ok) throw unavailable();
        const raw: unknown = await response.json();
        if (!raw || typeof raw !== 'object' || !('features' in raw) || !Array.isArray(raw.features)) throw unavailable();
        const places: Place[] = [];
        const labels = new Set<string>();
        for (const feature of raw.features.slice(0, 30)) {
          if (!feature || typeof feature !== 'object' || !feature.geometry || feature.geometry.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) continue;
          const [longitude, latitude] = feature.geometry.coordinates;
          if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
          const properties = feature.properties;
          if (!properties || typeof properties !== 'object' || typeof properties.countrycode !== 'string' || properties.countrycode.toUpperCase() !== 'PH') continue;
          const parts = ['name', 'district', 'city', 'county', 'state'].map(field => typeof properties[field] === 'string' ? properties[field].trim().slice(0, 100) : '').filter(Boolean);
          const label = [...new Map(parts.map(part => [part.toLowerCase(), part])).values()].join(', ').slice(0, 160);
          if (label.length < 2 || labels.has(label.toLowerCase())) continue;
          labels.add(label.toLowerCase());
          places.push({ latitude, longitude, label });
          if (places.length === 5) break;
        }
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: now() + (places.length ? 86400000 : 60000), places });
        return places;
      } catch {
        // Briefly stop contacting a failed upstream; cached queries still work.
        retryAfter = now() + 5000;
        throw unavailable();
      }
    })();
    pending.set(key, work);
    return work.finally(() => pending.delete(key));
  };
}

export const suggestPlaces = createPlaceSuggester();

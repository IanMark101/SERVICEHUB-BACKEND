/** Public locality only. Never turn a reverse result into a street/home address. */
export function localityLabel(address: unknown): string | null {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const fields = address as Record<string, unknown>;
  const text = (key: string) => typeof fields[key] === 'string' ? fields[key].trim() : '';
  const area = text('suburb') || text('village') || text('neighbourhood') || text('city_district');
  const city = text('city') || text('town') || text('municipality');
  const province = text('province') || text('state');
  if (!area && !city) return null;
  return [...new Set([area, city, province].filter(Boolean))].join(', ').slice(0, 160);
}

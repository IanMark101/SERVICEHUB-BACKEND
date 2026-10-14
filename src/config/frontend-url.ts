export const PRODUCTION_FRONTEND_URL = 'https://www.servicehub.bond';

export function canonicalFrontendUrl(value: string | undefined, mode: string | undefined): string {
  if (!value?.trim()) return mode === 'production' ? PRODUCTION_FRONTEND_URL : 'http://localhost:3000';
  const configured = value.trim();
  try {
    const url = new URL(configured);
    if (['http:', 'https:'].includes(url.protocol) && !url.port && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash
      && ['servicehubcordova.tech', 'www.servicehubcordova.tech', 'servicehub.bond', 'www.servicehub.bond'].includes(url.hostname)) {
      return PRODUCTION_FRONTEND_URL;
    }
  } catch { /* Leave other values to the existing configuration validation. */ }
  return configured;
}

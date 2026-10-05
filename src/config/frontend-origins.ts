import { env } from "./env";

export const deploymentFrontendOrigins = [
  "https://servicehubcordova.tech",
  "https://www.servicehubcordova.tech",
  "https://servicehub-frontend-umber.vercel.app",
] as const;

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.hostname.includes("*") || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

// Use one exact allowlist for HTTP, Socket.IO, and cookie-authenticated actions.
// Normalize configured URLs so a trailing slash never changes the comparison.
export function getAllowedFrontendOrigins(): string[] {
  const configured = [env.FRONTEND_URL, ...env.FRONTEND_ORIGINS.split(",")]
    .map(normalizeOrigin)
    .filter((origin): origin is string => !!origin);
  return [...new Set([...deploymentFrontendOrigins, ...configured])];
}

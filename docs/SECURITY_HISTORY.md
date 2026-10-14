# Admin sign-in and security history

Open **Admin → Audit Log → Sign-in history**. The existing administrator action history stays in its own view on this page.

The backend records password/Google sign-ins, initial registration sign-in, rejected authentication, and explicit sign-out. Refresh and initial cookie/session recovery are not new sign-ins. Closing a browser is not an explicit sign-out. The history starts when the feature is enabled; historical refresh tokens cannot reconstruct past sign-ins.

Successful sign-in events commit in the same transaction as session creation. Failed-attempt and sign-out records use a best-effort write that does not expose account existence or prevent session revocation. Storage failures produce `security_history_write_failed` without credentials or connection details in operational logs.

Key successful marketplace POST operations (service/request publication, offers, direct booking requests and offer acceptance) record security events after the response. A SHA-256 reference derived from the internal random session ID connects these actions and explicit sign-out to sign-in. This reference is not a bearer credential. These action records are best effort; application bookings/listings remain the source of truth for transaction details.

## Data and location

Records store account ID when known, server/database UTC timestamp, source IP, browser/device report, optional raw user-agent limited to 500 characters, request reference, and coarse city/region/country. Unknown failed attempts do not store the submitted email or password. No password, access/refresh token, Google token, precise location, postcode, ID-document image, or profile location is copied into security history. Browser reports are client supplied and are not proof of device identity.

The client address comes from Express `req.ip`. Configure `TRUSTED_PROXY_CIDRS` with the actual reverse-proxy addresses; never trust every forwarded header. The proxy parser is pinned to its patched version. IP lookups use the local `geoip-lite` data files; no user IP is transmitted to an external lookup API. Private/loopback networks show **Local / private network**. Missing or failed lookups show **Location unavailable**. Every mapped location is explicitly approximate; VPN/mobile addresses cannot establish a person's exact location.

The Node 22-compatible lookup package contains bundled GeoLite data. Keep data current for deployment: obtain a MaxMind license key and pass it through the `LICENSE_KEY` environment variable to `npm run security:geoip-update` during image preparation, never on user requests. The wrapper adapts the legacy converter's BigInt method name to the patched IP parser. Do not commit keys. The `GEODATADIR` environment variable can select separately maintained data files. Restart the server after updating data. This product includes GeoLite data created by MaxMind, available at https://www.maxmind.com/.

## Access, retention and deployment

`GET /api/admin/audit-logs?kind=security` retains the existing authentication/admin guards. Access records commit to `AdminAuditLog` before private security records are returned. Responses and the frontend request both disable caching; there is no public/user marketplace endpoint for these records.

Server-side filters support account/name/email, IP or session reference, event, and UTC date boundaries. Pagination is capped at 100 records with stable newest-first ordering. UI dates use the administrator device's time zone, show seconds, and expose UTC timestamps in the time tooltip.

`SECURITY_LOG_RETENTION_DAYS` defaults to 90 and accepts 7–365. Records outside retention are excluded from admin queries immediately. The server deletes expired records at startup and hourly. Known-user records cascade on permanent account deletion; unidentified attempts expire by retention. This is application history with restricted writes/access, not cryptographically immutable evidence or proof of ID ownership.

Apply `20261013000000_security_event_history`, regenerate Prisma, install the lockfile, and restart the backend when deploying elsewhere. The verified local development database has the migration applied. Production deployment remains a separate action.

## Verification

The focused schema tests cover IP normalization and approved proxies, local/unknown areas, omitted coordinates/secrets, session references, successful/failed password sign-in, sign-out persistence, admin access records, retention/date limits, and successful-action correlation. The existing auth/session/admin route guards run alongside them.

`SERVICEHUB_SECURITY_HISTORY_ONLY=1 npm run test:fresh-migrations` is restricted to the recorded development endpoint. It deploys all migrations into a disposable schema, checks schema drift, and verifies password/Google authentication, persistent history, admin filtering, cleanup and account deletion without changing real accounts.

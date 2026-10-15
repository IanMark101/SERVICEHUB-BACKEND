# First-party session recovery — October 15, 2026

## Problem and correction

After the frontend moved to `www.servicehub.bond`, the existing API cookie on `api.servicehubcordova.tech` became a third-party cookie. Browsers that block it can accept a login response's short-lived in-memory access token but fail to recover the session after a reload or renew the token during a later action. An administrator may therefore appear to be signed out when reviewing a verification, even though that decision does not revoke the administrator's session.

The browser now sends the nine exact cookie-lifecycle paths in `src/lib/api/sessionRouting.ts` through `/api` on the website. Next.js rewrites them to the existing configured API. This includes password and Google login, registration, session recovery, rotation, logout, password reset/change and account deletion. The server's host-only refresh cookie is consequently stored on the website. Raw Axios renewal and ordinary API calls use the same routing decision.

Marketplace APIs, uploads, authenticated profile reads and Socket.IO still use the API directly. Do not change `NEXT_PUBLIC_API_URL` to `/api`: it remains the absolute upstream API base, including its API path. Rewrites use that value at build time, so deployment must include the changed Next.js configuration.

## Security and behavior

- Credentials stay out of local/session storage. The refresh cookie retains HttpOnly, Secure in production and its existing lifetime. The access token remains in memory.
- The exact session paths send `Cache-Control: private, no-store`. Backend trusted-origin checks on session, refresh and logout remain authoritative; the rewrite preserves the browser Origin. Existing authorization, rotation, revocation and role checks are retained.
- Verification decisions change the applicant's verification state and do not change the reviewing administrator or revoke their sessions.
- Existing backend-domain cookies cannot be copied by browser JavaScript. After this release, existing users may need to sign in once to obtain the website-domain cookie. Do not require them to enable third-party cookies.
- The proxy adds a network hop for these paths. Existing trusted-proxy configuration still controls backend IP attribution and IP rate limits; do not trust arbitrary forwarded headers or treat a proxy address as verified device location. Other authenticated activity continues directly to the API.
- Deploy the frontend to activate the fix. No database migration or backend runtime change is required.

## Verification

The full frontend suite passed 1,356 tests; the focused authentication/admin run passed 91 tests. Frontend TypeScript, focused ESLint and the production build passed. Backend session, HTTP authorization and verification tests passed nine checks; approval and rejection both preserve the administrator's recoverable session.

An isolated Chrome profile enabled third-party-cookie restrictions. The former direct cross-site transport returned an unauthenticated recovery result. The corrected website-origin transport retained an HttpOnly/Secure cookie through five hard reloads and two rotations. Rejecting a fictional residency submission, reloading the page and recovering again retained the admin identity. Explicit logout removed the session. The fixture used no production accounts or private documents.

The capstone publication issued earlier on October 15 records frontend `e1ab120` and API `edfea27`. This maintenance note records the subsequent session-transport correction; it does not silently relabel that earlier publication or its deployment evidence.

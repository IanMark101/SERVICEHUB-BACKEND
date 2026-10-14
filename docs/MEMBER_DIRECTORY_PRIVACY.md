# Member directory and administrator privacy

The Seeker and Provider people search is for marketplace members. Administrators remain separate operational accounts. This avoids exposing their marketplace-style profiles and reduces targeted contact; knowing an account's name or ID never grants administrator privileges.

`GET /api/users` requires authentication and verified email. Its database filter fixes `role: user`, requires an active, non-deactivated account with ACTIVE moderation status, and applies the same filter to both results and pagination counts. Searches match public name, general location and biography only. Private email, contact phone, credentials and security records are neither search keys nor response fields. A requested admin role is rejected rather than overriding the directory filter. Administrator User Management retains its protected search tools.

The member-facing profile API permits ordinary member profiles and the authenticated owner's own profile. An administrator's profile cannot be opened by another account through `GET /api/auth/profile/:id`. Public trust history, provider reviews and provider/seeker review-summary APIs also reject administrator targets. Hidden and nonexistent targets both return 404. These rules are enforced by database queries before returning profile data or computing summaries.

Administrators retain `/api/auth/me`, their own profile editing and security/account settings. Protected `/api/admin/users/:id` and records endpoints retain `requireAuth`, database-backed `requireAdmin`, and their existing inspection audit trail. Admin-authorized detailed trust investigation is unchanged. Official announcements and their existing author attribution are unchanged; administrator accounts are not promised anonymity everywhere in the application.

The shared header defensively excludes administrators from desktop/mobile server results and local fallback results. Local fallback never searches private email addresses. Backend enforcement remains the access boundary even if a browser bypasses these filters.

No migration, dependency or account-data cleanup is required. Deploy the backend and frontend together; existing browser pages need a refresh to receive the header change.

## Verification

Run `SERVICEHUB_MEMBER_DIRECTORY_ONLY=1 npm run test:fresh-migrations` from the backend. The harness verifies the recorded development target, replays migrations into a disposable schema, checks drift, runs member-directory HTTP regressions plus existing admin-profile and privacy/deletion regressions, and removes that test schema. The member-directory suite itself refuses fixture writes outside a disposable schema.

The HTTP cases exercise authenticated search, admin query bypass attempts, pagination, case-insensitive name search, private email inference, direct profile IDs, secondary profile APIs, unchanged member reads, administrator self-access and protected/audited investigation access. The frontend Header search tests cover both server results and offline/failure fallback. These checks do not certify production deployment.

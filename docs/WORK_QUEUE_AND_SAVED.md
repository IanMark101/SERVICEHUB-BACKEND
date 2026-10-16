# Work Queue, Saved and listing report update

Current behavior and release boundary: see CURRENT_SYSTEM.md. Dated implementation checks below retain their original scope. Generated review captures and logs removed during cleanup remain recoverable from the recorded pre-cleanup Git revisions.
Implementation and verification: October 14, 2026.

Provider Work Queue is `/provider/work-queue`. It reuses `ProviderWorkloadPanel`, the existing workload GET/PATCH API and the existing Start Job action. Activity retains booking status filters, history, progress and lifecycle actions; it no longer mounts the workload panel. Provider Payment Records keeps its existing `/provider/transaction-history` route. There is no seeker workload-management route.

Saved is `/seeker/saved` or `/provider/saved`, immediately below Request Manager or Service Manager. Seekers save provider services and providers save public seeker requests. Both views reuse marketplace cards and original details routes. Saved does not reserve work, send an offer, admit a booking or change queue priority. Own listings hide Save and Report; the backend also rejects self-target operations.

## Important implementation files

- Frontend navigation and queue: `src/components/layout/SidebarView.tsx`, `src/components/provider/ProviderWorkQueue.tsx`, `src/components/provider/activity/ProviderWorkloadPanel.tsx`, and `src/components/provider/ProviderActivity.tsx`.
- Frontend Saved and card actions: `src/components/marketplace/SavedListings.tsx`, `src/components/marketplace/ListingCardTools.tsx`, `src/hooks/useSavedListings.ts`, `src/api/savedListings.api.ts`, and the existing service/request browsing cards and moderation action.
- Backend: `prisma/schema.prisma`, `prisma/migrations/20261014010000_saved_listings/migration.sql`, `src/services/saved-listings.service.ts`, the matching controller/schema/routes, and `src/routes/requests.routes.ts` for canonical public request details.
- Documentation: root and backend `SERVICEHUB_MASTER_PROMPT.md`; SRS, SDD, STD and SPMP Markdown/HTML sources and final Word files under `DOCUMENTATION_DRAFTS`.

## Persistence and authorization

Migration `20261014010000_saved_listings` adds `SavedListing` (`saved_listings`). A CHECK requires exactly one service/request target. Unique account/target indexes make PUT idempotent; DELETE is also idempotent. User and target foreign keys cascade deletion. Existing listing visibility/hydration is reused, and precise locations/private addresses are redacted. Unavailable saved records show a removable generic placeholder; private targeted inquiries cannot be saved. Read/status operations use the authenticated account, never a client-supplied owner ID. The usual marketplace and email gates apply.

| API | Behavior |
|---|---|
| GET `/api/saved?contentType=...&page=1&limit=12` | Paginated account/type list; maximum API limit 30 |
| GET `/api/saved/status?contentType=...&ids=...` | One bounded status request per displayed listing page |
| PUT `/api/saved/:contentType/:listingId` | Save an eligible public target once |
| DELETE `/api/saved/:contentType/:listingId` | Remove only the current member’s save |
| GET `/api/requests/:id` | Existing public visibility and location redaction for original request details |

`contentType` is `SERVICE_LISTING` or `SERVICE_REQUEST`. Saved reads bypass response caching; mutations use the existing cache invalidation bus. UI guards repeated clicks and stale account responses, with loading, retry, empty and unavailable states.

The labeled flag submits through the existing `/api/content-cases` flow. Valid explanations create Admin review cases, without changing publication automatically. Pending clicks and an already successful local submission are guarded. The existing backend rejects another open report by that account for the same target.

## Verification and migration

- Frontend: 50 tests across nine focused files passed, including role-specific navigation/order, queue authority/capacity, Activity preservation, Saved operations and browsing integration. A broader seven-file regression run passed 51 tests (nine overlap the focused suite), covering the inert landing preview, booking invalidation and response cache: 92 distinct frontend tests passed in total. Targeted ESLint and the final production build passed.
- Backend: build and four schema/authorization contract tests passed. Six real database integration tests passed for concurrent duplicate saves, both target types, account/session isolation, ownership/private visibility, unavailable targets, redaction, reporting duplicates and cascading deletion.
- All 45 migrations replayed in a disposable schema on the verified development target; Prisma reported no schema drift. That schema was cleaned up. The additive Saved migration was then applied to the recorded development database via `scripts/migrate-development-saved.ts`; existing rows were not modified.
- Intercepted Edge browser fixtures passed for both workspaces at 1440px light and 390px dark. Checked responsive grids, Work Queue, report/unsave requests, original detail reads, no horizontal overflow and no page errors. Screenshots and results: `SERVICEHUB-FRONTEND/.impeccable/review/workspace-saved-review.json`.

The browser fixtures are illustrative, not live production account or gateway evidence. Production/shared migration, a complete payment/booking lifecycle and full manual acceptance were not executed in this update. SRS, SDD, STD, SPMP and both master prompts document this boundary.

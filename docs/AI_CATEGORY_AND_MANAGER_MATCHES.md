# AI category assistance and listing managers — October 15, 2026

Implemented on feature/marketplace-ux-message-receipts, then merged to main and deployed on October 15, 2026. The verified production revisions are frontend e1ab120 and API edfea27. See the release record below for final CI and deployment evidence.

## User behavior

Both Post Request and Offer Services offer **Suggest category** after a title is entered. The helper reads the title and optional description, returns up to three active existing categories and requires **Use category** confirmation. It never replaces a selected category automatically. An accompanying category search uses the current catalog names, examples and aliases. Missing AI configuration, invalid output and upstream failures leave manual selection available. Changing the input or leaving the form cancels/ignores stale browser responses; searching does not submit the form.

**Request Manager → AI Matches** opens a scrollable modal of eligible provider services. **Service Manager → AI Matches** opens the same role-themed modal for eligible public seeker requests. Each result shows rank, listing title, member name, recorded trust score, role-specific rating/review count, general area, price/budget and distance when known. Unrated members are labeled No ratings yet. View service/request opens the existing Details route; no offer, booking, payment or notification is created by matching.

Service Manager now uses compact rows with title/status, category/area, price, AI Matches and Details. Details opens the existing full managed card with its photos, full description, edit/delete/appeal/visibility controls. Unsupported legacy prices retain Price needed. Edit service disables repeated saves, close/cancel and field changes while the request is pending. Save Changes turns neutral gray and reads Saving…. A failed save keeps the entered values and enables retry.

## Backend and ranking

- Existing `POST /api/ai/match-providers` now returns real listing IDs and database facts, not model-generated names/rationales. Added authenticated, marketplace-member and rate-limited `POST /api/ai/match-requests` (`serviceId`) and `POST /api/ai/suggest-category` (`title`, optional `description`). Request/service source IDs must belong to the caller.
- Match candidates must share the active source category and public eligibility rules. Private listing inquiries, closed/archived/booked requests, hidden/paused services, self matches, banned/ineligible accounts and admin records are excluded. Existing visit-mode/coverage resolution is reused. When both points are known, discovery is limited to 30 km; results expose rounded distance and general labels, never exact coordinates or private directions. One service per provider is shown in seeker recommendations.
- Provider and seeker ratings use the shared completed-transaction/counterparty/visibility eligibility SQL in their respective roles. Gemini cannot invent scores, ratings, people, categories or listing IDs. The model receives supplied eligible IDs and public work text; its ID-only output is schema/allow-list validated. Current public availability is rechecked after generation.
- The base ranking combines recorded trust (45 points), review rating with bounded review-count evidence (30), title relevance (20) and known distance (5). AI-assisted ordering combines 65% of that base with 35% model relevance. These are internal ranking weights, not confidence or suitability guarantees. If Gemini fails or returns invalid IDs, the same real candidates use the computed ranking and the modal clearly says so.
- Reuse `GEMINI_API_KEY` and `GEMINI_SUMMARY_MODEL` on the server. Generation has a 15-second deadline; browser calls have a 30-second deadline to include database work. Repeated identical work coalesces and validated model orders cache for 60 seconds in a bounded, account-scoped memory cache. Public eligibility and current ratings are still queried on every matching request. No credentials are sent to the frontend.

## Important files

Frontend: `CategorySuggestion.tsx`, `MarketplaceMatchesModal.tsx` and `MarketplaceAssist.module.css`; PostRequest/OfferServices/RequestManager; ServiceManager, ManagedServiceRow and ManagedServiceDetailsModal; EditServiceModal; `api/ai.api.ts`. Backend: `services/ai-marketplace.service.ts`, the retained ai.service export, AI controller/routes and the isolated AI integration suite.

## Verification and release

The focused frontend component checks, desktop/mobile light/dark browser fixtures, pending-save color/state check, TypeScript, lint and production builds are recorded in the task evidence. Browser fixtures cover both category forms and both role matching modals; they do not modify production records or invoke paid AI. The isolated backend suite uses mocked Gemini responses and a fresh disposable schema on the recorded development target; the harness replays existing migrations, checks drift and removes the schema. A separate real configured Gemini check successfully classified the synthetic laptop-fan example as Computer & Laptop Repair. Production end-to-end acceptance remains separate.

No new database migration is required for these AI/manager changes. The earlier nullable message-read migration remains part of this branch's existing release requirements. The compatible backend/frontend release is deployed. The revised capstone sources, Word/PDF publication and master prompts now record the verified release and its remaining acceptance boundaries.

### Executed verification

- 67 focused frontend component tests passed; six assist/modal cases passed again after the final input-keyboard refinement.
- The isolated AI database suite passed all four reported tests. The harness replayed all 49 existing migrations into a disposable development schema, verified 42 tables and zero schema drift, then removed the test schema. Upstream AI was mocked in these integration cases.
- Eight local browser scenarios passed across Seeker/Provider, desktop/mobile and light/dark themes. They covered matching modals, compact rows/full Details, pending-save feedback and both creation-form category controls using intercepted API fixtures.
- Frontend targeted lint and both TypeScript/production builds passed. The final frontend build generated 112 pages.
- One live configured Gemini request classified synthetic laptop-fan work as Computer & Laptop Repair. Reciprocal production matching and real-user acceptance were not performed.


## Production release verified October 15 2026

The compatible application release was published to main: frontend e1ab120e8dd121b6260abbbcef14c9387025205a and API edfea27a70c9fd33a1898cb8471fd180628baab0. Frontend CI and security, backend CI and security, Vercel production deployment and the VPS deployment workflow succeeded. Final CI logs confirm 1,334 frontend tests and 233 backend regression tests, plus the backend integration stages. Production dependency audits passed.

The successful API migration step reported 49 migrations and no pending migration. The history includes nullable Message.readAt and retains unknown historical read times as null. Public website/API health, protected-route authentication responses, exact CORS origins for both servicehub.bond hosts and new served feature assets were checked. These are public smoke checks, not signed-in production matching, live message, real-wallet or community acceptance results.

The revised capstone sources, editable Word book and matching PDF record this release. Evidence with workflow URLs and resolved dependency versions is retained in DOCUMENTATION_REVISED_2026-10-15/TECHNICAL_REFERENCE/Production_Release_Evidence_2026-10-15.json.

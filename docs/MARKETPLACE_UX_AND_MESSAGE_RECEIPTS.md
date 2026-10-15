# Marketplace UX and message receipts — October 15, 2026

Developed on feature/marketplace-ux-message-receipts and released to main on October 15, 2026. Production uses frontend e1ab120 and API edfea27; both deployments were verified.

## Behavior

- Service and public request discovery cards keep one photo, readable white titles over the existing shade, identity/trust, three key facts, and existing actions. Save and Report are accessible 44px controls on the cover; ownership and queue/urgency status also sit on the cover. Full service arrangement and payment information remains in Details rather than repeated card rows. Zero-photo cards retain the workspace-colored fallback.
- Details retains every uploaded photo in the existing manual gallery. Descriptions wrap, facts use labeled groups, and price-agreement/offer steps have a short numbered guide. The footer remains visible while content scrolls. Focus is contained and returns on closing; nested Report dialogs retain their own Escape handling.
- MoneyInput keeps a blank editing draft while forms still store numeric values. Clearing a price then entering 500 yields 500, not 0500. Existing min/max/required validation and API payloads remain unchanged. It is reused for service prices, request budgets, edits, offers and travel fees.
- Provider Browse Service Requests now passes current filters, initial request pins and the existing details callback into the location dialog. Viewport reads use `/api/requests/nearby`; Seeker uses `/api/services/nearby`. Existing inline request maps remain. Opening a pin's listing does not apply the search-location draft. Seeker job pins remain approximate; provider service pins are exact only with existing public consent. Initial feed pins appear during network loading; cold network and external map tiles are not guaranteed instantaneous.
- Both message pages show Sent or Seen beside outgoing text. Seen includes the stored first-read time when known; historical read flags show Seen without an invented time. Incoming and system messages have no outgoing receipt label. Server checks participation/lifecycle, captures the returned message IDs, and atomically timestamps only previously unread received messages. Concurrent arrivals outside that snapshot remain unread. Admin inspection, sending a reply and background reads do not mark history seen.
- `messages_read` is emitted only to the two participants' personal rooms. Active visible conversations refresh on incoming messages; background tabs wait until visible. Live receipts are preserved even if they arrive before a send response. Refresh/reconnection reloads the durable timestamp. Conversation selection binds listeners after socket initialization; reconnect rejoins the booking room and rebinds a replacement socket. Personal-room message pings recover arrivals during room rejoining. Existing authorization, lifecycle and text-only restrictions remain.

## Migration and release

`20261015010000_message_read_receipts` adds nullable `messages.readAt TIMESTAMP(3)`. No historical time is backfilled. The generated Prisma client must be regenerated; the existing client contract check now rejects clients missing Message.readAt. The established migration deployment step must run before replacing the API container.

The guarded `scripts/migrate-development-message-receipts.ts` verifies DATABASE_URL and DIRECT_URL against the recorded development endpoint, requires development mode and refuses unrelated pending migrations. It applied this migration successfully to that development target. Production deployment subsequently completed successfully; its migration check found no pending migration among the 49 checked-in migrations, including the message-read addition.

## Verification

- 112 focused frontend tests passed: card actions, both details dialogs, money editing, wizard validation, existing booking restrictions, provider request-map discovery, socket receipts, background visibility, stale loads and late send responses.
- Backend receipt integration passed in a disposable schema on the verified development target: unauthorized/admin/background reads, reply behavior, concurrent first reads, recipient scoping, timestamp persistence and idempotence, other bookings and historical null timestamps. All 49 migrations replayed, no schema drift was detected, and the disposable schema was removed.
- Three generated-client contract tests and three text-only message schema tests passed. Frontend/backend TypeScript, production builds and targeted frontend ESLint passed. The manual Impeccable detector returned no findings.
- Browser review uses intercepted API fixtures at 1440px and 390px, light and dark, for both roles. It checks compact cover/title/empty-photo behavior, text wrapping, card/modal overflow, visible footer, Escape handling and both location-map APIs. This is not a live production, real-user or external-tile availability certification.

Primary files: frontend TrailCard/ListingCardTools, ServiceMarketplaceCard/JobRequestCard, ServiceDetailsPanel/JobRequestDetailsModal and shared styles; MoneyInput and existing price/budget/offer/travel fields; BrowseJobs, MarketplaceLocationControl, LocationEditor and useProviderMapListings; both message pages, MessageReceipt, useMessagesPage, messages API/cache policy. Backend: Message schema/migration, messages service/controller, generated-client guard and receipt integration/migration scripts.


## Production release verified October 15 2026

The compatible application release was published to main: frontend e1ab120e8dd121b6260abbbcef14c9387025205a and API edfea27a70c9fd33a1898cb8471fd180628baab0. Frontend CI and security, backend CI and security, Vercel production deployment and the VPS deployment workflow succeeded. Final CI logs confirm 1,334 frontend tests and 233 backend regression tests, plus the backend integration stages. Production dependency audits passed.

The successful API migration step reported 49 migrations and no pending migration. The history includes nullable Message.readAt and retains unknown historical read times as null. Public website/API health, protected-route authentication responses, exact CORS origins for both servicehub.bond hosts and new served feature assets were checked. These are public smoke checks, not signed-in production matching, live message, real-wallet or community acceptance results.

The revised capstone sources, editable Word book and matching PDF record this release. Evidence with workflow URLs and resolved dependency versions is retained in DOCUMENTATION_REVISED_2026-10-15/TECHNICAL_REFERENCE/Production_Release_Evidence_2026-10-15.json.

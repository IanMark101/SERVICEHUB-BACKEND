import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("new content publishes only after server moderation and committed records", () => {
  const listings = source("../services/services.service.ts");
  const requests = source("../controllers/requests.controller.ts");
  assert.match(listings, /const assessment = assessMarketplaceContent\(/);
  assert.match(listings, /status: "ACTIVE"/);
  assert.doesNotMatch(listings, /awaitingAdmin|submittedForReview|SERVICE_LISTING_SUBMITTED/);
  assert.match(listings, /safeBroadcast\("SERVICE_LISTINGS_CHANGED", \{ id: created\.service\.id, status: "ACTIVE" \}\)/);
  assert.match(requests, /const request = await createRequest\([\s\S]*?safeBroadcast\("SERVICE_REQUEST_CREATED", request\)/);
});

test("content mutations keep authorization and account-scoped abuse limits", () => {
  const services = source("../routes/services.routes.ts");
  const requests = source("../routes/requests.routes.ts");
  const admin = source("../routes/admin.routes.ts");
  assert.match(services, /router\.post\("\/", requireAuth, requireMarketplaceUser, requireVerification, requirePostingPrivilege, marketplaceContentLimiter, create\)/);
  assert.match(services, /router\.patch\("\/:id", requireAuth, requireMarketplaceUser, requireVerification, requirePostingPrivilege, marketplaceContentLimiter, update\)/);
  assert.match(requests, /router\.post\("\/", requireVerification, marketplaceContentLimiter, create\)/);
  assert.match(requests, /router\.patch\("\/:id", requireVerification, marketplaceContentLimiter, update\)/);
  assert.match(admin, /router\.use\(requireAuth, requireAdmin\)/);
  assert.match(admin, /router\.post\("\/content\/requests\/:id\/remove", removeRequestContent\)/);
  assert.doesNotMatch(admin, /services\/pending|services\/:id\/review/);
});

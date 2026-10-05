import assert from "node:assert/strict";
import test from "node:test";
import { assessMarketplaceContent, CONTENT_POLICY_VERSION } from "./content-moderation.service";

const plumbing = {
  categoryName: "Plumbing",
  title: "Fix a kitchen faucet leak",
  description: "The faucet leaks under the sink and needs repair.",
};

test("clean listing and request pass the same versioned local policy", () => {
  for (const kind of ["SERVICE_LISTING", "SERVICE_REQUEST"] as const) {
    const result = assessMarketplaceContent({ ...plumbing, kind });
    assert.equal(result.outcome, "PASS");
    assert.equal(result.policyVersion, CONTENT_POLICY_VERSION);
  }
});

test("clearly prohibited service wording requires revision for both roles", () => {
  for (const kind of ["SERVICE_LISTING", "SERVICE_REQUEST"] as const) {
    const result = assessMarketplaceContent({ ...plumbing, kind, description: "I want to sell illegal drugs as my service." });
    assert.equal(result.outcome, "REVISE");
    assert.equal(result.reasonCode, "PROHIBITED_SERVICE");
  }
});

test("profanity and simple punctuation obfuscation are detected", () => {
  const result = assessMarketplaceContent({ ...plumbing, kind: "SERVICE_REQUEST", description: "Do this f.u.c.k task." });
  assert.equal(result.outcome, "REVISE");
  assert.equal(result.reasonCode, "PROFANITY");
});

test("hateful titles and descriptions cannot publish in either workspace", () => {
  for (const kind of ["SERVICE_LISTING", "SERVICE_REQUEST"] as const) {
    for (const title of ["nigger", "niggernigger", "N1GG3R", "n.i.g.g.e.r", "n i g g e r", "n!gger", "nigga"]) {
      const result = assessMarketplaceContent({ ...plumbing, kind, title });
      assert.equal(result.outcome, "REVISE", `${kind}: ${title}`);
      assert.equal(result.reasonCode, "HATE_SPEECH");
      assert.equal(result.field, "title");
    }
    const inDescription = assessMarketplaceContent({ ...plumbing, kind, description: "No niggernigger allowed here." });
    assert.equal(inDescription.outcome, "REVISE");
    assert.equal(inDescription.field, "description");
    assert.equal(assessMarketplaceContent({ ...plumbing, kind, title: "Sniggering pipe repair" }).outcome, "PASS");
  }
});

test("ordinary near-matches are not rejected", () => {
  const result = assessMarketplaceContent({ ...plumbing, kind: "SERVICE_LISTING", description: "Assess a leak in the kitchen and repair the faucet." });
  assert.equal(result.outcome, "PASS");
});

test("strong category mismatch requires correction without a listing approval queue", () => {
  const wrongCategory = { categoryName: "Plumbing", title: "Teach calculus lessons", description: "I can teach math and offer tutoring lessons." };
  assert.equal(assessMarketplaceContent({ ...wrongCategory, kind: "SERVICE_LISTING" }).outcome, "REVISE");
  assert.equal(assessMarketplaceContent({ ...wrongCategory, kind: "SERVICE_REQUEST" }).outcome, "REVISE");
});

test("unsupported high-risk listings require revision instead of administrator approval", () => {
  const listing = assessMarketplaceContent({ ...plumbing, kind: "SERVICE_LISTING", description: "I can provide private security service." });
  assert.equal(listing.outcome, "REVISE");
  assert.equal(listing.reasonCode, "HIGH_RISK");
  const request = assessMarketplaceContent({ ...plumbing, kind: "SERVICE_REQUEST", description: "I can provide private security service." });
  assert.equal(request.outcome, "PASS");
});

test("explicit weapons sales and obvious leetspeak are not silently published", () => {
  for (const kind of ["SERVICE_LISTING", "SERVICE_REQUEST"] as const) {
    assert.equal(assessMarketplaceContent({ ...plumbing, kind, description: "I can sell firearms." }).outcome, "REVISE");
    assert.equal(assessMarketplaceContent({ ...plumbing, kind, description: "I can s3ll illegal drugs." }).outcome, "REVISE");
    assert.equal(assessMarketplaceContent({ ...plumbing, kind, description: "I can s.e.l.l illegal drugs." }).outcome, "REVISE");
  }
});

test("precise Filipino rules work without broad trade-word substring matching", () => {
  assert.equal(assessMarketplaceContent({ ...plumbing, kind: "SERVICE_REQUEST", description: "Magbenta ng droga sa barangay." }).outcome, "REVISE");
  assert.equal(assessMarketplaceContent({ ...plumbing, kind: "SERVICE_LISTING", description: "Baligya og droga sa barangay." }).outcome, "REVISE");
  assert.equal(assessMarketplaceContent({ ...plumbing, kind: "SERVICE_REQUEST", description: "Please assess the drain in the barangay kitchen." }).outcome, "PASS");
});

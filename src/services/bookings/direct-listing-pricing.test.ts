import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { calculateDirectListingTerms } from "./direct-listing-pricing";

test("direct listing totals use the server listing rate and selected units", () => {
  const rate = new Prisma.Decimal(500);
  assert.equal(Number(calculateDirectListingTerms("FIXED", rate, 1, 90).amount), 500);
  assert.equal(Number(calculateDirectListingTerms("PER_PROJECT", rate, 1, 90).amount), 500);
  assert.deepEqual(calculateDirectListingTerms("PER_HOUR", rate, 2, 90).estimatedDurationMins, 120);
  assert.equal(Number(calculateDirectListingTerms("PER_DAY", rate, 3, 90).amount), 1500);
  assert.throws(() => calculateDirectListingTerms("PER_HOUR", rate, 0, 90));
  assert.throws(() => calculateDirectListingTerms("FIXED", rate, 2, 90));
  assert.throws(() => calculateDirectListingTerms("CUSTOM", null, 1, 90));
  assert.throws(() => calculateDirectListingTerms("PER_HOUR", new Prisma.Decimal(2000), 40, 90));
});

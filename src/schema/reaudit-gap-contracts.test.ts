import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markAdminResolutionStageInTransaction } from "../services/admin-resolution-operation.service";

const source = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");

test("a stale worker cannot reopen a completed AdminResolutionOperation", async () => {
  const completed = {
    id: "operation-1",
    status: "COMPLETED",
    stage: "CASE_FINALIZED",
    result: { resolved: true },
  };
  let writes = 0;
  const tx = {
    adminResolutionOperation: {
      findUnique: async () => completed,
      updateMany: async () => { writes += 1; return { count: 1 }; },
      findUniqueOrThrow: async () => completed,
    },
  };

  const workerBResult = await markAdminResolutionStageInTransaction(tx as never, completed.id, "DECISION_READY");
  assert.equal(writes, 0);
  assert.equal(workerBResult.status, "COMPLETED");
  assert.equal(workerBResult.stage, "CASE_FINALIZED");
});

test("all durable financial case types use the shared blocker protocol", () => {
  for (const file of [
    "src/services/admin-report.service.ts",
    "src/services/cancellation.service.ts",
    "src/services/completion-escalation.service.ts",
  ]) {
    assert.match(source(file), /assertNoOtherBlockingCases/);
  }
  for (const file of [
    "src/services/safety-report.service.ts",
    "src/services/cancellation.service.ts",
    "src/services/completion-escalation.service.ts",
    "src/services/bookings/completion.service.ts",
  ]) {
    assert.match(source(file), /assertNoFinancialResolutionReserved/);
  }
});

test("request cancellation uses the same request lock and a conditional transition", () => {
  const requests = source("src/services/requests.service.ts");
  assert.match(requests, /request:\$\{requestId\}/);
  assert.match(requests, /serviceRequest\.updateMany\(\{ where: \{ id: requestId, seekerId, status: "OPEN" \}/);
  assert.match(requests, /activePaymentAttempt/);
  assert.match(requests, /activeBooking/);
});

test("post-settlement recovery is explicitly distinguished from pre-settlement validation", () => {
  assert.match(source("src/services/admin-report.service.ts"), /hasEstablishedFinancialEffect/);
  assert.match(source("src/services/completion-escalation.service.ts"), /hasEstablishedFinancialEffect/);
  assert.match(source("src/services/admin-resolution-operation.service.ts"), /FINANCIAL_EFFECT_ESTABLISHED/);
});

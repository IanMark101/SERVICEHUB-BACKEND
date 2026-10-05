/** Read-only smoke check against the configured database. No case is opened or resolved. */
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { getModerationCase, listModerationCases, type CaseFilters } from "../src/services/admin-case-workspace.service";
async function main() {
  const base: CaseFilters = { page: 1, limit: 12, view: "active", sort: "attention" };
  const active = await listModerationCases(base);
  const history = await listModerationCases({ ...base, view: "history" });
  assert.equal(active.pagination.total, active.summary.active);
  assert.equal(history.pagination.total, history.summary.history);
  assert.ok(active.items.every(item => ["PENDING", "UNDER_REVIEW"].includes(item.status)));
  assert.ok(history.items.every(item => !["PENDING", "UNDER_REVIEW"].includes(item.status)));
  const concerns = ["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE", "SCAM_OR_FRAUD", "INAPPROPRIATE_BEHAVIOR", "OVERPRICING", "NO_SHOW"];
  for (const concern of concerns) {
    const response = await listModerationCases({ ...base, concern });
    assert.ok(response.items.every(item => item.concern === concern));
  }
  for (const payment of ["GCash", "On-site Cash"]) {
    const response = await listModerationCases({ ...base, payment, view: "all" });
    assert.ok(response.items.every(item => item.booking.paymentMethod === payment));
  }
  const first = active.items[0] || history.items[0];
  if (first) {
    const response = await listModerationCases({ ...base, view: "all", search: first.id });
    assert.ok(response.items.some(item => item.id === first.id));
    const detail = await getModerationCase(first.source, first.id);
    assert.equal(detail.booking.id, first.booking.id);
    assert.ok(!JSON.stringify(detail).includes('evidenceStorageKey'));
    const unrelated = await listModerationCases({ ...base, userId: "nonexistent-test-user" });
    assert.equal(unrelated.pagination.total, 0);
  }
  const firstPage = await listModerationCases({ ...base, view: "all", limit: 1 });
  if (firstPage.pagination.total > 1) {
    const next = await listModerationCases({ ...base, view: "all", limit: 1, page: 2 });
    assert.notEqual(`${firstPage.items[0].source}:${firstPage.items[0].id}`, `${next.items[0].source}:${next.items[0].id}`);
  }
  console.log(JSON.stringify({ passed: true, activeCases: active.pagination.total, historyCases: history.pagination.total, checks: "active/history totals, all concern filters, payment filters, exact search, detail sanitization, user scope, stable combined pagination" }));
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error.message); process.exitCode = 1; });

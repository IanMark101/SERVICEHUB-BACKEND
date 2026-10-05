import { prisma } from "../src/lib/prisma";
import { getDeletionEligibilityInTransaction, purgePreviouslyDeletedAccount } from "../src/services/account-deletion.service";
import { lockAccountLifecycle } from "../src/services/account-lifecycle.service";
import { Prisma } from "@prisma/client";
import { env } from "../src/config/env";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const verify = args.includes("--verify");
  const userId = args.find(value => value.startsWith("--user-id="))?.slice("--user-id=".length);
  if (args.some(value => !["--apply", "--dry-run", "--verify"].includes(value) && !value.startsWith("--user-id="))) throw new Error("Use --dry-run, --verify --user-id=<exact-id>, or --apply --user-id=<exact-id>.");
  if (verify) {
    if (!userId || apply) throw new Error("Verification requires one exact user ID and cannot be combined with apply.");
    const schema = new URL(env.DATABASE_URL).searchParams.get("schema") || "public";
    const identifier = (value: string) => Prisma.raw(`"${value.replaceAll('"', '""')}"`);
    const queries = Prisma.dmmf.datamodel.models.map(model => {
      const table = model.dbName || model.name;
      return Prisma.sql`SELECT ${table}::text AS table_name, count(*)::int AS count FROM ${identifier(schema)}.${identifier(table)} data WHERE strpos(row_to_json(data)::text, ${userId}) > 0`;
    });
    const rows = await prisma.$queryRaw<Array<{ table_name: string; count: number }>>(Prisma.join(queries, " UNION ALL "));
    const remaining = rows.filter(row => row.count > 0);
    console.log(JSON.stringify({ userId, verifiedAbsent: remaining.length === 0, checkedTables: rows.length, remaining }));
    if (remaining.length) process.exitCode = 1;
    return;
  }
  if (apply && !userId) throw new Error("Applying requires one exact --user-id. Bulk deletion is not supported.");
  if (apply) {
    const result = await purgePreviouslyDeletedAccount(userId!);
    console.log(JSON.stringify({ userId, ...result }));
    if (!result.deleted) process.exitCode = 1;
    return;
  }
  const candidates = await prisma.user.findMany({
    where: { ...(userId ? { id: userId } : {}), role: "user", isActive: false, deactivatedAt: { not: null }, name: "Deleted account", email: { endsWith: "@deleted.servicehub.invalid" } },
    select: { id: true, email: true },
  });
  for (const user of candidates) {
    if (user.email !== `${user.id}@deleted.servicehub.invalid`) continue;
    const eligibility = await prisma.$transaction(async tx => { await lockAccountLifecycle(tx, user.id); return getDeletionEligibilityInTransaction(tx, user.id); }, { timeout: 15_000 });
    console.log(JSON.stringify({ userId: user.id, eligible: eligibility.eligible, blockers: eligibility.blockers, dryRun: true }));
  }
  console.log(`Checked ${candidates.length} previous-deletion candidate(s). No data changed.`);
}

main().catch(() => { console.error("Deleted-account cleanup failed. Check database connectivity and the exact target; no credentials are logged."); process.exitCode = 1; }).finally(() => prisma.$disconnect());

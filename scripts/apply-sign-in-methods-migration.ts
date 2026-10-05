import "dotenv/config";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import { Pool } from "pg";
import { enforceDatabaseTlsVerification } from "../src/config/database-url";

// Targeted, additive migration; never applies unrelated pending migrations.
const name = "20260930200000_explicit_sign_in_methods";
async function main() {
const sql = await readFile(`prisma/migrations/${name}/migration.sql`, "utf8");
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("Only --apply is supported; default is read only.");
const pool = new Pool({ connectionString: enforceDatabaseTlsVerification(process.env.DIRECT_URL || process.env.DATABASE_URL!) });
try {
  const client = await pool.connect();
  try {
    const { rows: columns } = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name IN ('passwordState', 'googleSubject')");
    const { rows: [counts] } = await client.query(`SELECT count(*)::int AS total, count(*) FILTER(WHERE role='admin' OR EXISTS(SELECT 1 FROM email_verification_tokens t WHERE t."userId"=u.id) OR EXISTS(SELECT 1 FROM password_reset_tokens t WHERE t."userId"=u.id AND t.used))::int AS confirmed FROM users u`);
    console.log(JSON.stringify({ mode: apply ? "apply" : "read-only", columnsPresent: columns.length, totalAccounts: counts.total, positivelyConfirmedPasswords: counts.confirmed, legacyUnclassified: counts.total - counts.confirmed }));
    if (apply) {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sign-in-methods-migration'))");
      const { rows } = await client.query('SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [name]);
      if (!rows.length) {
        if (columns.length) throw new Error("Partial migration detected; stop for inspection.");
        await client.query(sql);
        await client.query('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ($1,$2,NOW(),$3,NOW(),1)', [crypto.randomUUID(), crypto.createHash("sha256").update(sql).digest("hex"), name]);
      }
      await client.query("COMMIT");
      console.log("Sign-in methods migration applied and recorded.");
    }
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
} catch { console.error("Sign-in methods migration check failed. No connection credentials were printed."); process.exitCode = 1; }
finally { await pool.end(); }
}
void main();

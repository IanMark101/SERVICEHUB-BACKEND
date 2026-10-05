import "dotenv/config";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import { Pool } from "pg";
import { enforceDatabaseTlsVerification } from "../src/config/database-url";

const name = "20260930230000_unified_content_workspace";
async function main() {
  const sql = await readFile(`prisma/migrations/${name}/migration.sql`, "utf8");
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("Only --apply is supported; default is read only.");
  const pool = new Pool({ connectionString: enforceDatabaseTlsVerification(process.env.DIRECT_URL || process.env.DATABASE_URL!) });
  try {
    const client = await pool.connect();
    try {
      const { rows: [counts] } = await client.query(`SELECT count(*)::int AS total, count(*) FILTER(WHERE status='OPEN')::int AS pending FROM content_moderation_cases`);
      console.log(JSON.stringify({ mode: apply ? "apply" : "read-only", totalContentCases: counts.total, openContentCases: counts.pending }));
      if (apply) {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('unified-content-workspace-migration'))");
        const { rows } = await client.query('SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [name]);
        if (!rows.length) {
          await client.query(sql);
          await client.query('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ($1,$2,NOW(),$3,NOW(),1)', [crypto.randomUUID(), crypto.createHash("sha256").update(sql).digest("hex"), name]);
        }
        await client.query("COMMIT");
        console.log("Content workspace migration applied and recorded. No listing or booking records were deleted.");
      }
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  } catch { console.error("Content workspace migration failed. No connection credentials were printed."); process.exitCode = 1; }
  finally { await pool.end(); }
}
void main();

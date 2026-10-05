import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { enforceDatabaseTlsVerification } from '../src/config/database-url';

const name = '20261004160000_public_request_visibility';
const constraint = 'service_requests_target_provider_requires_listing_check';

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; default is read only.');
  const apply = process.argv.includes('--apply');
  const sql = await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8');
  const connectionString = enforceDatabaseTlsVerification(process.env.DIRECT_URL || process.env.DATABASE_URL);
  if (!connectionString) throw new Error('Database configuration unavailable.');
  const schema = new URL(connectionString).searchParams.get('schema') || 'public';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Unexpected database schema.');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 15000 });
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT set_config('search_path', $1, false)", [`"${schema}"`]);
      const inspect = async () => {
        const { rows } = await client.query(`SELECT
          COUNT(*) FILTER (WHERE "targetServiceId" IS NULL) AS "publicRequests",
          COUNT(*) FILTER (WHERE "targetServiceId" IS NULL AND "targetProviderId" IS NOT NULL) AS "obsoleteProviderRestrictions",
          COUNT(*) FILTER (WHERE "targetServiceId" IS NOT NULL) AS "listingInquiries"
          FROM "service_requests"`);
        return rows[0];
      };
      const before = await inspect();
      const applied = await client.query('SELECT checksum FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [name]);
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'read-only', schema, migration: name, alreadyApplied: !!applied.rows.length, before }));
      if (apply) {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('public-request-visibility-migration'))");
        const locked = await client.query('SELECT checksum FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [name]);
        if (locked.rows.length) {
          if (locked.rows[0].checksum !== checksum) throw new Error('Applied migration checksum differs.');
        } else {
          await client.query(sql);
          await client.query('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ($1,$2,NOW(),$3,NOW(),1)', [randomUUID(), checksum, name]);
        }
        const after = await inspect();
        const check = await client.query('SELECT convalidated FROM pg_constraint WHERE conrelid=\'service_requests\'::regclass AND conname=$1', [constraint]);
        if (after.obsoleteProviderRestrictions !== '0' || !check.rows[0]?.convalidated) throw new Error('Visibility repair verification failed.');
        await client.query('COMMIT');
        console.log(JSON.stringify({ after, databaseGuardValidated: true, migrationRecorded: true }));
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch (error) {
    console.error('Request visibility migration failed. No credentials were printed.', (error as { code?: string }).code || 'CONNECTION_OR_MIGRATION_ERROR');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
void main();

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { enforceDatabaseTlsVerification } from '../src/config/database-url';

const name = '20261001100000_request_payment_methods';
async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; default is read only.');
  const apply = process.argv.includes('--apply');
  const sql = await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8');
  const pool = new Pool({ connectionString: enforceDatabaseTlsVerification(process.env.DIRECT_URL || process.env.DATABASE_URL!), connectionTimeoutMillis: 15000 });
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query('SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [name]);
      console.log(JSON.stringify({ mode: apply ? 'apply' : 'read-only', migration: name, alreadyApplied: !!rows.length }));
      if (apply && !rows.length) {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('request-payment-methods-migration'))");
        const { rows: lockedRows } = await client.query('SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [name]);
        if (!lockedRows.length) {
          await client.query(sql);
          await client.query('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ($1,$2,NOW(),$3,NOW(),1)', [crypto.randomUUID(), crypto.createHash('sha256').update(sql).digest('hex'), name]);
        }
        await client.query('COMMIT');
        console.log('Request payment methods migration applied and recorded. Existing requests retain their original payment behavior.');
      }
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  } catch (error) {
    console.error('Request payment methods migration failed. No credentials were printed.', (error as { code?: string }).code || 'CONNECTION_OR_MIGRATION_ERROR');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
void main();

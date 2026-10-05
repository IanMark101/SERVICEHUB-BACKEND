import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { Client } from 'pg';
import { enforceDatabaseTlsVerification } from '../src/config/database-url';

// Verification only. Every migration/fixture is confined to a fresh schema.
async function main() {
  const base = enforceDatabaseTlsVerification(process.env.DIRECT_URL || process.env.DATABASE_URL);
  if (!base) throw new Error('Database configuration unavailable');
  const schema = `audit_20260924_${randomUUID().replaceAll('-', '')}`;
  if (!/^audit_20260924_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema name');
  const client = new Client({ connectionString: base, connectionTimeoutMillis: 15000 });
  await client.connect();
  if (process.argv[2] === '--cleanup-schema') {
    const name = process.argv[3] || '';
    if (!/^audit_20260924_[a-f0-9]{32}$/.test(name)) throw new Error('Only an exact generated audit schema may be removed');
    const users = await client.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE email LIKE '%@example.test' OR email LIKE '%@independent.example.test') AS test_emails FROM "${name}"."users"`);
    const sessions = await client.query(`SELECT COUNT(*) AS total FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE $1`, [`%${name}%`]);
    if (users.rows[0].total !== users.rows[0].test_emails || sessions.rows[0].total !== '0') throw new Error('Schema has non-test accounts or active references; cleanup refused');
    await client.query(`DROP SCHEMA "${name}" CASCADE`);
    console.log({ removedInterruptedAuditSchema: name, sharedApplicationSchemaUntouched: true });
    await client.end();
    return;
  }
  if (process.argv.includes('--inspect-release')) {
    const targetSchema = new URL(base).searchParams.get('schema') || 'public';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(targetSchema)) throw new Error('Unexpected application schema');
    const migrations = await client.query(`SELECT migration_name, finished_at, rolled_back_at
      FROM "${targetSchema}"."_prisma_migrations"
      WHERE migration_name IN ('20260925120000_pending_submission_integrity', '20260925130000_manual_trust_retry_identity')`);
    const indexes = await client.query(`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = $1 AND indexname IN ('service_verifications_one_pending_user_key', 'offers_one_active_provider_request_key')`, [targetSchema]);
    const column = await client.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'trust_score_events' AND column_name = 'requestedDelta'`, [targetSchema]);
    console.log({ targetSchema, migrations: migrations.rows, indexes: indexes.rows, requestedDelta: column.rows });
    await client.end();
    return;
  }
  if (process.argv.includes('--inspect')) {
    const schemas = await client.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^audit_20260924_[a-f0-9]{32}$'");
    console.log({ remainingAuditSchemas: schemas.rows.map(row => row.nspname) });
    for (const row of schemas.rows) {
      const name = String(row.nspname);
      if (!/^audit_20260924_[a-f0-9]{32}$/.test(name)) throw new Error('Unexpected audit schema');
      const migrations = await client.query(`SELECT MIN(started_at) AS started, MAX(finished_at) AS migrated FROM "${name}"."_prisma_migrations"`);
      const users = await client.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE email LIKE '%@example.test' OR email LIKE '%@independent.example.test') AS test_emails FROM "${name}"."users"`);
      const sessions = await client.query(`SELECT COUNT(*) AS referencing_sessions FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE $1`, [`%${name}%`]);
      console.log({ schema: name, migrations: migrations.rows, users: users.rows, sessions: sessions.rows });
    }
    await client.end();
    return;
  }
  if (process.argv.includes('--inspect-conflicts')) {
    const result = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM (
          SELECT "userId" FROM "service_verifications"
          WHERE "status" = 'PENDING_REVIEW'
          GROUP BY "userId" HAVING COUNT(*) > 1
        ) conflicts) AS "pendingVerificationGroups",
        (SELECT COUNT(*) FROM (
          SELECT "requestId", "providerId" FROM "offers"
          WHERE "status" IN ('PENDING', 'PENDING_PAYMENT', 'ACCEPTED')
          GROUP BY "requestId", "providerId" HAVING COUNT(*) > 1
        ) conflicts) AS "activeOfferGroups"
    `);
    console.log({ migrationConflicts: result.rows[0] });
    await client.end();
    return;
  }
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // Prisma limits migration search_path to the target schema. Expose only
    // pgcrypto's digest overload there; do not alter the shared extension.
    const extension = await client.query("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto'");
    if (extension.rows[0]) {
      const namespace = String(extension.rows[0].nspname);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(namespace)) throw new Error('Unexpected extension namespace');
      await client.query(`CREATE FUNCTION "${schema}".digest(text,text) RETURNS bytea LANGUAGE SQL IMMUTABLE STRICT AS 'SELECT "${namespace}".digest($1,$2)'`);
    }
    const url = new URL(base);
    url.searchParams.set('schema', schema);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const env = { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: url.toString(), NODE_ENV: 'test',
      PAYMONGO_SECRET_KEY: 'sk_test_independent_audit_no_external_calls',
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', PRISMA_LOG_QUERIES: 'false' };
    const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, encoding: 'utf8', timeout: 180000 });
    if (migration.status !== 0) {
      console.error((migration.stderr || migration.stdout).replaceAll(base, '[database]').replaceAll(url.toString(), '[isolated database]'));
      throw new Error('Isolated migration failed');
    }
    console.log('Fresh isolated audit schema migrated successfully.');
    const tests = process.argv.slice(2);
    if (!tests.length || tests.some(file => !/^src\/integration\/[a-z0-9-]+\.test\.ts$/.test(file))) throw new Error('Specify integration test files');
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests], { env, encoding: 'utf8', timeout: 600000, maxBuffer: 10000000 });
    mkdirSync('.audit-results', { recursive: true });
    const log = `.audit-results/${schema}.log`;
    appendFileSync(log, `${tests.join('\n')}\n${run.stdout || ''}\n${run.stderr || ''}\nExit: ${run.status}\n`);
    console.log(run.stdout || '');
    console.error(run.stderr || '');
    console.log(`Verification log: ${log}`);
    process.exitCode = run.status ?? 1;
  } finally {
    if (created) {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.log('Isolated audit schema removed; shared application schema untouched.');
    }
    await client.end();
  }
}
main().catch(error => { console.error({ name: error.name, code: error.code, message: error.message, causes: error.errors?.map((item: { code?: string }) => item.code) }); process.exitCode = 1; });

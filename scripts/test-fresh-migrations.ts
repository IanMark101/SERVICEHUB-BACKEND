import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

const schemaName = `servicehub_migration_test_${randomUUID().replaceAll('-', '')}`;
assert.match(schemaName, /^servicehub_migration_test_[a-f0-9]{32}$/);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const isolatedUrl = new URL(databaseUrl);
isolatedUrl.searchParams.set('schema', schemaName);
// Prisma migrations depend on a stable PostgreSQL session/search_path. Neon
// transaction pooling can move sequential migration statements between
// sessions, so the disposable harness uses the matching direct endpoint.
isolatedUrl.hostname = isolatedUrl.hostname.replace('-pooler.', '.');
const isolatedDirectUrl = new URL(process.env.DIRECT_URL || databaseUrl);
isolatedDirectUrl.searchParams.set('schema', schemaName);
isolatedDirectUrl.hostname = isolatedDirectUrl.hostname.replace('-pooler.', '.');
const admin = new Client({ connectionString: databaseUrl });
// Long integration suites may outlive an idle pooled connection. Keep cleanup
// independent of this inspection client so the disposable schema is removed.
admin.on('error', () => console.error('Migration inspection connection closed; cleanup will reconnect.'));

function runNpm(args: string[], env: NodeJS.ProcessEnv) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable');
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result;
}

async function main() {
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schemaName}"`);

  try {
    // Prisma isolates a `schema=` test URL from `public`, while pgcrypto is an
    // extension installed in `public`. A truly fresh CI database naturally
    // resolves `digest`; expose the same function inside this disposable
    // schema so the local schema-based rehearsal has equivalent behavior.
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(`
      CREATE FUNCTION "${schemaName}".digest(value text, algorithm text)
      RETURNS bytea
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
      AS 'SELECT public.digest(value, algorithm)'
    `);

    const isolatedEnv = {
      ...process.env,
      DATABASE_URL: isolatedUrl.toString(),
      DIRECT_URL: isolatedDirectUrl.toString(),
      NODE_ENV: 'test',
      PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
    };
    // The Prisma CLI prefers DIRECT_URL. Confirm its resolved datasource before
    // any migration write; a forgotten override must never touch public.
    const target = runNpm(['exec', '--', 'prisma', 'migrate', 'status'], isolatedEnv);
    assert.match(`${target.stdout}\n${target.stderr}`, new RegExp(`schema "${schemaName}"`),
      'Prisma CLI did not target the disposable schema');
    const migration = runNpm(['exec', '--', 'prisma', 'migrate', 'deploy'], isolatedEnv);
    assert.equal(migration.status, 0, 'fresh migration deployment failed');

    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schemaName],
    );
    const tableNames = new Set(tables.rows.map((row) => row.table_name));
    for (const expected of ['users', 'bookings', 'payment_attempts', '_prisma_migrations']) {
      assert.equal(tableNames.has(expected), true, `fresh schema is missing ${expected}`);
    }
    console.log(`Fresh migration verification passed with ${tableNames.size} tables.`);

    const drift = runNpm([
      'exec', '--', 'prisma', 'migrate', 'diff',
      '--from-config-datasource',
      '--to-schema', 'prisma/schema.prisma',
      '--exit-code',
    ], isolatedEnv);
    assert.equal(drift.status, 0, 'fresh migration history does not match the Prisma schema');

    if (process.env.SERVICEHUB_REQUEST_PAYMENT_ONLY === '1') {
      for (const file of ['post-request-flow.test.ts', 'request-payment-selection.test.ts']) {
        const result = runNpm(['exec', '--', 'tsx', '--test', `src/integration/${file}`], isolatedEnv);
        assert.equal(result.status, 0, `fresh-schema ${file} failed`);
      }
      return;
    }

    if (process.env.SERVICEHUB_CONTENT_ONLY === '1') {
      for (const file of ['content-workspace.test.ts', 'automated-content-moderation.test.ts', 'self-service-deletion.test.ts']) {
        const result = runNpm(['exec', '--', 'tsx', '--test', `src/integration/${file}`], isolatedEnv);
        assert.equal(result.status, 0, `fresh-schema ${file} failed`);
      }
      return;
    }

    const workloadOnly = process.env.SERVICEHUB_WORKLOAD_ONLY === '1';
    const paymentOnly = process.env.SERVICEHUB_PAYMENT_ONLY === '1';
    const queueOnly = process.env.SERVICEHUB_QUEUE_ONLY === '1';
    if (!workloadOnly && !paymentOnly && !queueOnly) {
      const moderation = runNpm(['exec', '--', 'tsx', '--test', 'src/integration/automated-content-moderation.test.ts'], isolatedEnv);
      assert.equal(moderation.status, 0, 'fresh-schema automated moderation integration failed');

      const listingRegression = runNpm(['exec', '--', 'tsx', '--test', 'src/integration/listing-correctness.test.ts'], isolatedEnv);
      assert.equal(listingRegression.status, 0, 'fresh-schema listing regression failed');

      const requestRegression = runNpm(['exec', '--', 'tsx', '--test', 'src/integration/post-request-flow.test.ts'], isolatedEnv);
      assert.equal(requestRegression.status, 0, 'fresh-schema request posting regression failed');

    }

    if (!workloadOnly && !paymentOnly && !queueOnly && process.env.SERVICEHUB_MODERATION_ONLY !== '1') {
      const highPriorityFlow = runNpm(['run', 'test:high-priority-integration'], isolatedEnv);
      assert.equal(highPriorityFlow.status, 0, 'fresh-schema H1-H5 integration failed');

      const paymentReturn = runNpm(['exec', '--', 'tsx', '--test', 'src/integration/payment-return-reconciliation.test.ts'], isolatedEnv);
      assert.equal(paymentReturn.status, 0, 'fresh-schema GCash return reconciliation failed');

    }
    if (workloadOnly || paymentOnly || (!queueOnly && process.env.SERVICEHUB_MODERATION_ONLY !== '1' && process.env.SERVICEHUB_ONLY_HIGH !== '1')) {
      const paymentFailure = runNpm(['exec', '--', 'tsx', '--test', 'src/integration/payment-failure-return.test.ts'], isolatedEnv);
      assert.equal(paymentFailure.status, 0, 'fresh-schema GCash failure and retry integration failed');
    }
    if (workloadOnly || (!paymentOnly && !queueOnly && process.env.SERVICEHUB_MODERATION_ONLY !== '1' && process.env.SERVICEHUB_ONLY_HIGH !== '1')) {
      const providerWorkload = runNpm(['run', 'test:provider-workload'], isolatedEnv);
      assert.equal(providerWorkload.status, 0, 'fresh-schema provider-wide workload integration failed');
      const bookingFlow = runNpm(['run', 'test:booking-integration'], isolatedEnv);
      assert.equal(bookingFlow.status, 0, 'fresh-schema booking integration failed');
    }
    if (workloadOnly || queueOnly || (!paymentOnly && process.env.SERVICEHUB_MODERATION_ONLY !== '1' && process.env.SERVICEHUB_ONLY_HIGH !== '1')) {
      const queueConcurrency = runNpm(['run', 'test:phase2-integration'], isolatedEnv);
      assert.equal(queueConcurrency.status, 0, 'fresh-schema queue concurrency integration failed');
    }
  } finally {
    assert.match(schemaName, /^servicehub_migration_test_[a-f0-9]{32}$/);
    const cleanup = new Client({ connectionString: process.env.DIRECT_URL || databaseUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schemaName}" CASCADE`); }
    finally { await cleanup.end(); }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => admin.end().catch(() => undefined));

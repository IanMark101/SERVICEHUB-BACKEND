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
const admin = new Client({ connectionString: databaseUrl });

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
      NODE_ENV: 'test',
    };
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

    const bookingFlow = runNpm(['run', 'test:booking-integration'], isolatedEnv);
    assert.equal(bookingFlow.status, 0, 'fresh-schema booking integration failed');
  } finally {
    assert.match(schemaName, /^servicehub_migration_test_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => admin.end());

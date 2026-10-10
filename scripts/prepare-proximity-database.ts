import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { assertProximityDatabase } from './proximity-db-target';

const migration = '20261009090000_proximity_marketplace';

async function main() {
  assertProximityDatabase();
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  try {
    const applied = await client.query<{ migration_name: string }>('SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
    const appliedNames = new Set(applied.rows.map(row => row.migration_name));
    const pending = fs.readdirSync('prisma/migrations').filter(name => fs.statSync(path.join('prisma/migrations', name)).isDirectory() && !appliedNames.has(name));
    if (pending.some(name => name !== migration)) throw new Error('Unexpected pending migrations. Refusing changes until the branch baseline is understood.');
    if (!pending.length) { console.log('Proximity migration is already applied to the recorded development endpoint.'); return; }

    // A private, consistent data snapshot complements the isolated Neon parent.
    // Never print rows, credentials, tokens, or the database hostname.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    const data: Record<string, unknown[]> = {};
    for (const { tablename } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected table identifier');
      data[tablename] = (await client.query(`SELECT * FROM public."${tablename}"`)).rows;
    }
    await client.query('COMMIT');
    const directory = path.resolve('.database-backups', `proximity-before-${Date.now()}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'data.json.gz'), gzipSync(JSON.stringify({ createdAt: new Date().toISOString(), branch: 'proximity-development', data })));
    fs.writeFileSync(path.join(directory, 'schema.prisma'), execFileSync('git', ['show', 'HEAD:prisma/schema.prisma']));
    fs.writeFileSync(path.join(directory, 'migrations.json'), JSON.stringify(applied.rows.map(row => ({ name: row.migration_name, sql: fs.readFileSync(path.join('prisma/migrations', row.migration_name, 'migration.sql'), 'utf8') }))));
    fs.writeFileSync(path.join(directory, 'README.txt'), 'Private pre-migration data snapshot from proximity-development. Contains account and session data: keep local and never commit or upload. This is a JSON data export, not a pg_dump archive. Restore into an isolated recovery database using the saved baseline migrations, then import typed records; do not automatically overwrite production. The untouched Neon parent remains the primary rollback source.\n');
    console.log(`Private pre-migration snapshot saved (${tables.rowCount} tables).`);
    assertProximityDatabase();
    const result = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Proximity migration deployment failed');
  } finally {
    await client.end();
  }
}
main().catch(error => {
  let message = error instanceof Error ? error.message : 'Unknown failure';
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = process.env[name];
    if (!raw) continue;
    const url = new URL(raw);
    for (const value of [raw, url.hostname, url.username, url.password]) if (value) message = message.split(value).join('[private]');
  }
  console.error('Guarded development database preparation failed:', message);
  process.exitCode = 1;
});

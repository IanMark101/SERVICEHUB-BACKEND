import { Client } from 'pg';
import { assertCategoryDevelopmentTarget } from './category-development-target';
import { enforceDatabaseTlsVerification } from '../src/config/database-url';

async function main() {
  assertCategoryDevelopmentTarget();
  const client = new Client({ connectionString: enforceDatabaseTlsVerification(process.env.DIRECT_URL) });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const categories = await client.query(`SELECT c.id, c.name, c."isActive",
      (SELECT count(*)::int FROM services s WHERE s."categoryId" = c.id) AS listings,
      (SELECT count(*)::int FROM service_requests r WHERE r."categoryId" = c.id) AS requests
      FROM categories c ORDER BY c.name`);
    const migrations = await client.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 3');
    console.log(JSON.stringify({ target: 'verified development database', categories: categories.rows, latestMigrations: migrations.rows }, null, 2));
    await client.query('ROLLBACK');
  } finally { await client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message || 'Database connection unavailable' : 'Category audit failed'); process.exitCode = 1; });

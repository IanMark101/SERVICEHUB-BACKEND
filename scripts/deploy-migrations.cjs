const { spawnSync } = require('node:child_process');

function connectionTarget(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error('A PostgreSQL database connection is required.');
  }
  // Neon uses separate direct/pooler hostnames for the same endpoint. Only
  // normalize that documented suffix, not arbitrary differing database hosts.
  const host = url.hostname.endsWith('.neon.tech') ? url.hostname.replace('-pooler.', '.') : url.hostname;
  return `${host}:${url.port || '5432'}${url.pathname}?schema=${url.searchParams.get('schema') || 'public'}`;
}

function validateMigrationTarget(environment) {
  if (!environment.DIRECT_URL || !environment.DATABASE_URL) {
    throw new Error('Set both DIRECT_URL (approved direct migration connection) and DATABASE_URL in the backend deployment environment.');
  }
  if (connectionTarget(environment.DIRECT_URL) !== connectionTarget(environment.DATABASE_URL)) {
    throw new Error('DIRECT_URL and DATABASE_URL must refer to the same database endpoint and database.');
  }
  if (new URL(environment.DIRECT_URL).hostname.includes('-pooler.')) {
    throw new Error('DIRECT_URL must use the direct database connection, not the transaction pooler.');
  }
}

function deployMigrations() {
  try { validateMigrationTarget(process.env); }
  catch (error) { console.error(`[Migrations] ${error.message}`); return 1; }
  console.log('[Migrations] Applying checked-in migrations before replacing the API container.');
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    stdio: 'inherit', env: process.env,
  });
  if (result.error) console.error('[Migrations] Could not start the installed Prisma CLI.');
  return result.status ?? 1;
}

module.exports = { validateMigrationTarget };
if (require.main === module) process.exitCode = deployMigrations();

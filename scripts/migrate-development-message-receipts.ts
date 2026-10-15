import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertCategoryDevelopmentTarget } from './category-development-target';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';

async function main() {
  assertCategoryDevelopmentTarget();
  assert.equal(env.NODE_ENV, 'development', 'Message receipt migration only targets development');
  const completed = await prisma.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const files = (await fs.readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const pending = files.filter(name => !completed.some(row => row.migration_name === name));
  if (!pending.length) { console.log('Message read receipts migration is already applied.'); return; }
  assert.deepEqual(pending, ['20261015010000_message_read_receipts'], 'Refusing to deploy unrelated pending migrations');
  const result = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { encoding: 'utf8', env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, 'Message receipt migration deployment failed');
  console.log('Nullable read timestamp added to the verified development database. Historical seen times are not fabricated.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Message receipt migration failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
